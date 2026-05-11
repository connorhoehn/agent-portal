import json
import os

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")
PREFIX = os.environ.get("PROJECT_PREFIX", "orgiq")
MEMORY_ID = os.environ.get("MEMORY_ID", "")
GUARDRAIL_ID = os.environ.get("GUARDRAIL_ID", "")

_agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
_agentcore_runtime = boto3.client("bedrock-agentcore", region_name=REGION)

# Cache runtime IDs after first lookup to avoid repeated API calls
_runtime_id_cache: dict[str, str] = {}


def _get_runtime_id(agent_name: str) -> str:
    """Discover a sub-agent's runtime ID by name via the AgentCore API (cached)."""
    if agent_name in _runtime_id_cache:
        return _runtime_id_cache[agent_name]

    target_name = f"{PREFIX}_{agent_name.replace('-', '_')}"
    paginator = _agentcore.get_paginator("list_agent_runtimes") if hasattr(_agentcore, "get_paginator") else None

    try:
        if paginator:
            for page in paginator.paginate():
                for runtime in page.get("agentRuntimeSummaries", []):
                    if runtime.get("agentRuntimeName") == target_name:
                        _runtime_id_cache[agent_name] = runtime["agentRuntimeId"]
                        return _runtime_id_cache[agent_name]
        else:
            response = _agentcore.list_agent_runtimes()
            for runtime in response.get("agentRuntimeSummaries", []):
                if runtime.get("agentRuntimeName") == target_name:
                    _runtime_id_cache[agent_name] = runtime["agentRuntimeId"]
                    return _runtime_id_cache[agent_name]
    except Exception:
        pass

    return ""


def _invoke_sub_agent(runtime_id: str, input_text: str, session_id: str = "") -> str:
    """Invoke a sub-agent via the AgentCore A2A invoke API."""
    kwargs = {
        "agentRuntimeId": runtime_id,
        "qualifier": "DEFAULT",
        "payload": json.dumps({"input_text": input_text}),
    }
    if session_id:
        kwargs["sessionId"] = session_id

    response = _agentcore_runtime.invoke_agent_runtime(**kwargs)

    # Response body is a streaming blob
    body = response.get("body", b"")
    if hasattr(body, "read"):
        body = body.read()
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")

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
    runtime_id = _get_runtime_id("search")
    if not runtime_id:
        return json.dumps({"error": "Search agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_id, query, session_id)


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
    runtime_id = _get_runtime_id("scoring")
    if not runtime_id:
        return json.dumps({"error": "Scoring agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_id, request, session_id)


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
    runtime_id = _get_runtime_id("advisor")
    if not runtime_id:
        return json.dumps({"error": "Advisor agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_id, question, session_id)


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
    runtime_id = _get_runtime_id("ingestion")
    if not runtime_id:
        return json.dumps({"error": "Ingestion agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_id, instruction, session_id)


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
    runtime_id = _get_runtime_id("graph-builder")
    if not runtime_id:
        return json.dumps({"error": "Graph-Builder agent not deployed — deploy with --context deployRuntimes=true"})
    return _invoke_sub_agent(runtime_id, instruction, session_id)


def _model_kwargs() -> dict:
    """Build BedrockModel kwargs, applying guardrail config when configured.

    GUARDRAIL_VERSION=DRAFT means "use the live editable spec" — UI edits go
    into effect on the very next InvokeModel call without rebuilding this image.
    """
    kw: dict = {"model_id": MODEL_ID}
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


_model = BedrockModel(**_model_kwargs())
_agent = Agent(
    model=_model,
    tools=[search_organization, get_expertise_scores, get_strategic_advice, ingest_documents, build_graph],
    system_prompt=(
        "You are the OrgIQ Supervisor agent — the primary interface for organizational intelligence queries.\n\n"
        "Route queries to the appropriate specialist:\n"
        "- search_organization: find people, expertise, documents, teams, decisions\n"
        "- get_expertise_scores: PageRank, leaderboards, influence metrics\n"
        "- get_strategic_advice: gap analysis, team composition, mentorship, collaboration\n"
        "- ingest_documents: sync new documents into the knowledge base\n"
        "- build_graph: update the knowledge graph from documents or manual input\n\n"
        "For complex queries, route to multiple specialists and synthesize their responses.\n"
        "Always cite which specialist provided each piece of information.\n"
        "Maintain conversation context across multi-turn interactions."
    ),
)


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

    result = _agent(input_text)
    return {"agent": "supervisor", "response": str(result)}


if __name__ == "__main__":
    app.run()
