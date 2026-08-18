import json
import logging
import os
import re
import sys
import time
from contextvars import ContextVar
from pathlib import Path

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.tools.browser_client import BrowserClient
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

try:
    import websocket as ws_client  # the `websocket-client` library
except ImportError:
    ws_client = None

# Shared instrumentation — pull TraceContext + decorator from agents/_shared.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.prompt_source import LiveAgent
from _shared.instrumentation import (  # noqa: E402
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    record_retrieval_documents,
    reset_active_ctx,
    retriever_span,
    set_active_ctx,
    short_prompt_hash,
    with_orgiq_root,
)

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer (see supervisor/main.py for the design note).
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "search_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
from _shared.kb_resolver import resolve_kb_id as _resolve_kb_id
KB_ID: str = _resolve_kb_id("orgiq", "default") or ""
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")
BROWSER_ID = os.environ.get("BROWSER_ID", "")

_bedrock = boto3.client("bedrock-agent-runtime", region_name=REGION)
_rds = boto3.client("rds-data", region_name=REGION)

_READONLY_RE = re.compile(r"^\s*(WITH|SELECT)\b", re.IGNORECASE)


def _records_to_dicts(resp: dict) -> list:
    cols = [c.get("name", f"col{i}") for i, c in enumerate(resp.get("columnMetadata", []))]
    out = []
    for record in resp.get("records", []):
        row = {}
        for col, cell in zip(cols, record):
            row[col] = list(cell.values())[0] if cell else None
        out.append(row)
    return out


@tool
@instrumented_tool(_current_ctx.get)
def query_knowledge_base(query: str, max_results: int = 5) -> str:
    """Search the organizational knowledge base for documents, expertise, and decisions.

    Args:
        query: Natural language search query
        max_results: Number of results to return (default 5, max 20)
    """
    with retriever_span("kb.retrieve", query) as r_span:
        response = _bedrock.retrieve(
            knowledgeBaseId=KB_ID,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": min(max_results, 20)}
            },
        )
        results = [
            {
                "content": r["content"]["text"],
                "score": round(r.get("score", 0.0), 4),
                "source": r.get("location", {}).get("s3Location", {}).get("uri", "unknown"),
            }
            for r in response.get("retrievalResults", [])
        ]
        record_retrieval_documents(r_span, results)
        return json.dumps(results, ensure_ascii=False)


@tool
@instrumented_tool(_current_ctx.get)
def query_graph(sql: str) -> str:
    """Execute a read-only SQL query against the OrgIQ relational graph in Aurora.

    Schema (see schema/orgiq_schema.sql):
      Nodes: people(id, name, email, title, team, expertise_score, ...)
             skills(id, name, domain)
             teams(id, name, parent_id)
             projects(id, name, status)
             decisions(id, topic, summary, decided_at)
             documents(id, source, source_uri, title)
      Edges: person_skills(person_id, skill_id, weight)
             team_memberships(person_id, team_id, role)
             collaborations(person_a_id, person_b_id, weight)
             project_contributions(person_id, project_id, role)
             decision_participants(person_id, decision_id, role)
             mentions(document_id, entity_type, entity_id, count)

    Example — find Kubernetes experts:
      SELECT p.name, p.email, COALESCE(p.expertise_score, 0) AS score
      FROM people p
      JOIN person_skills ps ON ps.person_id = p.id
      JOIN skills s ON s.id = ps.skill_id
      WHERE LOWER(s.name) LIKE '%kubernetes%'
      ORDER BY score DESC LIMIT 10

    Args:
        sql: PostgreSQL SELECT (or WITH ... SELECT) statement.

    Returns:
        JSON array of result rows keyed by column name.
    """
    if not _READONLY_RE.match(sql) or ";" in sql.strip().rstrip(";"):
        return json.dumps({"error": "Only single read-only SELECT/WITH statements are allowed."})

    response = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
        includeResultMetadata=True,
    )
    return json.dumps(_records_to_dicts(response), ensure_ascii=False, default=str)


# ── Browser tool (AgentCore Browser sandbox via SigV4-signed CDP) ─────────────

def _cdp_call(ws, method: str, params: dict | None = None, timeout_s: float = 10.0) -> dict:
    """Send a single CDP JSON-RPC command, wait for the response with matching id."""
    msg_id = int(time.time() * 1000) % 1_000_000
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        raw = ws.recv()
        msg = json.loads(raw)
        if msg.get("id") == msg_id:
            if "error" in msg:
                raise RuntimeError(f"CDP {method}: {msg['error']}")
            return msg.get("result", {})
    raise TimeoutError(f"CDP {method} timed out")


@tool
@instrumented_tool(_current_ctx.get)
def fetch_web_page(url: str) -> str:
    """Open a URL in an AgentCore Browser sandbox and return the page title and
    text content. Use this when you need to ground answers in fresh web content
    (e.g. competitor research, public profile lookups, doc pages).

    The sandbox is short-lived — each call spins up a fresh session, navigates,
    extracts the page, and closes the session. ~5-10s overhead per call.

    Args:
        url: The full URL to fetch (https://...)
    Returns:
        JSON: {"sessionId", "url", "title", "text"} (text truncated to 5000 chars)
        or {"error": "..."}
    """
    if not BROWSER_ID:
        return json.dumps({"error": "BROWSER_ID env var missing — browser sandbox unavailable"})
    if ws_client is None:
        return json.dumps({"error": "websocket-client package missing"})

    client = BrowserClient(region=REGION)
    started = False
    ws = None
    try:
        session_id = client.start(identifier=BROWSER_ID, name=f"search-{int(time.time())}")
        started = True

        ws_url, headers = client.generate_ws_headers()
        # websocket-client takes headers as a list of "Key: value" strings and
        # lets us suppress the auto-added ones, giving us tight control over
        # the SigV4-signed handshake.
        header_list = [f"{k}: {v}" for k, v in headers.items()
                       if k.lower() not in {"upgrade", "connection",
                                            "sec-websocket-version",
                                            "sec-websocket-key"}]

        ws = ws_client.create_connection(
            ws_url,
            header=header_list,
            suppress_origin=True,
            timeout=15,
        )

        # AgentCore Browser CDP requires attaching to a page target first
        # (multi-target flow). Discover and attach to the first 'page' target.
        targets = _cdp_call(ws, "Target.getTargets")
        page_target = next(
            (t for t in targets.get("targetInfos", []) if t.get("type") == "page"),
            None,
        )
        if not page_target:
            raise RuntimeError("No page target available in browser session")
        attach = _cdp_call(ws, "Target.attachToTarget", {
            "targetId": page_target["targetId"],
            "flatten": True,
        })
        cdp_session_id = attach.get("sessionId")

        def _cdp_target(method: str, params: dict | None = None, timeout_s: float = 15.0) -> dict:
            msg_id = int(time.time() * 1000) % 1_000_000
            ws.send(json.dumps({
                "sessionId": cdp_session_id,
                "id": msg_id,
                "method": method,
                "params": params or {},
            }))
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                ws.settimeout(max(0.1, deadline - time.time()))
                msg = json.loads(ws.recv())
                if msg.get("id") == msg_id and msg.get("sessionId") == cdp_session_id:
                    if "error" in msg:
                        raise RuntimeError(f"CDP {method}: {msg['error']}")
                    return msg.get("result", {})
            raise TimeoutError(f"CDP {method} timed out")

        _cdp_target("Page.navigate", {"url": url}, timeout_s=20.0)
        time.sleep(2.5)

        title_res = _cdp_target("Runtime.evaluate", {
            "expression": "document.title",
            "returnByValue": True,
        })
        text_res = _cdp_target("Runtime.evaluate", {
            "expression": "(document.body && document.body.innerText || '').slice(0, 5000)",
            "returnByValue": True,
        })

        title = (title_res.get("result") or {}).get("value", "") or ""
        text = (text_res.get("result") or {}).get("value", "") or ""

        return json.dumps({
            "sessionId": session_id,
            "url": url,
            "title": title,
            "text": text,
        })
    except Exception as e:
        return json.dumps({"error": f"browser error: {e}"})
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
        if started:
            try:
                client.stop()
            except Exception:
                pass


def _model_kwargs() -> dict:
    kw: dict = {
        "model_id": MODEL_ID,
        "temperature": float(os.environ.get("MODEL_TEMPERATURE", "0.1")),
        "max_tokens": int(os.environ.get("MODEL_MAX_TOKENS", "4096")),
    }
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


SYSTEM_PROMPT = (
    "You are the OrgIQ Search agent. Find people, teams, skills, documents, and "
    "decisions in the organizational knowledge base and relational graph.\n\n"
    "Tools:\n"
    "- query_knowledge_base: document/semantic search (use for 'tell me about', summaries, document content)\n"
    "- query_graph(sql): relational traversal via SQL (use for specific lookups, counts, rankings, relationships)\n"
    "- fetch_web_page(url): live external web content (only for genuinely external info)\n\n"
    "Schema (Aurora PostgreSQL):\n"
    "  people(id, name, title, department, expertise_score, pagerank_score, composite_score)\n"
    "  skills(id, name, category)\n"
    "  person_skills(person_id, skill_id, proficiency)\n"
    "  teams(id, name, department)\n"
    "  team_memberships(person_id, team_id, role)\n"
    "  projects(id, name, status, priority, department)\n"
    "  project_contributions(person_id, project_id, role, weight)\n"
    "  collaborations(source_id, target_id, weight, context)\n"
    "  decisions(id, title, status, decided_at)\n"
    "  decision_participants(decision_id, person_id, role)\n"
    "  documents(id, title, doc_type, author_id)\n"
    "  mentions(document_id, person_id, context)\n\n"
    "Example queries:\n"
    "- Find experts: SELECT p.name, p.title, ps.proficiency FROM people p "
    "JOIN person_skills ps ON ps.person_id = p.id "
    "JOIN skills s ON s.id = ps.skill_id "
    "WHERE LOWER(s.name) LIKE '%kubernetes%' ORDER BY ps.proficiency DESC\n"
    "- Person's projects: SELECT p.name, proj.name AS project, pc.role FROM people p "
    "JOIN project_contributions pc ON pc.person_id = p.id "
    "JOIN projects proj ON proj.id = pc.project_id "
    "WHERE LOWER(p.name) LIKE '%sarah%'\n"
    "- Person's collaborators: SELECT p2.name, c.weight, c.context FROM people p1 "
    "JOIN collaborations c ON c.source_id = p1.id "
    "JOIN people p2 ON p2.id = c.target_id "
    "WHERE LOWER(p1.name) LIKE '%sarah%' ORDER BY c.weight DESC\n"
    "- Team members: SELECT p.name, tm.role FROM people p "
    "JOIN team_memberships tm ON tm.person_id = p.id "
    "JOIN teams t ON t.id = tm.team_id "
    "WHERE LOWER(t.name) LIKE '%platform%'\n"
    "- Person's skills: SELECT s.name, s.category, ps.proficiency FROM skills s "
    "JOIN person_skills ps ON ps.skill_id = s.id "
    "JOIN people p ON p.id = ps.person_id "
    "WHERE LOWER(p.name) LIKE '%theo%' ORDER BY ps.proficiency DESC\n\n"
    "IMPORTANT: Always use query_graph for relationship questions (projects, collaborators, "
    "skills, teams). Use LOWER() and LIKE for name matching. "
    "Always return source citations. Combine tools for comprehensive answers."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

_model = BedrockModel(**_model_kwargs())
# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-search-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = LiveAgent(
    baked=SYSTEM_PROMPT,
    agent_name="search",
    build=lambda system_prompt: Agent(
        model=_model,
        tools=[query_knowledge_base, query_graph, fetch_web_page],
        system_prompt=system_prompt,
    ),
)


@app.entrypoint
async def handle(payload: dict) -> dict:
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
        return {"agent": "search", "error": "missing input_text/prompt/message"}

    # ── Sprint 2 instrumentation ─────────────────────────────────────────────
    # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "Search handling (invocation=%s, parent=%s): %s",
        ctx.invocation_id, ctx.parent_invocation_id or "—", input_text[:120],
    )

    t0 = time.monotonic()
    try:
        with with_orgiq_root(
            ctx,
            agent_id="orgiq-search",
            agent_name="Search",
            prompt_version=_agent.prompt_sha,
        ):
            result = _agent(input_text)
    finally:
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
    duration_ms = int((time.monotonic() - t0) * 1000)

    response_text = str(result)

    try:
        bundle = ctx.build_trace_bundle(
            prompt=input_text,
            response=response_text,
            agent_id="orgiq-search",
            agent_name="Search",
            model_id=MODEL_ID,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("search: trace emission failed: %s", exc)

    return {
        "agent": "search",
        "response": response_text,
        "invocationId": ctx.invocation_id,
        "toolCalls": ctx.project_tool_calls(),
    }


if __name__ == "__main__":
    app.run()
