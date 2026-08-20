import json
import logging
import os
import time
from contextvars import ContextVar
from typing import AsyncIterator

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel
from ag_ui_strands import StrandsAgent, StrandsAgentConfig
from ag_ui.core import RunAgentInput, Message, UserMessage

# Shared HITL approval tool. Lives in agents/_shared so any agent that needs
# to gate a high-stakes action behind human review can reuse it.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.approval_tool import request_approval  # noqa: E402
from _shared.prompt_source import resolve_system_prompt
from _shared.instrumentation import (  # noqa: E402
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    record_guardrail_action,
    reset_active_ctx,
    set_active_ctx,
    short_prompt_hash,
    with_orgiq_root,
)

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise the Converse calls Strands makes internally bypass usage capture
# and the trace bundle reports `inputTokens` / `outputTokens` as missing.
install_bedrock_usage_capture()

# Per-invocation trace buffer. Set by `handle()` before the Agent call and
# read by every instrumented tool wrapper. ContextVar gives us correct
# isolation if the runtime ever services concurrent invocations on a single
# process (Strands is sequential per-Converse-loop, but the entrypoint may
# run multiple in parallel).
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "supervisor_trace_ctx", default=None
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-lite-v1:0")
PREFIX = os.environ.get("PROJECT_PREFIX", "orgiq")
MEMORY_ID = os.environ.get("MEMORY_ID", "")
GUARDRAIL_ID = os.environ.get("GUARDRAIL_ID", "")
CODE_INTERPRETER_ID = os.environ.get("CODE_INTERPRETER_ID", "")

MAX_SANDBOX_OUTPUT_CHARS = int(os.environ.get("MAX_SANDBOX_OUTPUT_CHARS", "4000"))
MODEL_STREAM_RETRY_ATTEMPTS = int(os.environ.get("MODEL_STREAM_RETRY_ATTEMPTS", "2"))

_agentcore_control = boto3.client("bedrock-agentcore-control", region_name=REGION)
_agentcore_runtime = boto3.client("bedrock-agentcore", region_name=REGION)

# Cache runtime ARNs after first lookup to avoid repeated API calls
_runtime_arn_cache: dict[str, str] = {}


def _get_runtime_arn(agent_name: str) -> str:
    """Discover a sub-agent's runtime ARN by name via the AgentCore API (cached)."""
    if agent_name in _runtime_arn_cache:
        return _runtime_arn_cache[agent_name]

    target_name = f"{PREFIX}_{agent_name.replace('-', '_')}"
    log.info("Looking up runtime ARN for agent '%s' (target name: '%s')", agent_name, target_name)

    try:
        response = _agentcore_control.list_agent_runtimes()
        for runtime in response.get("agentRuntimes", []):
            if runtime.get("agentRuntimeName") == target_name:
                arn = runtime["agentRuntimeArn"]
                _runtime_arn_cache[agent_name] = arn
                log.info("Found runtime ARN for '%s': %s", agent_name, arn)
                return arn
        log.warning("No runtime found with name '%s'. Available: %s",
                    target_name,
                    [r.get("agentRuntimeName") for r in response.get("agentRuntimes", [])])
    except Exception as exc:
        log.error("Failed to list agent runtimes: %s: %s", type(exc).__name__, exc)

    return ""


def _invoke_sub_agent(runtime_arn: str, input_text: str, session_id: str = "") -> str:
    """Invoke a sub-agent via the AgentCore A2A invoke API.

    Threads ``parentInvocationId`` from the supervisor's active TraceContext
    into the sub-agent's payload so the middleware can stitch the trace tree
    (supervisor invocation → sub-agent invocation). Sub-agents that have been
    instrumented (Sprint 2: search) will read this field via
    ``TraceContext.from_request_payload`` and stamp it on their own trace.
    Sub-agents not yet instrumented just ignore the extra field.
    """
    payload_obj: dict = {"input_text": input_text}
    parent_ctx = _current_ctx.get()
    if parent_ctx is not None and parent_ctx.invocation_id:
        payload_obj["parentInvocationId"] = parent_ctx.invocation_id
        # Propagate the caller's user/session too — useful when the sub-agent
        # logs a trace independently and we still want them linked to the same
        # user thread in the portal.
        if parent_ctx.user_id:
            payload_obj["userId"] = parent_ctx.user_id
        if parent_ctx.session_id:
            payload_obj["sessionId"] = parent_ctx.session_id
    kwargs: dict = {
        "agentRuntimeArn": runtime_arn,
        "qualifier": "DEFAULT",
        "payload": json.dumps(payload_obj),
    }
    if session_id:
        kwargs["runtimeSessionId"] = session_id

    log.info("Invoking sub-agent ARN=%s session=%s input=%s", runtime_arn, session_id or "(none)", input_text[:80])

    try:
        response = _agentcore_runtime.invoke_agent_runtime(**kwargs)
    except Exception as exc:
        log.error("invoke_agent_runtime failed: %s: %s", type(exc).__name__, exc)
        return json.dumps({"error": f"Sub-agent invocation failed: {exc}"})

    # Response body is a streaming blob (key is "response", not "body")
    body = response.get("response", b"")
    if hasattr(body, "read"):
        body = body.read()
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")

    log.info("Sub-agent response (first 200 chars): %s", str(body)[:200])

    try:
        parsed = json.loads(body)
        return parsed.get("response", body)
    except json.JSONDecodeError:
        return body


@tool
@instrumented_tool(_current_ctx.get)
def search_organization(query: str, session_id: str = "") -> str:
    """Route a search query to the Search agent for KB + graph retrieval.

    Use for: finding people, expertise, documents, decisions, team information.

    Args:
        query: Natural language search query
        session_id: Conversation session ID for context continuity (optional)

    Returns:
        Search results from KB and organizational graph
    """
    runtime_arn = _get_runtime_arn("search")
    if not runtime_arn:
        return json.dumps({"error": "Search agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, query, session_id)


@tool
@instrumented_tool(_current_ctx.get)
def get_expertise_scores(request: str, session_id: str = "") -> str:
    """Route a scoring request to the Scoring agent for expertise metrics and leaderboards.

    Use for: PageRank scores, expertise rankings, team leaderboards, influence metrics.

    Args:
        request: Scoring request (e.g. 'top ML experts', 'score team Platform Engineering')
        session_id: Conversation session ID (optional)

    Returns:
        Expertise scores and ranking results
    """
    runtime_arn = _get_runtime_arn("scoring")
    if not runtime_arn:
        return json.dumps({"error": "Scoring agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, request, session_id)


@tool
@instrumented_tool(_current_ctx.get)
def get_strategic_advice(question: str, session_id: str = "") -> str:
    """Route a strategic question to the Advisor agent for org intelligence recommendations.

    Use for: expertise gap analysis, team composition advice, mentorship suggestions,
    collaboration opportunities, knowledge transfer planning.

    Args:
        question: Strategic question about the organization
        session_id: Conversation session ID (optional)

    Returns:
        Strategic recommendations grounded in graph data
    """
    runtime_arn = _get_runtime_arn("advisor")
    if not runtime_arn:
        return json.dumps({"error": "Advisor agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, question, session_id)


@tool
@instrumented_tool(_current_ctx.get)
def ingest_documents(instruction: str, session_id: str = "") -> str:
    """Route a document ingestion task to the Ingestion agent.

    Use for: uploading new documents, syncing the knowledge base, checking ingestion status.

    Args:
        instruction: Ingestion instruction (e.g. 'sync KB', 'list pending documents')
        session_id: Conversation session ID (optional)

    Returns:
        Ingestion status and results
    """
    runtime_arn = _get_runtime_arn("ingestion")
    if not runtime_arn:
        return json.dumps({"error": "Ingestion agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, instruction, session_id)


@tool
@instrumented_tool(_current_ctx.get)
def build_graph(instruction: str, session_id: str = "") -> str:
    """Route a graph construction task to the Graph-Builder agent.

    Use for: extracting entities from documents, updating the knowledge graph,
    adding people/skills/relationships manually.

    Args:
        instruction: Graph-building instruction or document text to process
        session_id: Conversation session ID (optional)

    Returns:
        Graph construction results with counts of nodes and relationships created
    """
    runtime_arn = _get_runtime_arn("graph-builder")
    if not runtime_arn:
        return json.dumps({"error": "Graph-Builder agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, instruction, session_id)


@tool
@instrumented_tool(_current_ctx.get)
def run_in_sandbox(python_code: str) -> str:
    """Execute a Python snippet inside the AgentCore code-interpreter sandbox.

    Use this when a user asks for a calculation, statistics, data manipulation,
    or anything that's more naturally expressed in Python than by routing to a
    specialist sub-agent. The sandbox has Python 3 + numpy/pandas but NO network
    access — embed any input data as constants inside the code. Print results
    to stdout; the captured stdout is returned to you.

    Args:
        python_code: A complete Python program. Use print() to surface results.
    Returns:
        JSON with the captured stdout, or an error message.
    """
    if not CODE_INTERPRETER_ID:
        return json.dumps({"error": "CODE_INTERPRETER_ID env var is missing — sandbox unavailable"})

    session_id = ""
    try:
        start = _agentcore_runtime.start_code_interpreter_session(
            codeInterpreterIdentifier=CODE_INTERPRETER_ID,
            name=f"supervisor-sandbox-{int(time.time())}",
        )
        session_id = start.get("sessionId", "")

        resp = _agentcore_runtime.invoke_code_interpreter(
            codeInterpreterIdentifier=CODE_INTERPRETER_ID,
            sessionId=session_id,
            name="executeCode",
            arguments={"code": python_code, "language": "python"},
        )

        chunks: list[str] = []
        for event in resp.get("stream", []) or []:
            if not isinstance(event, dict):
                continue
            if "result" in event:
                r = event["result"]
                if isinstance(r, dict):
                    for content in r.get("content", []) or []:
                        if isinstance(content, dict) and "text" in content:
                            chunks.append(content["text"])
                        else:
                            chunks.append(json.dumps(content, default=str))
                else:
                    chunks.append(str(r))
            elif "output" in event:
                chunks.append(json.dumps(event["output"], default=str))

        output = "\n".join(chunks).strip() or "(no stdout)"
        if len(output) > MAX_SANDBOX_OUTPUT_CHARS:
            omitted = len(output) - MAX_SANDBOX_OUTPUT_CHARS
            output = output[:MAX_SANDBOX_OUTPUT_CHARS] + f"\n... (truncated, {omitted} chars omitted)"
        return json.dumps({"sessionId": session_id, "output": output})
    except Exception as e:
        return json.dumps({"error": f"sandbox error: {e}", "sessionId": session_id})
    finally:
        if session_id:
            try:
                _agentcore_runtime.stop_code_interpreter_session(
                    codeInterpreterIdentifier=CODE_INTERPRETER_ID,
                    sessionId=session_id,
                )
            except Exception:
                pass


SUPERVISOR_TOOLS = [
    search_organization, get_expertise_scores, get_strategic_advice,
]

SYSTEM_PROMPT = (
    "You are the OrgIQ Supervisor — route queries to the right specialist and synthesize results.\n"
    "Tools: search_organization (people, skills, teams, projects), "
    "get_expertise_scores (rankings, influence), "
    "get_strategic_advice (gaps, mentorship, team composition).\n"
    "Call the most relevant tool immediately. Synthesize the response concisely."
)

# Per-role guardrail IDs, populated from env at module load. Middleware passes
# the caller's role in the invoke payload; we map it here to one of these.
ROLE_GUARDRAIL_IDS: dict[str, str] = {
    "member": os.environ.get("GUARDRAIL_ID_MEMBER", ""),
    "org-leader": os.environ.get("GUARDRAIL_ID_ORG_LEADER", ""),
    "hr-admin": os.environ.get("GUARDRAIL_ID_HR_ADMIN", ""),
}
DEFAULT_ROLE = "member"
DEFAULT_TENANT = "orgiq"

# Roles without a guardrail of their own borrow one: newsroom roles ride on the
# strictest (member) guardrail; the cross-tenant admin gets hr-admin's (the
# least restrictive — denies only Health topics).
GUARDRAIL_ROLE_FALLBACK: dict[str, str] = {
    "reporter": "member",
    "editor": "member",
    "admin": "hr-admin",
}


def _model_kwargs(guardrail_id: str = "") -> dict:
    """Build BedrockModel kwargs with the role-specific guardrail attached.

    GUARDRAIL_VERSION=DRAFT means "use the live editable spec" — UI edits go
    into effect on the very next InvokeModel call without rebuilding this image.
    """
    kw: dict = {
        "model_id": MODEL_ID,
        "temperature": float(os.environ.get("MODEL_TEMPERATURE", "0.0")),
        "max_tokens": int(os.environ.get("MODEL_MAX_TOKENS", "4096")),
    }
    gid = guardrail_id or os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


def _build_agent(guardrail_id: str, system_prompt: str) -> Agent:
    return Agent(
        model=BedrockModel(**_model_kwargs(guardrail_id)),
        tools=SUPERVISOR_TOOLS,
        system_prompt=system_prompt,
    )


def _build_ag_ui(role: str, agent: Agent) -> StrandsAgent:
    return StrandsAgent(
        agent=agent,
        name=f"orgiq-supervisor-{role}",
        config=StrandsAgentConfig(
            emit_messages_snapshot=False,
            replay_history_into_strands=True,
        ),
    )


# One Agent (+ AG-UI adapter) per (tenant, role). Both are rebuilt when the
# managed system prompt changes — the supervisor's prompt is resolved from
# Bedrock Prompt Management at run time, so editing
# `orgiq-supervisor-system-prompt` in the portal takes effect within
# PROMPT_REFRESH_S without a redeploy. Falls back to the SYSTEM_PROMPT literal
# if the library is unreachable. The tenant key exists so per-tenant prompts /
# guardrails can attach later without another cache reshape; today all tenants
# share the prompt and the guardrail comes from the (mapped) role.
_ROLES: dict[str, str] = {r: g for r, g in ROLE_GUARDRAIL_IDS.items() if g} or {DEFAULT_ROLE: ""}
_AGENTS_BY_KEY: dict[tuple[str, str], Agent] = {}
_AG_UI_AGENTS: dict[tuple[str, str], StrandsAgent] = {}
_PROMPT_SHA_BY_KEY: dict[tuple[str, str], str] = {}


def _guardrail_role(role: str) -> str:
    """Map a session role to the role whose guardrail it uses."""
    if role in _ROLES:
        return role
    mapped = GUARDRAIL_ROLE_FALLBACK.get(role, DEFAULT_ROLE)
    if mapped in _ROLES:
        return mapped
    return DEFAULT_ROLE if DEFAULT_ROLE in _ROLES else next(iter(_ROLES))


def _agents_for_role(role: str, tenant: str = DEFAULT_TENANT) -> tuple[Agent, StrandsAgent, str]:
    """(agent, ag_ui_adapter, prompt_sha) for (tenant, role), rebuilt on prompt change."""
    key = (tenant, role)
    resolved = resolve_system_prompt(SYSTEM_PROMPT, agent_name="supervisor")
    if _PROMPT_SHA_BY_KEY.get(key) != resolved.sha or key not in _AGENTS_BY_KEY:
        agent = _build_agent(_ROLES.get(_guardrail_role(role), ""), resolved.text)
        # Keep the historical adapter name for orgiq so topology/session naming
        # stays stable; other tenants get a tenant-qualified name.
        suffix = role if tenant == DEFAULT_TENANT else f"{tenant}-{role}"
        _AGENTS_BY_KEY[key] = agent
        _AG_UI_AGENTS[key] = _build_ag_ui(suffix, agent)
        _PROMPT_SHA_BY_KEY[key] = resolved.sha
        log.info(
            "Supervisor agent for tenant=%s role=%s built (guardrail_role=%s prompt source=%s sha=%s)",
            tenant, role, _guardrail_role(role), resolved.source, resolved.sha,
        )
    return _AGENTS_BY_KEY[key], _AG_UI_AGENTS[key], _PROMPT_SHA_BY_KEY[key]


log.info("Supervisor roles configured: %s", sorted(_ROLES.keys()))


def _resolve_identity(payload: dict) -> tuple[str, str]:
    """(tenant, role) for the caller. Unknown roles keep their name (the
    guardrail mapping happens in _agents_for_role); missing auth falls back to
    the orgiq member identity."""
    auth = payload.get("auth") if isinstance(payload, dict) else None
    role = (auth or {}).get("role") if isinstance(auth, dict) else None
    tenant = (auth or {}).get("tenant") if isinstance(auth, dict) else None
    return (
        tenant if isinstance(tenant, str) and tenant else DEFAULT_TENANT,
        role if isinstance(role, str) and role else DEFAULT_ROLE,
    )


# Baked-prompt marker, kept for reference: the value actually recorded on
# traces is the resolved prompt's sha (see _agents_for_role).
_BAKED_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

# AG-UI streaming mode. When the middleware sends accept: text/event-stream
# (or includes "stream": true in the payload), use the AG-UI adapter which
# yields SSE events as tokens arrive. Otherwise fall back to the synchronous
# dict-return path for A2A sub-agent calls.
AG_UI_STREAMING = os.environ.get("AG_UI_STREAMING", "true").lower() == "true"


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    if isinstance(payload, dict):
        input_text = (
            payload.get("input_text")
            or payload.get("prompt")
            or payload.get("message")
            or ""
        )
    else:
        input_text = str(payload)

    if not input_text:
        return {"agent": "supervisor", "error": "missing input_text/prompt/message"}

    tenant, role = _resolve_identity(payload if isinstance(payload, dict) else {})

    # A2A sub-agent calls (from other agents) use the synchronous path.
    # The middleware sets "stream": true for user-facing requests.
    use_streaming = AG_UI_STREAMING and isinstance(payload, dict) and payload.get("stream", False)

    if use_streaming:
        return _handle_streaming(payload, input_text, role, tenant)

    return await _handle_sync(payload, input_text, role, tenant)


async def _handle_streaming(payload: dict, input_text: str, role: str, tenant: str = DEFAULT_TENANT):
    """AG-UI streaming path — yields SSE events as the LLM generates tokens.

    Establishes the same TraceContext the sync path does. Without it,
    ``_invoke_sub_agent`` found ``_current_ctx`` empty and never threaded
    ``parentInvocationId``, so every sub-agent trace landed with
    parent_invocation_id NULL — and since the portal drives this streaming
    path, the A2A topology graph could never show a single edge for real
    user traffic no matter how many sub-agent calls the supervisor made.
    """
    _, ag_ui_agent, _prompt_sha = _agents_for_role(role, tenant)

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)
    t0 = time.monotonic()
    streamed_text: list[str] = []

    # Build AG-UI RunAgentInput from the middleware payload.
    thread_id = payload.get("sessionId", "default")
    run_id = payload.get("invocationId", f"run-{time.time_ns()}")

    # Convert history to AG-UI message format.
    # ag-ui-protocol >= 0.1.x requires an explicit `id` on every Message —
    # omitting it is a pydantic ValidationError that kills the invocation
    # (found live after the 2026-08 base-image rebuild pulled the newer SDK).
    messages = []
    for i, turn in enumerate(payload.get("history", [])):
        if isinstance(turn, dict) and turn.get("role") and turn.get("content"):
            if turn["role"] == "user":
                messages.append(UserMessage(id=f"hist-{i}", role="user", content=turn["content"]))
            else:
                from ag_ui.core import AssistantMessage
                messages.append(AssistantMessage(id=f"hist-{i}", role="assistant", content=turn["content"]))

    # Add the current user message.
    messages.append(UserMessage(id=f"msg-{time.time_ns()}", role="user", content=input_text))

    # ag-ui-protocol >= 0.1.x: state/tools/context/forwarded_props are all
    # required fields on RunAgentInput (same 2026-08 SDK drift as the Message
    # `id` requirement above). Empty values are valid.
    run_input = RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages,
        state=None,
        tools=[],
        context=[],
        forwarded_props=None,
    )

    log.info(
        "Supervisor AG-UI streaming (tenant=%s, role=%s, thread=%s, run=%s, invocation=%s): %s",
        tenant, role, thread_id, run_id, ctx.invocation_id, input_text[:120],
    )

    try:
        with with_orgiq_root(
            ctx,
            agent_id="orgiq-supervisor",
            agent_name="Supervisor",
            prompt_version=_prompt_sha,
        ) as oi_span:
            async for event in ag_ui_agent.run(run_input):
                # Accumulate assistant text so the persisted trace carries a
                # real response snippet instead of an empty string.
                delta = getattr(event, "delta", None)
                if isinstance(delta, str) and delta:
                    streamed_text.append(delta)
                yield event
            record_guardrail_action(oi_span, action=None, pii_detected=None)
    finally:
        duration_ms = int((time.monotonic() - t0) * 1000)
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
        # Persist the root trace for the streamed run. Sub-agent traces carry
        # parent_invocation_id == ctx.invocation_id, so this row is what the
        # A2A topology joins them to.
        try:
            bundle = ctx.build_trace_bundle(
                prompt=input_text,
                response="".join(streamed_text),
                agent_id="orgiq-supervisor",
                agent_name="Supervisor",
                model_id=MODEL_ID,
                duration_ms=duration_ms,
                prompt_version=_prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:  # noqa: BLE001 — tracing must never break the stream
            log.warning("supervisor: streaming trace emission failed: %s", exc)


async def _handle_sync(payload: dict, input_text: str, role: str, tenant: str = DEFAULT_TENANT) -> dict:
    """Synchronous dict-return path for A2A sub-agent calls."""
    agent, _, _prompt_sha = _agents_for_role(role, tenant)

    messages = []
    raw_history = payload.get("history", []) if isinstance(payload, dict) else []
    for turn in raw_history:
        if isinstance(turn, dict) and turn.get("role") and turn.get("content"):
            messages.append({"role": turn["role"], "content": [{"text": turn["content"]}]})

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "Supervisor sync handling (role=%s, invocation=%s, parent=%s, history_turns=%d): %s",
        role, ctx.invocation_id, ctx.parent_invocation_id or "—", len(messages), input_text[:120],
    )

    with with_orgiq_root(
        ctx,
        agent_id="orgiq-supervisor",
        agent_name="Supervisor",
        prompt_version=_prompt_sha,
    ) as oi_span:
        t0 = time.monotonic()
        try:
            result = _invoke_with_retry(agent, input_text, messages=messages if messages else None)
        finally:
            _current_ctx.reset(token)
            reset_active_ctx(shared_token)
        duration_ms = int((time.monotonic() - t0) * 1000)

        response_text = str(result)
        record_guardrail_action(oi_span, action=None, pii_detected=None)

        try:
            bundle = ctx.build_trace_bundle(
                prompt=input_text,
                response=response_text,
                agent_id="orgiq-supervisor",
                agent_name="Supervisor",
                model_id=MODEL_ID,
                duration_ms=duration_ms,
                prompt_version=_prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:
            log.warning("supervisor: trace emission failed: %s", exc)

    return {
        "agent": "supervisor",
        "role": role,
        "response": response_text,
        "invocationId": ctx.invocation_id,
        "toolCalls": ctx.project_tool_calls(),
    }


def _invoke_with_retry(agent: Agent, input_text: str, messages=None):
    """Invoke the agent, retrying on Nova's transient modelStreamErrorException."""
    last_exc: Exception | None = None
    for attempt in range(1, MODEL_STREAM_RETRY_ATTEMPTS + 1):
        try:
            if messages:
                return agent(input_text, messages=messages)
            else:
                return agent(input_text)
        except Exception as exc:
            msg = str(exc)
            if "modelStreamErrorException" not in msg and "invalid sequence" not in msg:
                raise
            last_exc = exc
            log.warning(
                "modelStreamErrorException on attempt %d/%d — retrying. %s",
                attempt, MODEL_STREAM_RETRY_ATTEMPTS, msg[:200],
            )
            time.sleep(1.0 * attempt)
    assert last_exc is not None
    raise last_exc


if __name__ == "__main__":
    app.run()
