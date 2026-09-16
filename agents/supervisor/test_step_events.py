"""Unit tests for the supervisor's synthesized STEP_STARTED/STEP_FINISHED events.

Run:  cd agents/supervisor && ../../.venv-synth/bin/python -m unittest test_step_events
(from the synth venv, which has boto3/botocore — the host python3 does not).

Background (docs/research-agui-steps-2026-09-16.md): `ag_ui_strands` only emits
STEP events off Strands' Graph/Swarm multi-agent orchestration callbacks. This
supervisor routes to sub-agents with a hand-rolled `@tool` + `invoke_agent_runtime`
call instead, so the adapter only ever sees an ordinary tool call — no STEP event
reaches the stream, and the portal's run-phase stepper never has more than one
phase to show. `_handle_streaming` (agents/supervisor/main.py) now synthesizes
STEP_STARTED/STEP_FINISHED around each sub-agent routing tool call by watching
the TOOL_CALL_START / TOOL_CALL_RESULT events the adapter already emits for it.

`main.py` imports several agent-image-only packages (`bedrock_agentcore`,
`strands`, `ag_ui_strands`, `ag_ui.core`) that are not installed on a dev host
or in the synth venv. Mirroring `agents/_shared/test_callbacks.py`'s approach
for `strands`/`httpx`, this file installs minimal stand-ins in `sys.modules`
before importing `main`, restored in `tearDownModule`. The stand-ins are
structural only (plain kwargs-holding objects) — nothing here asserts anything
about the real SDKs' behavior, only about what `main.py` does with the events
they would carry.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path

# So `import main` resolves regardless of cwd. `main.py` itself then inserts
# its own parent (agents/) onto sys.path so its `from _shared...` imports
# resolve, the same way it does when AgentCore Runtime imports it directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))


# ── Minimal stand-ins for agent-image-only packages ─────────────────────────


class _KwargsObj:
    """Generic object that just remembers whatever kwargs it was built with.

    Stands in for every ag_ui.core pydantic model `main.py` constructs
    (RunAgentInput, UserMessage, AssistantMessage, StepStartedEvent, ...).
    `main._event_type`/`_event_attr` read fields via `getattr(obj, name,
    None)`, which works identically against this and a real pydantic model.
    """

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _EventType:
    """Stand-in for ag_ui.core.EventType. Real values are `str` enum members
    whose `.value` is the type name; plain strings satisfy
    `_event_type`'s `getattr(raw, "value", raw)` fallback identically."""

    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"


_STUB_MODULE_NAMES = (
    "httpx",
    "strands",
    "strands.models",
    "strands.models.bedrock",
    "bedrock_agentcore",
    "bedrock_agentcore.runtime",
    "ag_ui_strands",
    "ag_ui",
    "ag_ui.core",
)

_SAVED_MODULES: dict = {}
main = None  # bound in setUpModule


def setUpModule() -> None:  # noqa: N802 - unittest hook
    for name in _STUB_MODULE_NAMES:
        _SAVED_MODULES[name] = sys.modules.get(name)

    httpx_stub = types.ModuleType("httpx")
    httpx_stub.Client = object
    httpx_stub.HTTPStatusError = type("HTTPStatusError", (Exception,), {})
    sys.modules["httpx"] = httpx_stub

    strands_stub = types.ModuleType("strands")
    strands_stub.tool = lambda fn: fn  # `@tool` is identity here
    strands_stub.Agent = type("Agent", (), {"__init__": lambda self, **kw: None})
    sys.modules["strands"] = strands_stub

    strands_models_stub = types.ModuleType("strands.models")
    sys.modules["strands.models"] = strands_models_stub

    strands_bedrock_stub = types.ModuleType("strands.models.bedrock")
    strands_bedrock_stub.BedrockModel = type(
        "BedrockModel", (), {"__init__": lambda self, **kw: None}
    )
    sys.modules["strands.models.bedrock"] = strands_bedrock_stub

    bac_stub = types.ModuleType("bedrock_agentcore")
    sys.modules["bedrock_agentcore"] = bac_stub

    bac_runtime_stub = types.ModuleType("bedrock_agentcore.runtime")

    class _BedrockAgentCoreApp:
        def entrypoint(self, fn):  # `@app.entrypoint` is identity here
            return fn

    bac_runtime_stub.BedrockAgentCoreApp = _BedrockAgentCoreApp
    sys.modules["bedrock_agentcore.runtime"] = bac_runtime_stub

    ag_ui_strands_stub = types.ModuleType("ag_ui_strands")
    ag_ui_strands_stub.StrandsAgent = type(
        "StrandsAgent", (), {"__init__": lambda self, **kw: None}
    )
    ag_ui_strands_stub.StrandsAgentConfig = type(
        "StrandsAgentConfig", (), {"__init__": lambda self, **kw: None}
    )
    sys.modules["ag_ui_strands"] = ag_ui_strands_stub

    ag_ui_stub = types.ModuleType("ag_ui")
    ag_ui_core_stub = types.ModuleType("ag_ui.core")
    ag_ui_core_stub.EventType = _EventType
    ag_ui_core_stub.RunAgentInput = _KwargsObj
    ag_ui_core_stub.Message = _KwargsObj
    ag_ui_core_stub.UserMessage = _KwargsObj
    ag_ui_core_stub.AssistantMessage = _KwargsObj
    ag_ui_core_stub.RunErrorEvent = _KwargsObj
    ag_ui_core_stub.StepStartedEvent = _KwargsObj
    ag_ui_core_stub.StepFinishedEvent = _KwargsObj
    ag_ui_stub.core = ag_ui_core_stub
    sys.modules["ag_ui"] = ag_ui_stub
    sys.modules["ag_ui.core"] = ag_ui_core_stub

    global main
    import main as _main  # noqa: PLC0415

    main = _main


def tearDownModule() -> None:  # noqa: N802 - unittest hook
    for name, mod in _SAVED_MODULES.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod
    sys.modules.pop("main", None)


# ── test fixtures ────────────────────────────────────────────────────────────


class FakeAgUiAgent:
    """Stands in for the `StrandsAgent` adapter `_agents_for_role` returns.

    `.run(run_input)` is what `_handle_streaming` drives with
    `async for event in ag_ui_agent.run(run_input)`.
    """

    def __init__(self, events, *, raise_after: Exception | None = None):
        self._events = list(events)
        self._raise_after = raise_after

    async def run(self, run_input):  # noqa: ARG002 - signature match only
        for ev in self._events:
            yield ev
        if self._raise_after is not None:
            raise self._raise_after


def _tool_call_start(tool_call_id: str, tool_call_name: str):
    return _KwargsObj(
        type=_EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id,
        tool_call_name=tool_call_name,
    )


def _tool_call_result(tool_call_id: str, content: str = "{}"):
    return _KwargsObj(
        type=_EventType.TOOL_CALL_RESULT,
        tool_call_id=tool_call_id,
        content=content,
    )


def _tool_call_end(tool_call_id: str):
    return _KwargsObj(type=_EventType.TOOL_CALL_END, tool_call_id=tool_call_id)


def _text_content(message_id: str, delta: str):
    return _KwargsObj(
        type=_EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta
    )


async def _collect(agen):
    """Drain an async generator, returning (events, exception|None)."""
    events = []
    try:
        async for ev in agen:
            events.append(ev)
    except Exception as exc:  # noqa: BLE001 - the test inspects this directly
        return events, exc
    return events, None


class StepEventTests(unittest.TestCase):
    def setUp(self):
        # `_handle_streaming` calls both of these at the end/on error. Neither
        # is under test here and both would otherwise try real I/O (an
        # AgentCore ARN lookup / an HTTP POST to a middleware that isn't
        # running) — stub them to no-ops, like `_agents_for_role` below.
        self._orig_agents_for_role = main._agents_for_role
        self._orig_post_trace = main.post_trace
        main.post_trace = lambda bundle: True

    def tearDown(self):
        main._agents_for_role = self._orig_agents_for_role
        main.post_trace = self._orig_post_trace

    def _run_streaming(self, events, *, raise_after=None, role="member"):
        fake_agent = FakeAgUiAgent(events, raise_after=raise_after)
        main._agents_for_role = lambda role, tenant=main.DEFAULT_TENANT: (
            None,
            fake_agent,
            "test-sha",
        )
        payload = {"sessionId": "s-1", "invocationId": "run-1", "history": []}
        agen = main._handle_streaming(payload, "who knows Kubernetes?", role)
        return asyncio.run(_collect(agen))

    def test_step_events_bracket_a_sub_agent_tool_call(self):
        events, exc = self._run_streaming(
            [
                _tool_call_start("tc-1", "search_organization"),
                _tool_call_end("tc-1"),
                _tool_call_result("tc-1", '{"response": "..."}'),
                _text_content("m-1", "Ada knows Kubernetes."),
            ]
        )
        self.assertIsNone(exc)
        types_seen = [main._event_type(e) for e in events]
        self.assertEqual(
            types_seen,
            [
                "TOOL_CALL_START",
                "STEP_STARTED",
                "TOOL_CALL_END",
                "TOOL_CALL_RESULT",
                "STEP_FINISHED",
                "TEXT_MESSAGE_CONTENT",
            ],
        )
        started = events[1]
        finished = events[4]
        self.assertEqual(main._event_attr(started, "step_name"), "search")
        self.assertEqual(main._event_attr(finished, "step_name"), "search")

    def test_step_finishes_on_tool_call_result_not_tool_call_end(self):
        # TOOL_CALL_END fires when the model finishes streaming *arguments*,
        # before `_invoke_sub_agent` has actually run — only TOOL_CALL_RESULT
        # means the sub-agent call actually returned. STEP_FINISHED must not
        # appear until after TOOL_CALL_RESULT.
        events, exc = self._run_streaming(
            [
                _tool_call_start("tc-1", "get_expertise_scores"),
                _tool_call_end("tc-1"),
            ]
        )
        self.assertIsNone(exc)
        types_seen = [main._event_type(e) for e in events]
        self.assertEqual(types_seen, ["TOOL_CALL_START", "STEP_STARTED", "TOOL_CALL_END"])
        self.assertNotIn("STEP_FINISHED", types_seen)

    def test_non_sub_agent_tool_calls_get_no_step_events(self):
        events, exc = self._run_streaming(
            [
                _tool_call_start("tc-1", "run_in_sandbox"),
                _tool_call_end("tc-1"),
                _tool_call_result("tc-1", "{}"),
            ]
        )
        self.assertIsNone(exc)
        types_seen = [main._event_type(e) for e in events]
        self.assertNotIn("STEP_STARTED", types_seen)
        self.assertNotIn("STEP_FINISHED", types_seen)

    def test_a_step_that_started_finishes_even_when_the_stream_dies(self):
        # The stream dies (e.g. a guardrail intervention, a dropped
        # connection) after TOOL_CALL_START but before TOOL_CALL_RESULT ever
        # arrives. The portal's stepper must not be left with a step that
        # never resolves.
        boom = RuntimeError("upstream connection reset")
        events, exc = self._run_streaming(
            [_tool_call_start("tc-1", "get_strategic_advice")],
            raise_after=boom,
        )
        self.assertIs(exc, boom)
        types_seen = [main._event_type(e) for e in events]
        self.assertEqual(
            types_seen,
            ["TOOL_CALL_START", "STEP_STARTED", "STEP_FINISHED", "RUN_ERROR"],
        )
        self.assertEqual(main._event_attr(events[1], "step_name"), "advisor")
        self.assertEqual(main._event_attr(events[2], "step_name"), "advisor")

    def test_step_name_map_covers_every_routing_tool(self):
        self.assertEqual(
            main.SUB_AGENT_STEP_NAMES,
            {
                "search_organization": "search",
                "get_expertise_scores": "scoring",
                "get_strategic_advice": "advisor",
                "ingest_documents": "ingestion",
                "build_graph": "graph-builder",
            },
        )


if __name__ == "__main__":
    unittest.main()
