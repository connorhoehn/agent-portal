import json
import logging
import os
import time

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")
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
    """Invoke a sub-agent via the AgentCore A2A invoke API."""
    kwargs: dict = {
        "agentRuntimeArn": runtime_arn,
        "qualifier": "DEFAULT",
        "payload": json.dumps({"input_text": input_text}),
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
    ingest_documents, build_graph, run_in_sandbox,
]

SYSTEM_PROMPT = (
    "You are the OrgIQ Supervisor agent — the primary interface for organizational intelligence queries.\n\n"
    "Route queries to the appropriate specialist:\n"
    "- search_organization: find people, expertise, documents, teams, decisions\n"
    "- get_expertise_scores: PageRank, leaderboards, influence metrics\n"
    "- get_strategic_advice: gap analysis, team composition, mentorship, collaboration\n"
    "- ingest_documents: sync new documents into the knowledge base\n"
    "- build_graph: update the knowledge graph from documents or manual input\n"
    "- run_in_sandbox: execute Python in a sandbox for calculations, statistics, or data manipulation\n\n"
    "For complex queries, route to multiple specialists and synthesize their responses.\n"
    "When a user asks you to compute, calculate, or run code, use run_in_sandbox.\n"
    "Always cite which specialist provided each piece of information.\n"
    "Maintain conversation context across multi-turn interactions."
)

# Per-role guardrail IDs, populated from env at module load. Middleware passes
# the caller's role in the invoke payload; we map it here to one of these.
ROLE_GUARDRAIL_IDS: dict[str, str] = {
    "member": os.environ.get("GUARDRAIL_ID_MEMBER", ""),
    "org-leader": os.environ.get("GUARDRAIL_ID_ORG_LEADER", ""),
    "hr-admin": os.environ.get("GUARDRAIL_ID_HR_ADMIN", ""),
}
DEFAULT_ROLE = "member"


def _model_kwargs(guardrail_id: str = "") -> dict:
    """Build BedrockModel kwargs with the role-specific guardrail attached.

    GUARDRAIL_VERSION=DRAFT means "use the live editable spec" — UI edits go
    into effect on the very next InvokeModel call without rebuilding this image.
    """
    kw: dict = {
        "model_id": MODEL_ID,
        "temperature": float(os.environ.get("MODEL_TEMPERATURE", "0.2")),
        "max_tokens": int(os.environ.get("MODEL_MAX_TOKENS", "2048")),
    }
    gid = guardrail_id or os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


def _build_agent(guardrail_id: str) -> Agent:
    return Agent(
        model=BedrockModel(**_model_kwargs(guardrail_id)),
        tools=SUPERVISOR_TOOLS,
        system_prompt=SYSTEM_PROMPT,
    )


# Cache one Agent per role. Falls back to single-guardrail mode if the per-role
# env vars aren't set (back-compat with pre-RBAC deployments).
_AGENTS_BY_ROLE: dict[str, Agent] = {}
for _role, _gid in ROLE_GUARDRAIL_IDS.items():
    if _gid:
        _AGENTS_BY_ROLE[_role] = _build_agent(_gid)
if not _AGENTS_BY_ROLE:
    _AGENTS_BY_ROLE[DEFAULT_ROLE] = _build_agent("")
log.info("Supervisor initialized with roles: %s", sorted(_AGENTS_BY_ROLE.keys()))


def _resolve_role(payload: dict) -> str:
    """Pick the agent for the caller. Unknown / missing roles fall back to member."""
    auth = payload.get("auth") if isinstance(payload, dict) else None
    role = (auth or {}).get("role") if isinstance(auth, dict) else None
    if role and role in _AGENTS_BY_ROLE:
        return role
    return DEFAULT_ROLE if DEFAULT_ROLE in _AGENTS_BY_ROLE else next(iter(_AGENTS_BY_ROLE))


@app.entrypoint
async def handle(payload: dict) -> dict:
    # Accept either {"input_text": "..."} (A2A convention used by sub-agent
    # invocations from the supervisor) or {"prompt"/"message": "..."} from
    # the CLI / middleware. Fall back to stringifying the whole payload.
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

    role = _resolve_role(payload if isinstance(payload, dict) else {})
    agent = _AGENTS_BY_ROLE[role]
    log.info("Supervisor handling (role=%s): %s", role, input_text[:120])
    result = _invoke_with_retry(agent, input_text)
    return {"agent": "supervisor", "role": role, "response": str(result)}


def _invoke_with_retry(agent: Agent, input_text: str):
    """Invoke the agent, retrying on Nova's transient modelStreamErrorException.

    Nova occasionally emits malformed tool-use token sequences during ConverseStream
    when the context grows. The failure is non-deterministic, so a fresh attempt
    usually succeeds. Other exceptions propagate unchanged.
    """
    last_exc: Exception | None = None
    for attempt in range(1, MODEL_STREAM_RETRY_ATTEMPTS + 1):
        try:
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
