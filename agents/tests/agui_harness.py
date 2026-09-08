"""AG-UI + async harness for the supervisor's streaming and A2A paths.

``agent_harness`` is enough to import a *tool-shaped* agent: it neuters boto3
and stubs Strands so the ``@tool`` callables can be exercised. The supervisor
needs three more things that harness never had to provide:

1.  **The AG-UI protocol types** (``ag_ui.core``). The supervisor builds a
    ``RunAgentInput`` out of the middleware's payload on every streamed turn,
    and two separate live incidents were caused by getting that construction
    wrong (a ``Message`` without an ``id``; ``RunAgentInput`` without
    ``state``/``tools``/``context``/``forwarded_props``) after the 2026-08
    base-image rebuild pulled ag-ui-protocol >= 0.1.x. So the stand-ins here
    are **real pydantic models with the real required fields**, not permissive
    bags. If the supervisor stops passing one, the model raises exactly like
    the deployed SDK does and the test fails.

2.  **A scriptable AG-UI adapter** (``ag_ui_strands.StrandsAgent``). The real
    adapter drives Strands, which drives Bedrock. Here it replays a script the
    test supplies: a list of AG-UI events, and/or zero-argument callables that
    run *inside* the stream (used to invoke a supervisor tool mid-run, which is
    how the parent-invocation-id threading gets exercised for real rather than
    by poking a ContextVar by hand).

3.  **An async driver.** ``pytest-asyncio`` is not installed and never will be
    on this box; ``run_async`` plus ``SupervisorTestCase.invoke`` are a few
    lines of ``asyncio.run`` that do the same job under stdlib ``unittest``.
    One ``asyncio.run`` means one Task, so one context — which is what the
    deployed runtime gives the generator too.

What is stubbed to identity, and what that leaves unproven
----------------------------------------------------------
*   ``strands.tool`` is the identity function (inherited from
    ``agent_harness``). We test the raw callables and the ``instrumented_tool``
    wrapper — the repo's code — not Strands' JSON-schema generation.
*   ``ag_ui_strands.StrandsAgent`` is replaced wholesale. **Unproven:** that
    the real adapter emits the AG-UI event sequence the portal expects for a
    given Strands run, and that it propagates the supervisor's ContextVar into
    whatever executor Strands runs tools on. What *is* proven is everything the
    supervisor itself decides: the RunAgentInput it builds, the context it
    establishes around the stream, which events it forwards, what it
    accumulates into the persisted response, and how it terminates a failed
    stream.
*   ``BedrockModel`` records kwargs and does nothing. Guardrail *attachment* is
    asserted on those kwargs; guardrail *enforcement* is Bedrock's job.
*   Nothing here opens a socket. ``no_network()`` patches
    ``urllib.request.urlopen`` to raise, so a test that accidentally reaches
    ``post_trace``'s real HTTP path fails loudly instead of hanging on a DNS
    lookup for ``middleware``.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from contextlib import contextmanager
from enum import Enum
from typing import Any, Callable, Iterable
from unittest import mock

from pydantic import BaseModel, ConfigDict

import agent_harness


# ── ag_ui.core stand-ins ──────────────────────────────────────────────────────


class EventType(str, Enum):
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"


class _Strict(BaseModel):
    """Required-fields-are-required, like the shipped pydantic models."""

    model_config = ConfigDict(extra="allow")


class BaseEvent(_Strict):
    type: EventType


class RunStartedEvent(BaseEvent):
    type: EventType = EventType.RUN_STARTED
    thread_id: str
    run_id: str


class RunFinishedEvent(BaseEvent):
    type: EventType = EventType.RUN_FINISHED


class RunErrorEvent(BaseEvent):
    type: EventType = EventType.RUN_ERROR
    message: str
    code: str | None = None


class TextMessageStartEvent(BaseEvent):
    type: EventType = EventType.TEXT_MESSAGE_START
    message_id: str
    role: str = "assistant"


class TextMessageContentEvent(BaseEvent):
    type: EventType = EventType.TEXT_MESSAGE_CONTENT
    message_id: str
    delta: str


class TextMessageEndEvent(BaseEvent):
    type: EventType = EventType.TEXT_MESSAGE_END
    message_id: str


class ToolCallStartEvent(BaseEvent):
    type: EventType = EventType.TOOL_CALL_START
    tool_call_id: str
    tool_call_name: str


class ToolCallArgsEvent(BaseEvent):
    type: EventType = EventType.TOOL_CALL_ARGS
    tool_call_id: str
    delta: str


class ToolCallEndEvent(BaseEvent):
    type: EventType = EventType.TOOL_CALL_END
    tool_call_id: str


class ToolCallResultEvent(BaseEvent):
    type: EventType = EventType.TOOL_CALL_RESULT
    tool_call_id: str
    message_id: str
    content: str


class Message(_Strict):
    # `id` is REQUIRED — omitting it is the pydantic ValidationError that killed
    # invocations live after the 2026-08 SDK bump. Keep it required here.
    id: str
    role: str
    content: str | None = None


class UserMessage(Message):
    role: str = "user"


class AssistantMessage(Message):
    role: str = "assistant"


class RunAgentInput(_Strict):
    thread_id: str
    run_id: str
    messages: list[Message]
    # All four are REQUIRED on ag-ui-protocol >= 0.1.x. `None`/`[]` are valid
    # values; *absence* is not. Modelled that way on purpose.
    state: Any
    tools: list
    context: list
    forwarded_props: Any


# ── ag_ui_strands stand-in ────────────────────────────────────────────────────


class StrandsAgentConfig:
    def __init__(self, **kwargs):
        self.kwargs = dict(kwargs)
        for k, v in kwargs.items():
            setattr(self, k, v)


#: Every adapter the supervisor has built, newest last. Tests reach in here to
#: script a run, and to assert on how many adapters exist (cache identity).
BUILT_AG_UI: list["StrandsAgent"] = []


class StrandsAgent:
    """Scriptable stand-in for the ag-ui-strands adapter.

    ``script`` is a list of AG-UI events and/or zero-arg callables. A callable
    is invoked in-stream (so it runs inside the supervisor's TraceContext) and
    its return value, if not None, is yielded as an event. Raising from one
    models a mid-stream failure.
    """

    #: Default script used when a test doesn't set one.
    DEFAULT_SCRIPT: Callable[[], list] = staticmethod(
        lambda: [
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
    )

    def __init__(self, agent=None, name=None, config=None):
        self.agent = agent
        self.name = name
        self.config = config
        self.script: list | None = None
        self.runs: list[RunAgentInput] = []
        BUILT_AG_UI.append(self)

    async def run(self, run_input) -> Any:
        self.runs.append(run_input)
        script = self.script if self.script is not None else self.DEFAULT_SCRIPT()
        for step in script:
            if callable(step) and not isinstance(step, BaseModel):
                produced = step()
                if produced is not None:
                    yield produced
                continue
            yield step

    # `run` is an async generator function; the attribute above is fine because
    # `async def` + `yield` makes calling it return an async iterator.


def install_ag_ui_stubs() -> None:
    if "ag_ui.core" in sys.modules:
        return
    pkg = types.ModuleType("ag_ui")
    core = types.ModuleType("ag_ui.core")
    for name in (
        "EventType", "BaseEvent",
        "RunStartedEvent", "RunFinishedEvent", "RunErrorEvent",
        "TextMessageStartEvent", "TextMessageContentEvent", "TextMessageEndEvent",
        "ToolCallStartEvent", "ToolCallArgsEvent", "ToolCallEndEvent",
        "ToolCallResultEvent",
        "Message", "UserMessage", "AssistantMessage", "RunAgentInput",
    ):
        setattr(core, name, globals()[name])
    pkg.core = core
    sys.modules["ag_ui"] = pkg
    sys.modules["ag_ui.core"] = core

    adapter = types.ModuleType("ag_ui_strands")
    adapter.StrandsAgent = StrandsAgent
    adapter.StrandsAgentConfig = StrandsAgentConfig
    sys.modules["ag_ui_strands"] = adapter


def load_supervisor(*, env: dict | None = None):
    """Import ``agents/supervisor/main.py`` with every SDK stubbed."""
    install_ag_ui_stubs()
    agent_harness.install_sdk_stubs()
    return agent_harness.load_agent("supervisor", env=env or {})


# ── async driving ─────────────────────────────────────────────────────────────


def run_async(coro):
    return asyncio.run(coro)


# ── AWS fakes ─────────────────────────────────────────────────────────────────


class FakeAgentCoreRuntime:
    """Records ``invoke_agent_runtime`` calls. Never speaks to AgentCore."""

    def __init__(self, response_text: str = "sub-agent said hi", raises=None):
        self.calls: list[dict] = []
        self.response_text = response_text
        self.raises = raises

    def invoke_agent_runtime(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        import json

        return {"response": json.dumps({"response": self.response_text}).encode()}

    @property
    def last_payload(self) -> dict:
        import json

        return json.loads(self.calls[-1]["payload"])


class FakeAgentCoreControl:
    def __init__(self, runtimes: Iterable[str] = ()):
        self.runtimes = list(runtimes)
        self.list_calls = 0

    def list_agent_runtimes(self):
        self.list_calls += 1
        return {
            "agentRuntimes": [
                {"agentRuntimeName": n, "agentRuntimeArn": f"arn:aws:bedrock-agentcore:::runtime/{n}"}
                for n in self.runtimes
            ]
        }


def fake_bedrock_agent(*, prompts=None, detail=None, raises=None):
    """bedrock-agent stand-in for prompt_source (paginator + get_prompt)."""
    client = mock.Mock()

    class _Paginator:
        def paginate(self):
            return [{"promptSummaries": prompts or []}]

    client.get_paginator.return_value = _Paginator()
    if raises is not None:
        client.get_prompt.side_effect = raises
    else:
        client.get_prompt.return_value = detail or {}
    return client


def prompt_detail(text: str, version: str = "DRAFT") -> dict:
    return {
        "version": version,
        "defaultVariant": "default",
        "variants": [
            {"name": "default", "templateConfiguration": {"text": {"text": text}}}
        ],
    }


@contextmanager
def no_network():
    """Any real outbound HTTP inside the block is an immediate test failure."""

    def _boom(*a, **k):
        raise AssertionError("a test tried to open a network connection")

    # NB: not `socket.socket` — asyncio's event loop builds a self-pipe out of
    # `socket.socketpair()` on every `asyncio.run`, which is local and fine.
    # `getaddrinfo` / `create_connection` are what an actual outbound call needs.
    with mock.patch("urllib.request.urlopen", side_effect=_boom), \
            mock.patch("socket.getaddrinfo", side_effect=_boom), \
            mock.patch("socket.create_connection", side_effect=_boom):
        yield


# ── shared TestCase base ──────────────────────────────────────────────────────

#: Guardrails for all three seeded roles, so role→guardrail mapping is
#: observable rather than collapsing to the single-role fallback.
SUPERVISOR_ENV = {
    "GUARDRAIL_ID_MEMBER": "gr-member",
    "GUARDRAIL_ID_ORG_LEADER": "gr-leader",
    "GUARDRAIL_ID_HR_ADMIN": "gr-hradmin",
    "MODEL_ID": "amazon.nova-pro-v1:0",
    "MODEL_STREAM_RETRY_ATTEMPTS": "2",
}

_SUPERVISOR = None


def supervisor():
    """One imported supervisor module, shared by every test (import is
    expensive and mutates sys.modules; per-test state is reset instead)."""
    global _SUPERVISOR
    if _SUPERVISOR is None:
        _SUPERVISOR = load_supervisor(env=SUPERVISOR_ENV)
    return _SUPERVISOR


class SupervisorTestCase(unittest.TestCase):
    """Resets every piece of supervisor module state a test can dirty, and
    replaces ``post_trace`` with a recorder so no trace leaves the process."""

    def setUp(self):
        import logging

        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

        self.sup = supervisor()  # also puts agents/ on sys.path for `_shared`
        from _shared import prompt_source as ps

        self.sup._AGENTS_BY_KEY.clear()
        self.sup._AG_UI_AGENTS.clear()
        self.sup._PROMPT_SHA_BY_KEY.clear()
        self.sup._runtime_arn_cache.clear()
        BUILT_AG_UI.clear()

        ps.reset_cache()
        self._prompt_disabled = ps.DISABLED
        ps.DISABLED = True  # baked literal by default; prompt tests flip it back
        self.ps = ps

        #: Every bundle the supervisor tried to persist, in order.
        self.traces: list[dict] = []
        patcher = mock.patch.object(
            self.sup, "post_trace", side_effect=lambda b, **k: self.traces.append(b) or True
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: setattr(ps, "DISABLED", self._prompt_disabled))

    # ── conveniences ──
    def use_runtime(self, *names, response_text="sub-agent said hi", raises=None):
        """Point the supervisor at fake AgentCore control + runtime clients."""
        control = FakeAgentCoreControl(names)
        runtime = FakeAgentCoreRuntime(response_text=response_text, raises=raises)
        self.sup._agentcore_control = control
        self.sup._agentcore_runtime = runtime
        return control, runtime

    def latest_agui(self) -> "StrandsAgent":
        self.assertTrue(BUILT_AG_UI, "no AG-UI adapter was built")
        return BUILT_AG_UI[-1]

    def invoke(self, payload):
        """Drive the real ``handle()`` entrypoint end to end.

        Returns ``(events, result, error)``: events for the streaming path,
        result for the sync dict path, error for whatever escaped the stream
        after the last event was delivered.
        """
        sup = self.sup

        async def _drive():
            out: list = []
            res = await sup.handle(payload)
            if hasattr(res, "__aiter__"):
                try:
                    async for ev in res:
                        out.append(ev)
                except Exception as exc:  # noqa: BLE001
                    return out, None, exc
                return out, None, None
            return out, res, None

        with no_network():
            return run_async(_drive())

    def prewarm(self, tenant="orgiq", role="member"):
        """Build (and return) the agent pair for a key before the run, so a
        test can script the Strands stub's answer."""
        return self.sup._agents_for_role(role, tenant)
