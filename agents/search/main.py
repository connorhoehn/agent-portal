import json
import logging
import os
import sys
import time
from contextvars import ContextVar
from typing import AsyncIterator
from pathlib import Path

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared instrumentation — pull TraceContext + decorator from agents/_shared.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.model_registry import RegistryAgent, invoke_with_fallback, resolve_model
from _shared.untrusted_text import fence_results, with_data_rule  # noqa: E402
from _shared.agui_stream import stream_agui, wants_stream  # noqa: E402
from _shared.sql_guard import read_only_error  # noqa: E402
from _shared.result_size_guard import result_size_error  # noqa: E402
from _shared.db_credentials import (  # noqa: E402
    credential_diagnosis,
    read_secret_arn as _read_secret_arn,
)
from _shared.instrumentation import (  # noqa: E402
    attach_usage,
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    record_retrieval_documents,
    reset_active_ctx,
    retriever_span,
    set_active_ctx,
    short_prompt_hash,
    text_fingerprint,
    with_orgiq_root,
)

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer (see supervisor/main.py for the design note).
# The tenant this invocation retrieves for (kb_resolver.caller_tenant): one
# knowledge base holds every tenant's documents, so every retrieve is filtered
# to the caller's (kb_resolver.filter_for_tenant).
_caller_tenant: ContextVar[str] = ContextVar("search_caller_tenant", default="orgiq")

_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "search_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
from _shared.kb_resolver import resolve_kb_id as _resolve_kb_id
from _shared.kb_resolver import vector_search_config as _vector_search_config
from _shared.kb_resolver import tenant_vector_search_config as _tenant_vector_search_config  # noqa: E402
from _shared.kb_resolver import caller_tenant as _caller_tenant_of, filter_for_tenant as _filter_for_tenant  # noqa: E402
KB_ID: str = _resolve_kb_id("orgiq", "default") or ""
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
# Reads go through `orgiq_graph_reader` when it is configured — a role
# PostgreSQL will not let write. Falls back to the admin credential when it
# is not, which is every environment that has not yet applied
# schema/graph_readonly_role.sql. See _shared/db_credentials.py.
GRAPH_READ_SECRET_ARN = _read_secret_arn()
log.info("orgiq.db: %s", credential_diagnosis())
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
# DE-3: the model comes from the central registry (SSM /orgiq/models/registry,
# written from infra/config/model-registry.json), then the MODEL_ID env var,
# then the literal below. MODEL_ID is the import-time view; every turn
# re-resolves (60 s cache) and may fall back on capacity errors, so traces
# record _agent.model_id, the id actually served.
MODEL_ROLE = "search"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": 0.1, "default_max_tokens": 4096}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id

_bedrock = boto3.client("bedrock-agent-runtime", region_name=REGION)
_rds = boto3.client("rds-data", region_name=REGION)



def _records_to_dicts(resp: dict) -> list:
    cols = [c.get("name", f"col{i}") for i, c in enumerate(resp.get("columnMetadata", []))]
    out = []
    for record in resp.get("records", []):
        row = {}
        for col, cell in zip(cols, record):
            # An RDS Data API NULL arrives as {"isNull": True}. Taking the
            # first value blindly turns it into the boolean True, so a person
            # with no expertise_score reads back to the model as
            # `"expertise_score": true` — a value it will happily reason about.
            if not cell or cell.get("isNull"):
                row[col] = None
            else:
                row[col] = list(cell.values())[0]
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
                # Search type is pinned in _shared/kb_resolver — the Bedrock
                # default ranks this store's results worst-first.
                # Belt and braces: the tenant metadata filter here, the key-prefix
                # filter on the results below.
                "vectorSearchConfiguration": _tenant_vector_search_config(min(max_results, 20), _caller_tenant.get())
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
        results = _filter_for_tenant(results, _caller_tenant.get())
        record_retrieval_documents(r_span, results)
        # Retrieved text is untrusted: each passage fenced as data (_shared/untrusted_text.py).
        return json.dumps(fence_results(results), ensure_ascii=False)


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

    Only the node/edge tables listed above are readable — the query runs under a
    SELECT-only database role whose grant covers exactly them, so a query against
    any other table is refused by PostgreSQL. Writes of any kind are refused too.

    Args:
        sql: PostgreSQL SELECT (or WITH ... SELECT) statement.

    Returns:
        JSON array of result rows keyed by column name.
    """
    # Security boundary, not a style rule: the model writes this SQL and the
    # Data API role can write. See _shared/sql_guard.py — in particular the
    # data-modifying CTE (`WITH x AS (DELETE ... RETURNING *) SELECT * FROM x`)
    # that the old leading-keyword regex waved straight through.
    _err = read_only_error(sql)
    if _err:
        return json.dumps({"error": _err})

    # Braces, not just belt: when AURORA_READONLY_SECRET_ARN is set this runs
    # as `orgiq_graph_reader`, which holds SELECT on the graph tables and
    # nothing else, in a session pinned to default_transaction_read_only. A
    # write that somehow slipped past the guard above is refused by the engine.
    # NOTE the absence of a retry on the admin credential: a permission error
    # here means the grant was never applied, and falling back to a writable
    # login on an error an attacker can provoke would give away the boundary.

    try:
        response = _rds.execute_statement(
            resourceArn=AURORA_CLUSTER_ARN,
            secretArn=GRAPH_READ_SECRET_ARN,
            database=DB_NAME,
            sql=sql,
            includeResultMetadata=True,
        )
    except Exception as exc:  # noqa: BLE001 — only the size failure is special-cased
        # The RDS Data API terminates rather than truncates past ~1 MiB (64 KB
        # per row); see _shared/result_size_guard.py. Give the model a message
        # it can act on, same as the read-only rejection above. Anything else
        # re-raises unchanged — Strands' @tool wrapper turns it into a generic
        # tool-error result, today's behaviour.
        _size_err = result_size_error(exc)
        if _size_err:
            return json.dumps({"error": _size_err})
        raise
    return json.dumps(_records_to_dicts(response), ensure_ascii=False, default=str)


# ── No web fetch here ─────────────────────────────────────────────────────────
# This agent holds the org graph and the knowledge base. A web-fetch tool
# beside them lets a planted document steer the model into sending graph or
# KB content to an arbitrary URL, so the search agent has none. Live web
# content belongs to an agent that holds no org data.


def _model_kwargs(model_id: str | None = None) -> dict:
    resolved = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)
    kw: dict = {"model_id": model_id or resolved.model_id}
    if resolved.temperature is not None:
        kw["temperature"] = resolved.temperature
    if resolved.max_tokens is not None:
        kw["max_tokens"] = resolved.max_tokens
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
    "You have no web access: answer from the knowledge base and the graph only.\n\n"
    # Keep this block in step with `query_graph`'s docstring above and with
    # schema/orgiq_schema.sql. It drifted once — advertising `department`,
    # `skills.category`, `person_skills.proficiency`,
    # `collaborations.source_id/target_id/context`, `decisions.title`,
    # `documents.author_id` and `mentions.person_id`, none of which exist — so
    # every example below produced invalid SQL on the one path this literal is
    # for: the fallback taken when Prompt Management is unreachable.
    "Schema (Aurora PostgreSQL):\n"
    "  people(id, name, email, title, team, expertise_score, pagerank_score, composite_score)\n"
    "  skills(id, name, domain)\n"
    "  person_skills(person_id, skill_id, weight, source)\n"
    "  teams(id, name, parent_id)\n"
    "  team_memberships(person_id, team_id, role, weight)\n"
    "  projects(id, name, status, summary, description, owner_id, sponsor_person_id)\n"
    "  project_contributions(person_id, project_id, role, weight)\n"
    "  collaborations(person_a_id, person_b_id, weight, last_seen)\n"
    "  decisions(id, topic, summary, status, decided_at, resolution, project_id)\n"
    "  decision_participants(person_id, decision_id, role, weight)\n"
    "  documents(id, source, source_uri, title, doc_type, headline, published_at, section)\n"
    "  mentions(document_id, entity_type, entity_id, count)\n\n"
    "Notes: a person's team is the text column people.team (teams.parent_id is "
    "the org hierarchy). Edge strength is `weight` everywhere. A collaboration "
    "pair is unordered — match the person against BOTH person_a_id and "
    "person_b_id. mentions is polymorphic: filter entity_type ('person', "
    "'team', 'project', 'skill') and join entity_id to that table's id.\n\n"
    "Example queries:\n"
    "- Find experts: SELECT p.name, p.title, ps.weight FROM people p "
    "JOIN person_skills ps ON ps.person_id = p.id "
    "JOIN skills s ON s.id = ps.skill_id "
    "WHERE LOWER(s.name) LIKE '%kubernetes%' ORDER BY ps.weight DESC\n"
    "- Person's projects: SELECT p.name, proj.name AS project, pc.role FROM people p "
    "JOIN project_contributions pc ON pc.person_id = p.id "
    "JOIN projects proj ON proj.id = pc.project_id "
    "WHERE LOWER(p.name) LIKE '%sarah%'\n"
    "- Person's collaborators (the pair is unordered — match both sides): "
    "SELECT p2.name, c.weight FROM people p1 "
    "JOIN collaborations c ON p1.id IN (c.person_a_id, c.person_b_id) "
    "JOIN people p2 ON p2.id = CASE WHEN c.person_a_id = p1.id "
    "THEN c.person_b_id ELSE c.person_a_id END "
    "WHERE LOWER(p1.name) LIKE '%theo%' ORDER BY c.weight DESC\n"
    "- Team members: SELECT p.name, tm.role FROM people p "
    "JOIN team_memberships tm ON tm.person_id = p.id "
    "JOIN teams t ON t.id = tm.team_id "
    "WHERE LOWER(t.name) LIKE '%platform%'\n"
    "- Person's skills: SELECT s.name, s.domain, ps.weight FROM skills s "
    "JOIN person_skills ps ON ps.skill_id = s.id "
    "JOIN people p ON p.id = ps.person_id "
    "WHERE LOWER(p.name) LIKE '%theo%' ORDER BY ps.weight DESC\n"
    "- Documents mentioning a person: SELECT d.title, d.doc_type, m.count "
    "FROM documents d "
    "JOIN mentions m ON m.document_id = d.id "
    "JOIN people p ON p.id = m.entity_id AND m.entity_type = 'person' "
    "WHERE LOWER(p.name) LIKE '%theo%' ORDER BY m.count DESC\n\n"
    "IMPORTANT: Always use query_graph for relationship questions (projects, collaborators, "
    "skills, teams). Use LOWER() and LIKE for name matching. "
    "Combine tools for comprehensive answers.\n"
    # Citations: "Always return source citations" produced things like
    # "[Source: Search agent]" and "Sources: Relational graph" — an internal
    # component name presented to the user as evidence. The portal now derives
    # provenance from the tool calls it observed, so the only citation worth
    # writing is one it cannot derive: the s3 URI of a retrieved document.
    "CITATIONS: cite a document only by the exact s3:// URI from the "
    "query_knowledge_base `source` field, written as [Source: s3://...]. "
    "Never name a tool, an agent or a specialist as a source, and never write "
    "'Source: relational graph' — where the data came from is recorded "
    "automatically. If no document supports a claim, write no citation."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-search-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = RegistryAgent(
    role=MODEL_ROLE,
    **_MODEL_DEFAULTS,
    baked=SYSTEM_PROMPT,
    agent_name="search",
    build=lambda system_prompt, model_id: Agent(
        model=BedrockModel(**_model_kwargs(model_id)),
        tools=[query_knowledge_base, query_graph],
        system_prompt=with_data_rule(system_prompt),
    ),
)


async def _for_tenant(tenant: str, events):
    """Run a streamed turn with the caller's tenant set where retrieval reads it."""
    token = _caller_tenant.set(tenant)
    try:
        async for event in events:
            yield event
    finally:
        _caller_tenant.reset(token)


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
        return {"agent": "search", "error": "missing input_text/prompt/message"}

    # Genuine AG-UI streaming when the caller asked for it — the middleware
    # sets "stream": true for user-facing invocations. A2A sub-agent calls
    # from the supervisor do not, and keep the synchronous dict path below,
    # which is what they expect to receive.
    tenant = _caller_tenant_of(payload)
    if wants_stream(payload):
        return _for_tenant(tenant, stream_agui(
            payload=payload,
            input_text=input_text,
            live_agent=_agent,
            agent_id="orgiq-search",
            agent_name="Search",
            model_id=_agent.model_id,
            ctx_var=_current_ctx,
        ))

    # ── Sprint 2 instrumentation ─────────────────────────────────────────────
    # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)
    tenant_token = _caller_tenant.set(tenant)

    log.info(
        "Search handling (invocation=%s, parent=%s): %s",
        ctx.invocation_id, ctx.parent_invocation_id or "—", text_fingerprint(input_text),
    )

    t0 = time.monotonic()
    try:
        with with_orgiq_root(
            ctx,
            agent_id="orgiq-search",
            agent_name="Search",
            prompt_version=_agent.prompt_sha,
            model_id=_agent.model_id,
            model_registry_version=_agent.registry_version or None,
        ):
            result = _agent(input_text)
    finally:
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
        _caller_tenant.reset(tenant_token)
    duration_ms = int((time.monotonic() - t0) * 1000)

    response_text = str(result)

    try:
        bundle = ctx.build_trace_bundle(
            prompt=input_text,
            response=response_text,
            agent_id="orgiq-search",
            agent_name="Search",
            model_id=_agent.model_id,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("search: trace emission failed: %s", exc)

    return attach_usage(
        {
            "agent": "search",
            "response": response_text,
            "invocationId": ctx.invocation_id,
            "toolCalls": ctx.project_tool_calls(),
        },
        ctx,
        _agent.model_id,
    )


if __name__ == "__main__":
    app.run()
