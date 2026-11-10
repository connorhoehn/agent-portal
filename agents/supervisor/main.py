import hashlib
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
from _shared.invoke_auth import sign_identity, verified_identity  # noqa: E402
from _shared.model_registry import invoke_with_fallback, resolve_model  # noqa: E402
from _shared.agui_stream import with_usage  # noqa: E402
from _shared.instrumentation import (  # noqa: E402
    attach_usage,
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    record_guardrail_action,
    reset_active_ctx,
    set_active_ctx,
    short_prompt_hash,
    text_fingerprint,
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

# The verified caller of this invocation: (tenant, sub, conversation id), set
# by `handle()` from the signed auth block (_shared/invoke_auth.py) and read by
# `_invoke_sub_agent` to derive each sub-agent's runtime session server-side.
# None when the caller could not be verified: sub-agents then get a fresh
# session per call, never one a prompt or a payload chose.
_invoke_identity: ContextVar[tuple[str, str, str] | None] = ContextVar(
    "supervisor_invoke_identity", default=None
)


def _sub_agent_session_id(runtime_arn: str) -> str:
    """The sub-agent runtime session for this conversation, derived server-side.

    The model used to pass `session_id` as a tool argument, so a prompt could
    name another conversation's sub-agent session and continue it. Now it is a
    hash of the verified (tenant, caller, conversation) and the sub-agent, so it
    is stable for one conversation and unreachable from any other. ``""`` when
    there is no verified conversation.
    """
    ident = _invoke_identity.get()
    if not ident or not ident[2]:
        return ""
    tenant, sub, conversation = ident
    digest = hashlib.sha256(f"{tenant}|{sub}|{conversation}|{runtime_arn}".encode("utf-8")).hexdigest()
    return f"sub-{digest}"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
# DE-3: the model comes from the central registry (SSM /orgiq/models/registry,
# written from infra/config/model-registry.json), then the MODEL_ID env var,
# then the literal below. The literal moved from Nova Lite to Nova Pro: the
# deployed supervisor has always run Pro (CDK's fleet-wide MODEL_ID), so Pro is
# what users were served; Lite is now the registry's capacity fallback.
# MODEL_ID is the import-time view; each invocation re-resolves (60 s cache).
MODEL_ROLE = "supervisor"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": 0.0, "default_max_tokens": 4096}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id
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


def _invoke_sub_agent(runtime_arn: str, input_text: str) -> str:
    """Invoke a sub-agent over the AgentCore Runtime invoke API.

    NOT A2A, despite what this docstring said until 2026-09-16: the call below
    is ``bedrock-agentcore.invoke_agent_runtime`` against the sub-agent's own
    runtime ARN. A2A (``bedrock-agentcore[a2a]``) is a different transport the
    supervisor pins but does not use on this path — the distinction matters
    because a reader looking for the A2A wire will not find one, and because
    the topology edges below come from the threaded ``parentInvocationId``,
    not from any A2A protocol field. See docs/research-strands-graph-2026-09-16.md.

    Threads ``parentInvocationId`` from the supervisor's active TraceContext
    into the sub-agent's payload so the middleware can stitch the trace tree
    (supervisor invocation → sub-agent invocation). Sub-agents that have been
    instrumented (Sprint 2: search) will read this field via
    ``TraceContext.from_request_payload`` and stamp it on their own trace.
    Sub-agents not yet instrumented just ignore the extra field.
    """
    payload_obj: dict = {"input_text": input_text}
    ident = _invoke_identity.get()
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
    # The verified caller, re-signed for the sub-agent: the read agents filter
    # retrieval to its tenant (kb_resolver.caller_tenant reads only a verified
    # block). Set last, after every other field. Absent when the caller is
    # unverified, which the sub-agent reads as the least-privileged home tenant.
    if ident and ident[0]:
        handed: dict = {"tenant": ident[0]}
        if ident[1]:
            handed["sub"] = ident[1]
        payload_obj["auth"] = handed
        sig = sign_identity(handed, payload_obj.get("sessionId") or "")
        if sig:
            payload_obj["authSig"] = sig
    kwargs: dict = {
        "agentRuntimeArn": runtime_arn,
        "qualifier": "DEFAULT",
        "payload": json.dumps(payload_obj),
    }
    session_id = _sub_agent_session_id(runtime_arn)
    if session_id:
        kwargs["runtimeSessionId"] = session_id

    log.info("Invoking sub-agent ARN=%s session=%s input %s", runtime_arn,
             "derived" if session_id else "(fresh)", text_fingerprint(input_text))

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

    log.info("Sub-agent response %s", text_fingerprint(str(body)))

    try:
        parsed = json.loads(body)
        return parsed.get("response", body)
    except json.JSONDecodeError:
        return body


@tool
@instrumented_tool(_current_ctx.get)
def search_organization(query: str) -> str:
    """Route a search query to the Search agent for KB + graph retrieval.

    Use for: finding people, expertise, documents, decisions, team information.

    Args:
        query: Natural language search query

    Returns:
        Search results from KB and organizational graph
    """
    runtime_arn = _get_runtime_arn("search")
    if not runtime_arn:
        return json.dumps({"error": "Search agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, query)


@tool
@instrumented_tool(_current_ctx.get)
def get_expertise_scores(request: str) -> str:
    """Route a scoring request to the Scoring agent for expertise metrics and leaderboards.

    Use for: PageRank scores, expertise rankings, team leaderboards, influence metrics.

    Args:
        request: Scoring request (e.g. 'top ML experts', 'score team Platform Engineering')

    Returns:
        Expertise scores and ranking results
    """
    runtime_arn = _get_runtime_arn("scoring")
    if not runtime_arn:
        return json.dumps({"error": "Scoring agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, request)


@tool
@instrumented_tool(_current_ctx.get)
def get_strategic_advice(question: str) -> str:
    """Route a strategic question to the Advisor agent for org intelligence recommendations.

    Use for: expertise gap analysis, team composition advice, mentorship suggestions,
    collaboration opportunities, knowledge transfer planning.

    Args:
        question: Strategic question about the organization

    Returns:
        Strategic recommendations grounded in graph data
    """
    runtime_arn = _get_runtime_arn("advisor")
    if not runtime_arn:
        return json.dumps({"error": "Advisor agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, question)


@tool
@instrumented_tool(_current_ctx.get)
def ingest_documents(instruction: str) -> str:
    """Route a document ingestion task to the Ingestion agent.

    Use for: uploading new documents, syncing the knowledge base, checking ingestion status.

    Args:
        instruction: Ingestion instruction (e.g. 'sync KB', 'list pending documents')

    Returns:
        Ingestion status and results
    """
    runtime_arn = _get_runtime_arn("ingestion")
    if not runtime_arn:
        return json.dumps({"error": "Ingestion agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, instruction)


@tool
@instrumented_tool(_current_ctx.get)
def build_graph(instruction: str) -> str:
    """Route a graph construction task to the Graph-Builder agent.

    Use for: extracting entities from documents, updating the knowledge graph,
    adding people/skills/relationships manually.

    Args:
        instruction: Graph-building instruction or document text to process

    Returns:
        Graph construction results with counts of nodes and relationships created
    """
    runtime_arn = _get_runtime_arn("graph-builder")
    if not runtime_arn:
        return json.dumps({"error": "Graph-Builder agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_arn, instruction)


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
    "Call the most relevant tool immediately. Synthesize the response concisely.\n"
    # A live turn ended with "*Source: Scoring specialist*" — the supervisor
    # citing its own sub-agent. That is our topology leaking into the user's
    # citation line, not evidence. Provenance is derived from the observed tool
    # calls and rendered as chips by the portal, so the model should not invent
    # one; a document URI is the only citation it can add that we cannot derive.
    "CITATIONS: never name a tool, a specialist or an agent as a source — no "
    "'Source: Scoring specialist', no 'Sources: Relational graph'. Where the "
    "answer came from is recorded automatically. Pass through a specialist's "
    "[Source: s3://...] document citation unchanged; otherwise write none."
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
KNOWN_TENANTS = frozenset({"orgiq"})

# Roles without a guardrail of their own borrow one: the cross-tenant admin
# gets hr-admin's (the least restrictive — denies only Health topics).
GUARDRAIL_ROLE_FALLBACK: dict[str, str] = {
    "admin": "hr-admin",
}


def _model_kwargs(guardrail_id: str = "", model_id: str | None = None) -> dict:
    """Build BedrockModel kwargs with the role-specific guardrail attached.

    GUARDRAIL_VERSION=DRAFT means "use the live editable spec" — UI edits go
    into effect on the very next InvokeModel call without rebuilding this image.
    """
    resolved = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)
    kw: dict = {"model_id": model_id or resolved.model_id}
    if resolved.temperature is not None:
        kw["temperature"] = resolved.temperature
    if resolved.max_tokens is not None:
        kw["max_tokens"] = resolved.max_tokens
    gid = guardrail_id or os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


def _build_agent(guardrail_id: str, system_prompt: str, model_id: str | None = None) -> Agent:
    return Agent(
        model=BedrockModel(**_model_kwargs(guardrail_id, model_id)),
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
# The registry model (id, temperature, max tokens) each cached agent was built
# with; a registry edit rebuilds on the next invocation, like a prompt edit.
_MODEL_BY_KEY: dict[tuple[str, str], tuple] = {}


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
    model = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)
    model_key = (model.model_id, model.temperature, model.max_tokens)
    if (
        _PROMPT_SHA_BY_KEY.get(key) != resolved.sha
        or _MODEL_BY_KEY.get(key) != model_key
        or key not in _AGENTS_BY_KEY
    ):
        agent = _build_agent(_ROLES.get(_guardrail_role(role), ""), resolved.text, model.model_id)
        # Keep the historical adapter name for orgiq so topology/session naming
        # stays stable; other tenants get a tenant-qualified name.
        suffix = role if tenant == DEFAULT_TENANT else f"{tenant}-{role}"
        _AGENTS_BY_KEY[key] = agent
        _AG_UI_AGENTS[key] = _build_ag_ui(suffix, agent)
        _PROMPT_SHA_BY_KEY[key] = resolved.sha
        _MODEL_BY_KEY[key] = model_key
        log.info(
            "Supervisor agent for tenant=%s role=%s built (guardrail_role=%s prompt source=%s sha=%s)",
            tenant, role, _guardrail_role(role), resolved.source, resolved.sha,
        )
    return _AGENTS_BY_KEY[key], _AG_UI_AGENTS[key], _PROMPT_SHA_BY_KEY[key]


log.info("Supervisor roles configured: %s", sorted(_ROLES.keys()))


def _resolve_identity(payload: dict) -> tuple[str, str]:
    """(tenant, role) for the caller. Unknown roles keep their name (the
    guardrail mapping in _agents_for_role maps them to the strictest, member,
    guardrail); an unrecognized or missing tenant falls back to orgiq.

    The auth block counts only when its signature verifies against the
    middleware's envelope (_shared/invoke_auth.py), or in dev mode without a
    secret. A payload with no block, or one that does not verify, is the
    least-privileged orgiq member AND logged: in normal operation the
    middleware always attaches a signed block, so anything else is a direct
    invoke that bypassed it. Also records the verified conversation for
    `_sub_agent_session_id`."""
    ident = verified_identity(payload) if isinstance(payload, dict) else None
    if ident is None:
        _invoke_identity.set(None)
        log.warning(
            "invoke payload has no verified auth block; defaulting to %s/%s (least privilege)",
            DEFAULT_TENANT, DEFAULT_ROLE,
        )
        return DEFAULT_TENANT, DEFAULT_ROLE
    auth = ident.auth
    role = auth.get("role")
    tenant = auth.get("tenant")
    resolved_tenant = tenant if isinstance(tenant, str) and tenant in KNOWN_TENANTS else DEFAULT_TENANT
    sub = auth.get("sub") if isinstance(auth.get("sub"), str) else ""
    _invoke_identity.set((resolved_tenant, sub, ident.conversation_id))
    return (
        resolved_tenant,
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


def _event_type(event) -> str:
    """AG-UI event type as a plain string.

    Tolerates the three shapes an event can arrive in: a pydantic event whose
    ``type`` is an ``EventType`` enum member, one where it is already a string,
    and a bare dict (some adapters/versions hand back plain dicts).
    """
    if isinstance(event, dict):
        raw = event.get("type")
    else:
        raw = getattr(event, "type", None)
    return str(getattr(raw, "value", raw) or "")


def _event_attr(event, name: str):
    """Tolerant field access, same two shapes as `_event_type`."""
    if isinstance(event, dict):
        return event.get(name)
    return getattr(event, name, None)


# Sub-agent routing tools whose TOOL_CALL_START/TOOL_CALL_RESULT pair should
# bracket a STEP_STARTED/STEP_FINISHED for the portal's run-phase stepper.
#
# Strands' Graph/Swarm multi-agent orchestration gets STEP events for free
# from `ag_ui_strands` (they fire off its multiagent_node_start/stop
# callbacks) — this supervisor instead routes to sub-agents with a
# hand-rolled `@tool` + `invoke_agent_runtime` call (`_invoke_sub_agent`
# above), which the adapter only ever sees as an ordinary tool call. No
# upstream code path emits a STEP event for that shape, so today's stream
# carries TOOL_CALL_* only (docs/research-agui-steps-2026-09-16.md). This
# map is the low-effort substitute: one synthesized step per sub-agent tool
# call, keyed off the tool name the model actually invoked.
# `run_in_sandbox` and `request_approval` are deliberately absent — neither
# routes to a sub-agent, so neither gets a step.
SUB_AGENT_STEP_NAMES: dict[str, str] = {
    "search_organization": "search",
    "get_expertise_scores": "scoring",
    "get_strategic_advice": "advisor",
    "ingest_documents": "ingestion",
    "build_graph": "graph-builder",
}


def _step_started_event(step_name: str):
    """STEP_STARTED for a sub-agent routing call, closed by `_step_finished_event`.

    Built the same defensive way as `_run_error_event` (falls back to a plain
    dict if the SDK ever renames the class) and yielded from inside the same
    ``async for event in ag_ui_agent.run(...)`` loop that forwards every other
    AG-UI event, so it reaches the SSE encoder in the same order, not via a
    side channel.
    """
    try:
        from ag_ui.core import EventType, StepStartedEvent

        return StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name)
    except Exception:  # noqa: BLE001
        return {"type": "STEP_STARTED", "step_name": step_name}


def _step_finished_event(step_name: str):
    """STEP_FINISHED matching `_step_started_event` — see its docstring."""
    try:
        from ag_ui.core import EventType, StepFinishedEvent

        return StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=step_name)
    except Exception:  # noqa: BLE001
        return {"type": "STEP_FINISHED", "step_name": step_name}


def _run_error_event(message: str, code: str = "supervisor_stream_error"):
    """Terminal AG-UI event for a stream that died partway through.

    A stream that just stops is indistinguishable, at the portal, from a short
    answer: the middleware only marks a run failed when it *sees* RUN_ERROR
    (`middleware/src/routes/agents.ts`), and nothing downstream reconstructs
    that from a truncated SSE body. So we say so explicitly before the
    exception leaves the generator.

    Falls back to a plain dict if the SDK ever renames the class — an
    unrecognised-but-present terminal event is still better than silence.
    """
    try:
        from ag_ui.core import EventType, RunErrorEvent

        return RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code)
    except Exception:  # noqa: BLE001
        return {"type": "RUN_ERROR", "message": message, "code": code}


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
    # Streaming serves the registry primary the cached agent was built with.
    _stream_model = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)
    t0 = time.monotonic()
    streamed_text: list[str] = []
    stream_error: str | None = None
    # tool_call_id -> step_name, for sub-agent routing calls currently in
    # flight. Closed on TOOL_CALL_RESULT (see the loop below); any survivors
    # when the stream dies are force-closed in the except block, so a step
    # that started always finishes.
    active_steps: dict[str, str] = {}

    # Everything from here on lives inside the try, so that *building* the
    # RunAgentInput is covered too: a ValidationError there used to escape
    # before the finally existed, leaving `_current_ctx` set to a dead context
    # and emitting neither a RUN_ERROR nor a trace. That is precisely the
    # failure mode the 2026-08 SDK drift produced.
    try:
        # Build AG-UI RunAgentInput from the middleware payload.
        # `or` rather than a .get() default: the middleware can send an explicit
        # null for either field, and `.get(k, default)` returns that null —
        # which is not a str, so RunAgentInput's pydantic model rejects the
        # entire run. Absent and null have to behave identically here.
        thread_id = payload.get("sessionId") or "default"
        # `runId` is the AG-UI run id the middleware minted for this stream
        # (routes/agents.ts sends it; the portal already holds it). Using it
        # here makes the adapter's RUN_STARTED, the portal's run and the trace
        # bundle one id — the P1 join (docs/pipelines-tenant-goal.md).
        run_id = (
            payload.get("runId")
            or payload.get("invocationId")
            or f"run-{time.time_ns()}"
        )
        ctx.run_id = run_id
        ctx.thread_id = thread_id

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
        # required fields on RunAgentInput (same 2026-08 SDK drift as the
        # Message `id` requirement above). Empty values are valid.
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
            "Supervisor AG-UI streaming (tenant=%s, role=%s, thread=%s, run=%s, invocation=%s): prompt %s",
            tenant, role, thread_id, run_id, ctx.invocation_id, text_fingerprint(input_text),
        )

        with with_orgiq_root(
            ctx,
            agent_id="orgiq-supervisor",
            agent_name="Supervisor",
            prompt_version=_prompt_sha,
            model_id=_stream_model.model_id,
            model_registry_version=_stream_model.version or None,
        ) as oi_span:
            async for event in ag_ui_agent.run(run_input):
                etype = _event_type(event)
                # Accumulate assistant text so the persisted trace carries
                # a real response snippet instead of an empty string.
                #
                # Only TEXT_MESSAGE_CONTENT. TOOL_CALL_ARGS carries a
                # `delta` too, so accumulating everything that merely *has*
                # one splices a tool's JSON arguments into the text stored
                # as the assistant's answer — and the transcript, the judge
                # and the canary then all score a reply the user never saw.
                if etype == "TEXT_MESSAGE_CONTENT":
                    delta = _event_attr(event, "delta")
                    if isinstance(delta, str) and delta:
                        streamed_text.append(delta)
                # The run's steps and attempts ride the trace bundle — every
                # event the portal sees is folded in, synthesized STEP_* below
                # included, so the recorded run is the streamed one.
                ctx.observe_agui_event(event)
                # The middleware prices the turn from a usage block on the
                # final event; observed above in its original shape so the
                # recorded run is untouched by the extra fields.
                yield (
                    with_usage(event, ctx, _stream_model.model_id)
                    if etype == "RUN_FINISHED" else event
                )

                # Synthesize STEP_STARTED/STEP_FINISHED around each sub-agent
                # routing call (SUB_AGENT_STEP_NAMES). TOOL_CALL_START fires
                # once the model finishes streaming the tool's *arguments* —
                # before `_invoke_sub_agent` has actually run — and
                # ag_ui_strands emits TOOL_CALL_END at that same point (args
                # complete), not when the tool returns. TOOL_CALL_RESULT is
                # the one event that only appears after the tool's Python
                # call has actually returned, so it — not TOOL_CALL_END — is
                # what closes the step; closing on END would show "finished"
                # while the sub-agent invocation is still in flight over the
                # network.
                if etype == "TOOL_CALL_START":
                    step_name = SUB_AGENT_STEP_NAMES.get(_event_attr(event, "tool_call_name"))
                    tool_call_id = _event_attr(event, "tool_call_id")
                    if step_name and tool_call_id:
                        active_steps[tool_call_id] = step_name
                        started = _step_started_event(step_name)
                        ctx.observe_agui_event(started)
                        yield started
                elif etype == "TOOL_CALL_RESULT":
                    tool_call_id = _event_attr(event, "tool_call_id")
                    step_name = active_steps.pop(tool_call_id, None) if tool_call_id else None
                    if step_name:
                        finished = _step_finished_event(step_name)
                        ctx.observe_agui_event(finished)
                        yield finished
            record_guardrail_action(oi_span, action=None, pii_detected=None)
    except Exception as exc:  # noqa: BLE001
        # Say it failed, then let it fail. The event is for the portal — a
        # stream that just stops reads there as a short answer, not an error;
        # the re-raise keeps the runtime's own error accounting honest.
        stream_error = str(exc) or type(exc).__name__
        log.exception("supervisor: AG-UI stream failed: %s", stream_error)
        # A step that started must finish: close any sub-agent step left open
        # by a stream that died mid-call, before the terminal RUN_ERROR, so
        # the portal's stepper doesn't hang on a step that will never
        # otherwise resolve.
        # Not folded into ctx: the RUN_ERROR below closes these steps as
        # `failed` in the recorded run — a step the stream abandoned did not
        # complete, whatever the portal's stepper needs to stop spinning.
        for step_name in active_steps.values():
            yield _step_finished_event(step_name)
        active_steps.clear()
        run_error = _run_error_event(stream_error)
        ctx.observe_agui_event(run_error)
        yield run_error
        raise
    finally:
        duration_ms = int((time.monotonic() - t0) * 1000)
        try:
            _current_ctx.reset(token)
        except ValueError:
            # Token minted in a different Context — possible if an async
            # generator is resumed from another task. Clearing outright still
            # stops a later tool call inheriting a finished invocation, which
            # is the property that matters.
            _current_ctx.set(None)
        reset_active_ctx(shared_token)
        # Persist the root trace for the streamed run. Sub-agent traces carry
        # parent_invocation_id == ctx.invocation_id, so this row is what the
        # A2A topology joins them to.
        # A failed run whose response, tokens, tools and guardrail signal are
        # all empty is dropped at the sink as a phantom row — the failure would
        # be invisible in observability. The error text is the substance that
        # keeps the row, and it names the reason.
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
                agent_id="orgiq-supervisor",
                agent_name="Supervisor",
                model_id=_stream_model.model_id,
                duration_ms=duration_ms,
                prompt_version=_prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:  # noqa: BLE001 — tracing must never break the stream
            log.warning("supervisor: streaming trace emission failed: %s", exc)


async def _handle_sync(payload: dict, input_text: str, role: str, tenant: str = DEFAULT_TENANT) -> dict:
    """Synchronous dict-return path for A2A sub-agent calls."""
    agent, _, _prompt_sha = _agents_for_role(role, tenant)
    _sync_model = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)
    served_model = _sync_model.model_id

    messages = []
    raw_history = payload.get("history", []) if isinstance(payload, dict) else []
    for turn in raw_history:
        if isinstance(turn, dict) and turn.get("role") and turn.get("content"):
            messages.append({"role": turn["role"], "content": [{"text": turn["content"]}]})

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "Supervisor sync handling (role=%s, invocation=%s, parent=%s, history_turns=%d): prompt %s",
        role, ctx.invocation_id, ctx.parent_invocation_id or "—", len(messages), text_fingerprint(input_text),
    )

    with with_orgiq_root(
        ctx,
        agent_id="orgiq-supervisor",
        agent_name="Supervisor",
        prompt_version=_prompt_sha,
        model_id=_sync_model.model_id,
        model_registry_version=_sync_model.version or None,
    ) as oi_span:
        t0 = time.monotonic()
        try:
            result, served_model = _invoke_with_model_fallback(
                agent, role, input_text, messages=messages if messages else None,
            )
            if oi_span is not None:
                try:
                    oi_span.set_attribute("orgiq.model_id", served_model)
                except Exception:  # noqa: BLE001 — provenance never breaks a turn
                    pass
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
                model_id=served_model,
                duration_ms=duration_ms,
                prompt_version=_prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:
            log.warning("supervisor: trace emission failed: %s", exc)

    return attach_usage(
        {
            "agent": "supervisor",
            "role": role,
            "response": response_text,
            "invocationId": ctx.invocation_id,
            "toolCalls": ctx.project_tool_calls(),
        },
        ctx,
        served_model,
    )


def _invoke_with_model_fallback(agent: Agent, role: str, input_text: str, messages=None):
    """Run the turn on the registry primary; on a capacity error (throttling,
    model not ready, unavailable) retry it on each fallback model in turn.
    Returns ``(result, model_id_served)``. A fallback agent is built for the
    turn only (same guardrail, same prompt) and is never cached, so the next
    invocation tries the primary again."""
    model = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)

    def run(model_id: str):
        if model_id == model.model_id:
            target = agent
        else:
            target = _build_agent(
                _ROLES.get(_guardrail_role(role), ""), agent.system_prompt, model_id,
            )
        return _invoke_with_retry(target, input_text, messages=messages)

    return invoke_with_fallback(run, model.chain)


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
