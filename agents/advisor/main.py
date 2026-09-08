import json
import logging
import os
import sys
import time
from contextvars import ContextVar
from pathlib import Path

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared instrumentation — pull TraceContext + decorator from agents/_shared.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.prompt_source import LiveAgent
from _shared.sql_guard import read_only_error  # noqa: E402
from _shared.db_credentials import (  # noqa: E402
    credential_diagnosis,
    read_secret_arn as _read_secret_arn,
)
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
    "advisor_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
from _shared.kb_resolver import resolve_kb_id as _resolve_kb_id
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
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")

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
def query_graph(sql: str) -> str:
    """Execute a read-only SQL query against the OrgIQ relational graph in Aurora.

    The schema (see schema/orgiq_schema.sql) models the org as relational tables:
      Nodes:  people, skills, teams, projects, decisions, documents
      Edges:  person_skills(person_id, skill_id, weight)
              team_memberships(person_id, team_id, role, weight)
              collaborations(person_a_id, person_b_id, weight)  -- canonical id ordering
              project_contributions(person_id, project_id, role, weight)
              decision_participants(person_id, decision_id, role, weight)
              mentions(document_id, entity_type, entity_id, count)

    Example patterns:
      Expertise gap (teams missing 'ML' skill):
        SELECT t.name FROM teams t
        WHERE NOT EXISTS (
          SELECT 1 FROM team_memberships tm
          JOIN person_skills ps ON ps.person_id = tm.person_id
          JOIN skills s ON s.id = ps.skill_id
          WHERE tm.team_id = t.id AND LOWER(s.name) LIKE '%ml%'
        )

      Skill breadth experts:
        SELECT p.name, COUNT(*) AS skill_count
        FROM people p JOIN person_skills ps ON ps.person_id = p.id
        GROUP BY p.id, p.name HAVING COUNT(*) > 5
        ORDER BY skill_count DESC

      Top collaborators:
        SELECT pa.name AS person_a, pb.name AS person_b, c.weight
        FROM collaborations c
        JOIN people pa ON pa.id = c.person_a_id
        JOIN people pb ON pb.id = c.person_b_id
        ORDER BY c.weight DESC LIMIT 10

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

    resp = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=GRAPH_READ_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
        includeResultMetadata=True,
    )
    return json.dumps(_records_to_dicts(resp), ensure_ascii=False, default=str)


@tool
@instrumented_tool(_current_ctx.get)
def retrieve_context(query: str, max_results: int = 5) -> str:
    """Retrieve supporting documents from the Bedrock Knowledge Base.

    Args:
        query: Topic or question to find supporting documentation for
        max_results: Number of documents to retrieve (default 5)
    """
    with retriever_span("kb.retrieve", query) as r_span:
        response = _bedrock.retrieve(
            knowledgeBaseId=KB_ID,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": min(max_results, 10)}
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
    "You are the OrgIQ Advisor agent. Provide strategic recommendations based on "
    "organizational graph analysis and document evidence.\n\n"
    "Data backend: Aurora PostgreSQL relational schema modeling the org as nodes "
    "(people/skills/teams/projects/decisions) plus edge tables. Use query_graph(sql) "
    "for SQL JOINs and CTE traversals; use retrieve_context for KB document search.\n\n"
    "Specialties:\n"
    "- Expertise gap analysis (skills missing on teams)\n"
    "- Knowledge silo detection (experts not connected to others)\n"
    "- Collaboration opportunity identification\n"
    "- Mentorship and succession planning\n"
    "- Team composition recommendations\n\n"
    "Always base recommendations on graph data and document evidence. Never speculate. "
    "Cite specific edges (e.g., 'team_memberships → person_skills') and source documents."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

_model = BedrockModel(**_model_kwargs())
# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-advisor-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = LiveAgent(
    baked=SYSTEM_PROMPT,
    agent_name="advisor",
    build=lambda system_prompt: Agent(
        model=_model,
        tools=[query_graph, retrieve_context],
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
        return {"agent": "advisor", "error": "missing input_text/prompt/message"}

    # ── Sprint 2 instrumentation ─────────────────────────────────────────────
    # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "Advisor handling (invocation=%s, parent=%s): %s",
        ctx.invocation_id, ctx.parent_invocation_id or "—", input_text[:120],
    )

    t0 = time.monotonic()
    try:
        with with_orgiq_root(
            ctx,
            agent_id="orgiq-advisor",
            agent_name="Advisor",
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
            agent_id="orgiq-advisor",
            agent_name="Advisor",
            model_id=MODEL_ID,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("advisor: trace emission failed: %s", exc)

    return {
        "agent": "advisor",
        "response": response_text,
        "invocationId": ctx.invocation_id,
        "toolCalls": ctx.project_tool_calls(),
    }


if __name__ == "__main__":
    app.run()
