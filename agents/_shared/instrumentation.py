"""Tool-call instrumentation for OrgIQ agents.

This is the agent-side complement to the middleware's `/api/observability/harness/trace`
endpoint. Each agent invocation gets a `TraceContext` that:

    1. Generates an `invocation_id` (or accepts a `parent_invocation_id` from the
       caller — used by sub-agents invoked via A2A so the middleware can stitch
       the trace tree together).
    2. Buffers per-tool observations (timing, sizes, errors, truncated samples)
       via the `instrumented_tool` decorator that wraps each `@tool`.
    3. Builds + POSTs a trace bundle to the middleware at the end of the
       invocation — fire-and-forget; failures must NEVER crash the agent.

Typical agent wiring::

    from _shared.instrumentation import TraceContext, instrumented_tool, post_trace

    ctx = TraceContext.from_request_payload(payload)

    @tool
    @instrumented_tool(ctx)
    def my_tool(arg: str) -> str:
        ...

    # … run the agent …

    bundle = ctx.build_trace_bundle(
        prompt=user_prompt,
        response=str(result),
        agent_id="orgiq-supervisor",
        agent_name="Supervisor",
        model_id="amazon.nova-pro-v1:0",
        prompt_version=prompt_sha,
    )
    post_trace(bundle)

Decorator order matters: ``@instrumented_tool(ctx)`` must be **inside**
``@tool`` (closest to the function). Strands wraps the inner function as a tool;
we wrap the bare Python callable, leaving the tool surface untouched.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

import urllib.error
import urllib.request

log = logging.getLogger(__name__)

# Middleware URL — defaults to the docker-compose service name so the agents
# can reach the middleware over the compose network. Override with
# MIDDLEWARE_URL=http://host.docker.internal:3001 for local-host bridging.
MIDDLEWARE_URL = os.environ.get("MIDDLEWARE_URL", "http://middleware:3001")

# Sample truncation length. The middleware enforces the same cap server-side
# (sink truncates to 500). Doing it here too keeps the wire small.
_SAMPLE_CAP = 500

# Trace POST hard cap. The agent must NEVER block on this — keep it tight.
_HTTP_TIMEOUT_S = 5.0


# ── Helpers ───────────────────────────────────────────────────────────────────


def short_prompt_hash(content: str) -> str:
    """12 hex chars of SHA-256 — mirror of middleware/src/lib/pricing.ts::shortHash.

    Stamped onto every trace as ``promptVersion`` so the middleware can answer
    "which prompt produced this regression?" without a round-trip.
    """
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _truncate(s: str | None, n: int = _SAMPLE_CAP) -> str | None:
    if s is None:
        return None
    if not isinstance(s, str):
        try:
            s = json.dumps(s, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            s = str(s)
    return s if len(s) <= n else s[:n]


def _size_of(value: Any) -> int:
    """Length of the JSON-serialised form of `value` in chars. Falls back to
    str() for non-serialisable objects so we always get a number."""
    if value is None:
        return 0
    try:
        return len(json.dumps(value, default=str, ensure_ascii=False))
    except (TypeError, ValueError):
        return len(str(value))


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


# ── TraceContext ──────────────────────────────────────────────────────────────


@dataclass
class TraceContext:
    """Per-invocation trace buffer. One per agent call; not thread-safe by
    design — agent invocations are sequential within Strands' Converse loop."""

    invocation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    parent_invocation_id: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_request_payload(cls, payload: Any) -> "TraceContext":
        """Build a context from an incoming agent payload.

        Reads ``parentInvocationId``, ``userId``, ``sessionId`` if present.
        Anything missing → defaults (fresh invocation_id, no parent). Safe to
        call with non-dict payloads — they yield a fully-default context.
        """
        if not isinstance(payload, dict):
            return cls()
        # camelCase is the wire contract; allow snake_case fallback for tolerance.
        parent = (
            payload.get("parentInvocationId")
            or payload.get("parent_invocation_id")
        )
        user_id = payload.get("userId") or payload.get("user_id")
        # `auth.userId` is the shape the middleware uses when masquerading.
        if not user_id and isinstance(payload.get("auth"), dict):
            user_id = payload["auth"].get("userId") or payload["auth"].get("user_id")
        session_id = (
            payload.get("sessionId")
            or payload.get("session_id")
            or payload.get("runtimeSessionId")
        )
        return cls(
            parent_invocation_id=parent if isinstance(parent, str) else None,
            user_id=user_id if isinstance(user_id, str) else None,
            session_id=session_id if isinstance(session_id, str) else None,
        )

    # ── Tool-call buffering ──

    def record_tool_call(self, entry: dict[str, Any]) -> None:
        """Append one observation. Caller already truncated samples."""
        self.tool_calls.append(entry)

    # ── Bundle assembly ──

    def build_trace_bundle(
        self,
        *,
        prompt: str,
        response: str,
        agent_id: str,
        agent_name: str | None = None,
        model_id: str | None = None,
        template_id: str | None = None,
        duration_ms: int | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        prompt_version: str | None = None,
        guardrail_action: str | None = None,
        pii_detected: bool | None = None,
    ) -> dict[str, Any]:
        """Assemble the JSON dict expected by ``POST /api/observability/harness/trace``.

        All fields are optional except agentId/prompt/response — the middleware
        is tolerant. Missing tokens / cost are normal for live mode where the
        AgentCore Converse usage block isn't surfaced; we just omit them so the
        sink can log "no usage" exactly once per agent.
        """
        body: dict[str, Any] = {
            "agentId": agent_id,
            "agentName": agent_name or agent_id,
            "prompt": prompt,
            "response": response,
            # Sprint 2 wire additions:
            "invocationId": self.invocation_id,
        }
        if template_id:
            body["templateId"] = template_id
        if duration_ms is not None:
            body["durationMs"] = int(duration_ms)
        if input_tokens is not None:
            body["inputTokens"] = int(input_tokens)
        if output_tokens is not None:
            body["outputTokens"] = int(output_tokens)
        if prompt_version:
            body["promptVersion"] = prompt_version
        if model_id:
            body["modelId"] = model_id
        if guardrail_action:
            body["guardrailAction"] = guardrail_action
        if pii_detected is not None:
            body["piiDetected"] = bool(pii_detected)
        # Sprint 2 trace-stitching fields. Only include when set — null shapes
        # confuse some middleware validators and a missing key reads identically.
        if self.parent_invocation_id:
            body["parentInvocationId"] = self.parent_invocation_id
        if self.user_id:
            body["userId"] = self.user_id
        if self.session_id:
            body["sessionId"] = self.session_id
        if self.tool_calls:
            body["toolCalls"] = list(self.tool_calls)
        return body


# ── Decorator ─────────────────────────────────────────────────────────────────


def instrumented_tool(
    ctx: "TraceContext | Callable[[], TraceContext | None] | None",
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Wrap a callable so each invocation appends an observation to a ``TraceContext``.

    Place INSIDE ``@tool`` — the Strands decorator inspects the wrapped
    function's signature + docstring to build the tool schema, so we must
    preserve them with ``functools.wraps``.

    ``ctx`` may be:
      * a concrete ``TraceContext`` — observations always go to that buffer
        (useful in tests or single-shot scripts)
      * a callable returning a ``TraceContext`` or ``None`` — resolved at each
        call. This is the pattern used in long-lived agents where the context
        rotates per invocation (e.g. a ``contextvars.ContextVar.get`` reference).
      * ``None`` — observations are dropped silently. Useful for environments
        where instrumentation is compiled in but not yet enabled.

    The wrapper:
      * times the call with ``time.monotonic`` (immune to wall-clock jumps)
      * records sizes of args/kwargs (JSON char length) and the return value
      * captures the first 500 chars of input / output as truncated samples
      * if the call raises, records ``errored=True`` + message AND re-raises —
        the agent's error-handling path is untouched
    """

    def _resolve() -> TraceContext | None:
        if ctx is None:
            return None
        if isinstance(ctx, TraceContext):
            return ctx
        if callable(ctx):
            try:
                resolved = ctx()
            except Exception:  # noqa: BLE001 — defensive; resolver must never break the agent
                return None
            return resolved if isinstance(resolved, TraceContext) else None
        return None

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = getattr(fn, "__name__", "unknown_tool")

        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            buffer = _resolve()
            started_at = _now_iso()
            t0 = time.monotonic()
            # Build the input sample lazily — JSON-encode (args, kwargs).
            try:
                input_blob = json.dumps(
                    {"args": list(args), "kwargs": dict(kwargs)},
                    default=str, ensure_ascii=False,
                )
            except (TypeError, ValueError):
                input_blob = f"args={args!r} kwargs={kwargs!r}"
            input_size = len(input_blob)

            entry: dict[str, Any] = {
                "toolName": tool_name,
                "startedAt": started_at,
                "inputSize": input_size,
                "inputSample": _truncate(input_blob),
                "errored": False,
            }

            try:
                result = fn(*args, **kwargs)
            except Exception as exc:
                entry["errored"] = True
                entry["errorMessage"] = _truncate(f"{type(exc).__name__}: {exc}")
                entry["durationMs"] = int((time.monotonic() - t0) * 1000)
                if buffer is not None:
                    buffer.record_tool_call(entry)
                raise

            duration_ms = int((time.monotonic() - t0) * 1000)
            entry["durationMs"] = duration_ms
            entry["outputSize"] = _size_of(result)
            entry["outputSample"] = _truncate(_stringify(result))
            if buffer is not None:
                buffer.record_tool_call(entry)
            return result

        return wrapper

    return decorator


# ── HTTP sender ───────────────────────────────────────────────────────────────


def _emit_stdout_trace(bundle: dict[str, Any]) -> None:
    """Emit the bundle as a single JSON line prefixed with ``ORGIQ_TRACE:``.

    AgentCore Runtime captures agent stdout/stderr into CloudWatch Logs at
    ``/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT``. The middleware
    polls those log groups with CW Logs Insights, parses the JSON tail of
    each ``ORGIQ_TRACE:`` line, and feeds the result through the same
    ``processTrace`` pipeline as the HTTP endpoint. This decouples agents
    from middleware reachability — the runtime never has to dial out.

    Must NEVER raise: stdout failures (closed pipe, encoding error, OOM at
    serialise time) silently no-op so the agent invocation completes.
    """
    try:
        # default=str keeps datetimes/UUIDs serialisable. ensure_ascii=False
        # so non-Latin characters in samples survive the round-trip; the JSON
        # is parsed back as UTF-8 by the middleware ingestor.
        line = json.dumps(bundle, default=str, ensure_ascii=False)
        print(f"ORGIQ_TRACE:{line}", flush=True)
    except Exception:  # noqa: BLE001 — observability must never crash the agent
        pass


def post_trace(bundle: dict[str, Any], *, middleware_url: str | None = None) -> bool:
    """Fire-and-forget delivery of a trace bundle.

    Two paths, both best-effort:

      1. HTTP POST to the middleware. Useful for local dev where the agent
         can reach ``http://middleware:3001`` over the docker-compose network.
      2. stdout emission of ``ORGIQ_TRACE:<json>``. The production path: the
         AgentCore Runtime captures stdout into CloudWatch Logs, and the
         middleware polls those log groups for ingestion. This avoids needing
         the deployed runtime to dial back into a developer machine.

    Returns True iff the HTTP POST succeeded. The stdout emission happens
    unconditionally and never affects the return value — the middleware
    INSERT path is idempotent on ``invocation_id``, so double-delivery
    (HTTP succeeds + CW Logs ingestion picks it up too) is safe.

    NEVER raises: the agent must keep running even if observability is down.
    """
    # Always emit on stdout first so a slow / failing HTTP POST can't
    # accidentally swallow the trace before CW Logs can capture it.
    _emit_stdout_trace(bundle)

    base = (middleware_url or MIDDLEWARE_URL).rstrip("/")
    url = f"{base}/api/observability/harness/trace"
    try:
        data = json.dumps(bundle, default=str, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        log.warning("instrumentation: failed to serialise trace bundle: %s", exc)
        return False
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
            # We don't care about the response body; we only POST for the
            # middleware's side-effect of storing the trace + judging.
            resp.read()
        return True
    except urllib.error.HTTPError as exc:
        log.warning("instrumentation: POST %s -> HTTP %s", url, exc.code)
    except urllib.error.URLError as exc:
        log.warning("instrumentation: POST %s failed: %s", url, exc.reason)
    except Exception as exc:  # noqa: BLE001
        log.warning("instrumentation: POST %s unexpected error: %s", url, exc)
    return False
