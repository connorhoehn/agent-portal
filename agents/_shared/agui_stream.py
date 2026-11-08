"""Genuine AG-UI streaming for the non-supervisor agents.

Every OrgIQ agent already declared `ag-ui-strands` and `bedrock-agentcore[ag-ui]`
in its pyproject, but only the supervisor ever wired the adapter up. The other
seven answered with a single JSON envelope — `{agent, response, invocationId,
toolCalls[]}` — which AgentCore returns as `contentType: application/json`. The
middleware reads `data: `-prefixed SSE lines, so a bare JSON body parsed to
nothing and every direct invoke of those seven produced an empty,
successful-looking run. Verified live: orgiq_search answered correctly and the
answer was discarded in transit.

Normalizing that in the middleware would have made the empty visible but left
the agents non-streaming — the answer would still arrive in one lump after the
model finished. So the fix lives here: the same AG-UI event stream the
supervisor emits, token by token, produced by every agent.

What this module does NOT do is replace the synchronous dict path. The
supervisor calls search/scoring/advisor over A2A and expects a dict back, so an
agent keeps both: `stream_agui` when the caller asked to stream, the existing
return-a-dict entrypoint otherwise. The middleware sets `"stream": true`; A2A
does not.

Design mirrors `agents/supervisor/main.py::_handle_streaming`, deliberately —
including the parts that look like paranoia and are not:

  * RUN_ERROR is emitted *before* the exception is re-raised. A stream that
    merely stops is indistinguishable at the portal from a short answer; the
    middleware only marks a run failed when it actually sees RUN_ERROR.
  * Only TEXT_MESSAGE_CONTENT deltas are accumulated for the trace. TOOL_CALL_ARGS
    also carries a `delta`, and splicing a tool's JSON arguments into the stored
    answer means the transcript, judge and canary all score a reply nobody saw.
  * A failed run with no response, tokens, tools or guardrail signal is dropped
    at the trace sink as a phantom row, so the error text is written into the
    response — it is the substance that keeps the failure visible.
"""

from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator

from .instrumentation import (
    TraceContext,
    post_trace,
    record_guardrail_action,
    reset_active_ctx,
    set_active_ctx,
    usage_block,
    with_orgiq_root,
)

log = logging.getLogger(__name__)


def event_type(event: Any) -> str:
    """AG-UI event type as a plain string.

    Tolerates the three shapes an event arrives in: a pydantic event whose
    ``type`` is an ``EventType`` enum member, one where it is already a string,
    and a bare dict (some adapter versions hand back plain dicts).
    """
    raw = event.get("type") if isinstance(event, dict) else getattr(event, "type", None)
    return str(getattr(raw, "value", raw) or "")


def run_error_event(message: str, code: str = "agent_stream_error"):
    """Terminal AG-UI event for a stream that died partway through.

    Falls back to a plain dict if the SDK ever renames the class — an
    unrecognised-but-present terminal event still beats silence.
    """
    try:
        from ag_ui.core import EventType, RunErrorEvent

        return RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code)
    except Exception:  # noqa: BLE001
        return {"type": "RUN_ERROR", "message": message, "code": code}


def with_usage(event: Any, ctx: TraceContext, model_id: str) -> Any:
    """``event`` carrying the run's Bedrock usage and the model that served it.

    The middleware prices a chat turn from a ``usage`` block on the final event
    and records an unknown cost when there is none, so when the context has
    captured no tokens the event is returned as the very same object: never a
    guessed zero. Otherwise a new plain dict is built from the original's
    fields (the original is not mutated) with ``usage`` and ``model`` added.
    """
    usage = usage_block(ctx)
    if usage is None:
        return event
    if isinstance(event, dict):
        out = dict(event)
    elif hasattr(event, "model_dump"):
        out = event.model_dump(by_alias=True, exclude_none=True)
    else:
        out = dict(event)
    # An enum `type` serialises as a string on the wire; keep it a plain one.
    raw_type = out.get("type")
    out["type"] = str(getattr(raw_type, "value", raw_type) or "")
    out["usage"] = usage
    out["model"] = model_id
    return out


def build_run_input(payload: dict, input_text: str):
    """AG-UI ``RunAgentInput`` from a middleware payload.

    The awkward bits are both live-fire lessons from the 2026-08 SDK bump, and
    are why this is one shared function rather than seven copies:

      * every ``Message`` needs an explicit ``id`` — omitting it is a pydantic
        ValidationError that kills the invocation;
      * ``state``/``tools``/``context``/``forwarded_props`` are all required
        fields (empty values are fine);
      * ``or`` rather than ``.get(k, default)`` — the middleware can send an
        explicit null, and ``.get`` returns that null, which pydantic rejects.
        Absent and null have to behave identically.
    """
    from ag_ui.core import AssistantMessage, RunAgentInput, UserMessage

    thread_id = payload.get("sessionId") or "default"
    run_id = payload.get("invocationId") or f"run-{time.time_ns()}"

    messages: list[Any] = []
    for i, turn in enumerate(payload.get("history", []) or []):
        if isinstance(turn, dict) and turn.get("role") and turn.get("content"):
            if turn["role"] == "user":
                messages.append(UserMessage(id=f"hist-{i}", role="user", content=turn["content"]))
            else:
                messages.append(
                    AssistantMessage(id=f"hist-{i}", role="assistant", content=turn["content"])
                )

    messages.append(UserMessage(id=f"msg-{time.time_ns()}", role="user", content=input_text))

    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages,
        state=None,
        tools=[],
        context=[],
        forwarded_props=None,
    )


def wants_stream(payload: Any) -> bool:
    """Whether the caller asked for an event stream.

    The middleware sets ``stream: true`` for user-facing invocations; A2A
    sub-agent calls do not, and must keep getting a dict.
    """
    return isinstance(payload, dict) and bool(payload.get("stream", False))


async def stream_agui(
    *,
    payload: dict,
    input_text: str,
    live_agent: Any,
    agent_id: str,
    agent_name: str,
    model_id: str,
    ctx_var: Any = None,
    scoped_vars: list[tuple[Any, Any]] | None = None,
) -> AsyncIterator[Any]:
    """Yield real AG-UI events for one invocation, and trace it exactly once.

    ``live_agent`` is the module's ``LiveAgent``; its ``ag_ui`` adapter is
    rebuilt whenever the managed system prompt changes, so a Prompt Studio edit
    reaches the stream on the same ~60s cycle as the sync path.

    ``ctx_var`` is the module-level ``_current_ctx`` ContextVar, set so that
    instrumented tools inside the run attribute themselves to this invocation.

    ``scoped_vars`` is ``[(contextvar, initial_value), ...]`` set for the life of
    the stream and reset after. Scoring and graph-builder need it: their
    synchronous entrypoints set ``_sandbox_log`` and reset it in a ``finally``,
    and that ``finally`` runs when the entrypoint *returns this generator* —
    long before the generator body executes. Without re-establishing it here, a
    code-interpreter call made during a streamed run would append to a list that
    was already torn down.
    """
    adapter = live_agent.ag_ui(name=agent_id)
    prompt_sha = live_agent.prompt_sha
    # DE-4: the Bedrock version number and pointer arm, read once beside the
    # sha so the trace joins to a published version without re-hashing.
    prompt_resolved = getattr(live_agent, "resolved", None)
    prompt_version_number = getattr(prompt_resolved, "version_number", "") or None
    prompt_arm = getattr(prompt_resolved, "arm", "") or None

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = ctx_var.set(ctx) if ctx_var is not None else None
    shared_token = set_active_ctx(ctx)
    scoped_tokens = [(var, var.set(value)) for var, value in (scoped_vars or [])]
    t0 = time.monotonic()
    streamed_text: list[str] = []
    stream_error: str | None = None

    # Everything is inside the try, including building the RunAgentInput: a
    # ValidationError there would otherwise escape before the finally, leaving
    # the context set to a dead invocation and emitting neither RUN_ERROR nor a
    # trace. That is exactly what the 2026-08 SDK drift produced.
    try:
        run_input = build_run_input(payload, input_text)
        log.info(
            "%s AG-UI streaming (thread=%s, run=%s, invocation=%s): %s",
            agent_name, run_input.thread_id, run_input.run_id, ctx.invocation_id,
            input_text[:120],
        )

        with with_orgiq_root(
            ctx,
            agent_id=agent_id,
            agent_name=agent_name,
            prompt_version=prompt_sha,
            prompt_version_number=prompt_version_number,
            prompt_arm=prompt_arm,
            model_id=model_id,
            model_registry_version=getattr(live_agent, "registry_version", "") or None,
        ) as oi_span:
            async for event in adapter.run(run_input):
                if event_type(event) == "TEXT_MESSAGE_CONTENT":
                    delta = (
                        event.get("delta") if isinstance(event, dict)
                        else getattr(event, "delta", None)
                    )
                    if isinstance(delta, str) and delta:
                        streamed_text.append(delta)
                # The terminal event is where the middleware looks for usage;
                # the counts are complete by now because the model has finished.
                if event_type(event) == "RUN_FINISHED":
                    event = with_usage(event, ctx, model_id)
                yield event
            record_guardrail_action(oi_span, action=None, pii_detected=None)
    except Exception as exc:  # noqa: BLE001
        # Say it failed, then let it fail. The event is for the portal; the
        # re-raise keeps the runtime's own error accounting honest.
        stream_error = str(exc) or type(exc).__name__
        log.exception("%s: AG-UI stream failed: %s", agent_id, stream_error)
        yield run_error_event(stream_error, code=f"{agent_id}_stream_error")
        raise
    finally:
        duration_ms = int((time.monotonic() - t0) * 1000)
        if ctx_var is not None and token is not None:
            try:
                ctx_var.reset(token)
            except ValueError:
                # Token minted in a different Context — possible when an async
                # generator is resumed from another task. Clearing outright still
                # stops a later tool call inheriting a finished invocation, which
                # is the property that matters.
                ctx_var.set(None)
        for var, scoped_token in reversed(scoped_tokens):
            try:
                var.reset(scoped_token)
            except ValueError:
                var.set(None)
        reset_active_ctx(shared_token)

        response_text = "".join(streamed_text)
        if stream_error:
            response_text = (
                f"{response_text}\n[stream error] {stream_error}"
                if response_text else f"[stream error] {stream_error}"
            )
        try:
            bundle = ctx.build_trace_bundle(
                prompt=input_text,
                response=response_text,
                agent_id=agent_id,
                agent_name=agent_name,
                model_id=model_id,
                duration_ms=duration_ms,
                prompt_version=prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:  # noqa: BLE001 — tracing must never break the stream
            log.warning("%s: streaming trace emission failed: %s", agent_id, exc)

def agui_events_for_text(text: str, *, message_id: str | None = None):
    """AG-UI events carrying an already-final answer.

    For agents whose output must pass a deterministic backstop before anyone
    sees it. ``assessment-drafter`` is the case: story mode runs
    ``scrub_forbidden_promises`` and context mode runs ``validate_context_facts``,
    which *drops* facts whose ``source_span`` is not in the source document and
    fails CLOSED if it cannot run at all. Streaming the model's tokens as they
    arrive would put the unscrubbed, unvalidated text on the wire first and make
    both controls decorative — the client would already have the text they exist
    to withhold.

    So the drafter emits the same AG-UI events over the *validated* string. Same
    protocol, same wire format, same consumers; the answer simply arrives in one
    TEXT_MESSAGE_CONTENT rather than many. That is a deliberate trade of
    incremental delivery for a safety control, not an oversight — do not
    "upgrade" it to token streaming without moving the backstops upstream of the
    model output.
    """
    import uuid

    mid = message_id or str(uuid.uuid4())
    try:
        from ag_ui.core import (
            EventType,
            TextMessageContentEvent,
            TextMessageEndEvent,
            TextMessageStartEvent,
        )

        return [
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"),
            TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=text),
            TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid),
        ]
    except Exception:  # noqa: BLE001 — same fallback posture as run_error_event
        return [
            {"type": "TEXT_MESSAGE_START", "message_id": mid, "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "message_id": mid, "delta": text},
            {"type": "TEXT_MESSAGE_END", "message_id": mid},
        ]
