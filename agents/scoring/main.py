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
from _shared.agui_stream import stream_agui, wants_stream  # noqa: E402
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
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer (see supervisor/main.py for the design note).
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "scoring_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
# DE-3: the model comes from the central registry (SSM /orgiq/models/registry,
# written from infra/config/model-registry.json), then the MODEL_ID env var,
# then the literal below. MODEL_ID is the import-time view; every turn
# re-resolves (60 s cache) and may fall back on capacity errors, so traces
# record _agent.model_id, the id actually served.
MODEL_ROLE = "scoring"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": 0.1, "default_max_tokens": 4096}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id
PREFIX = os.environ.get("PROJECT_PREFIX", "orgiq")
SCORES_TABLE = f"{PREFIX}-scores"
CODE_INTERPRETER_ID = os.environ.get("CODE_INTERPRETER_ID", "")

_rds = boto3.client("rds-data", region_name=REGION)
_dynamo = boto3.client("dynamodb", region_name=REGION)
_agentcore_data = boto3.client("bedrock-agentcore", region_name=REGION)

# ContextVar isolates the sandbox log per async invocation — no race between
# concurrent requests handled by the same event loop iteration.
_sandbox_log: ContextVar[list[dict]] = ContextVar("sandbox_log", default=[])


def _exec_sql(sql: str, parameters: list | None = None) -> dict:
    kwargs = dict(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
    )
    if parameters:
        kwargs["parameters"] = parameters
    return _rds.execute_statement(**kwargs)


def _p(name: str, value) -> dict:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, float):
        return {"name": name, "value": {"doubleValue": value}}
    return {"name": name, "value": {"stringValue": str(value)}}


def _records_to_rows(resp: dict) -> list:
    """Flatten RDS Data API columnar output into a list of value-only rows."""
    rows = []
    for record in resp.get("records", []):
        rows.append([list(cell.values())[0] if cell else None for cell in record])
    return rows


# In-degree across all edge tables. The CTE union mirrors what Cypher's
# `(p)<-[r]-()` traversal used to do — every edge that points at a Person
# contributes one inbound count.
_IN_DEGREE_CTE = """
WITH inbound AS (
  SELECT person_id   AS target_id, weight FROM person_skills
  UNION ALL
  SELECT person_id   AS target_id, weight FROM team_memberships
  UNION ALL
  SELECT person_id   AS target_id, weight FROM project_contributions
  UNION ALL
  SELECT person_id   AS target_id, weight FROM decision_participants
  UNION ALL
  SELECT person_a_id AS target_id, weight FROM collaborations
  UNION ALL
  SELECT person_b_id AS target_id, weight FROM collaborations
  UNION ALL
  SELECT entity_id   AS target_id, count::numeric AS weight
    FROM mentions WHERE entity_type = 'person'
)
"""


@tool
@instrumented_tool(_current_ctx.get)
def compute_expertise_scores(topic: str = "", limit: int = 20) -> str:
    """Compute weighted in-degree centrality as a PageRank proxy and persist scores.

    Counts all inbound edges per person (skill, team, project, decision, collaboration,
    mention) weighted by edge weight. Normalized 0-100 and written back to
    people.expertise_score plus snapshotted to DynamoDB.

    Args:
        topic: Optional skill name/domain filter (substring match, case-insensitive)
        limit: Maximum number of ranked people to return (default 20)
    """
    if topic:
        sql = _IN_DEGREE_CTE + """
        SELECT p.id, p.name, COALESCE(SUM(i.weight), 0) AS score
          FROM people p
          JOIN person_skills ps ON ps.person_id = p.id
          JOIN skills s ON s.id = ps.skill_id
          LEFT JOIN inbound i ON i.target_id = p.id
         WHERE LOWER(s.name) LIKE LOWER(:topic)
            OR LOWER(s.domain) LIKE LOWER(:topic)
         GROUP BY p.id, p.name
         ORDER BY score DESC
         LIMIT :limit
        """
        params = [_p("topic", f"%{topic}%"), _p("limit", int(limit))]
    else:
        sql = _IN_DEGREE_CTE + """
        SELECT p.id, p.name, COALESCE(SUM(i.weight), 0) AS score
          FROM people p
          LEFT JOIN inbound i ON i.target_id = p.id
         GROUP BY p.id, p.name
         ORDER BY score DESC
         LIMIT :limit
        """
        params = [_p("limit", int(limit))]

    rows = _records_to_rows(_exec_sql(sql, parameters=params))
    if not rows:
        return json.dumps([])

    max_score = max(float(r[2]) for r in rows) or 1.0
    snapshot_time = int(time.time())
    results = []

    for person_id, name, raw_score in rows:
        person_id, name, raw_score = str(person_id), str(name), float(raw_score)
        normalized = round((raw_score / max_score) * 100, 2)

        _exec_sql(
            "UPDATE people SET expertise_score = :score, scored_at = NOW() WHERE id = :id",
            parameters=[_p("score", normalized), _p("id", person_id)],
        )

        try:
            _dynamo.put_item(
                TableName=SCORES_TABLE,
                Item={
                    "pk": {"S": f"PERSON#{person_id}"},
                    "sk": {"S": f"SNAPSHOT#{snapshot_time}"},
                    "name": {"S": name},
                    "raw_score": {"N": str(raw_score)},
                    "normalized_score": {"N": str(normalized)},
                    "topic": {"S": topic or "all"},
                    "timestamp": {"N": str(snapshot_time)},
                },
            )
        except Exception:
            pass  # DynamoDB snapshot is best-effort

        results.append(
            {"id": person_id, "name": name, "score": raw_score, "normalized_score": normalized}
        )

    return json.dumps(results, ensure_ascii=False)


@tool
@instrumented_tool(_current_ctx.get)
def get_scores(person_id: str = "", topic: str = "", limit: int = 10) -> str:
    """Retrieve the most recent expertise score snapshots from DynamoDB.

    Args:
        person_id: Filter to a specific person (optional)
        topic: Filter to a specific topic/domain (optional)
        limit: Maximum results (default 10)
    """
    if person_id:
        response = _dynamo.query(
            TableName=SCORES_TABLE,
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": f"PERSON#{person_id}"}},
            ScanIndexForward=False,
            Limit=limit,
        )
    else:
        response = _dynamo.scan(TableName=SCORES_TABLE, Limit=limit * 3)

    items = response.get("Items", [])
    results = [
        {
            "id": item.get("pk", {}).get("S", "").replace("PERSON#", ""),
            "name": item.get("name", {}).get("S", ""),
            "normalized_score": float(item.get("normalized_score", {}).get("N", 0)),
            "topic": item.get("topic", {}).get("S", "all"),
            "timestamp": int(item.get("timestamp", {}).get("N", 0)),
        }
        for item in items
    ]
    if topic:
        results = [r for r in results if r["topic"] == topic]
    results.sort(key=lambda x: x["normalized_score"], reverse=True)
    return json.dumps(results[:limit], ensure_ascii=False)


@tool
@instrumented_tool(_current_ctx.get)
def get_leaderboard(team: str = "", skill: str = "", limit: int = 10) -> str:
    """Generate an expertise leaderboard, optionally filtered by team and/or skill.

    Reads live people.expertise_score (populated by compute_expertise_scores).

    Args:
        team: Filter to members of a specific team name (optional)
        skill: Filter to people with a skill matching this name (optional)
        limit: Number of leaderboard entries (default 10)
    """
    where = ["p.expertise_score IS NOT NULL"]
    joins = []
    params: list[dict] = [_p("limit", int(limit))]

    if team:
        joins.append("JOIN team_memberships tm ON tm.person_id = p.id")
        joins.append("JOIN teams t ON t.id = tm.team_id")
        where.append("LOWER(t.name) = LOWER(:team)")
        params.append(_p("team", team))

    if skill:
        joins.append("JOIN person_skills ps ON ps.person_id = p.id")
        joins.append("JOIN skills s ON s.id = ps.skill_id")
        where.append("(LOWER(s.name) LIKE LOWER(:skill) OR LOWER(s.domain) LIKE LOWER(:skill))")
        params.append(_p("skill", f"%{skill}%"))

    sql = (
        "SELECT DISTINCT p.id, p.name, COALESCE(p.expertise_score, 0) AS score "
        "FROM people p "
        + " ".join(joins)
        + " WHERE " + " AND ".join(where)
        + " ORDER BY score DESC LIMIT :limit"
    )

    rows = _records_to_rows(_exec_sql(sql, parameters=params))
    leaderboard = [
        {"rank": i + 1, "id": str(r[0]), "name": str(r[1]), "score": float(r[2])}
        for i, r in enumerate(rows)
    ]
    return json.dumps(leaderboard, ensure_ascii=False)


@tool
@instrumented_tool(_current_ctx.get)
def run_in_sandbox(python_code: str) -> str:
    """Execute a Python snippet inside the AgentCore code-interpreter sandbox.

    Use this for numerical computation, statistics, custom centrality formulas,
    or anything more naturally expressed in Python than SQL. The sandbox has
    Python 3 + numpy/pandas but NO network access — embed any input data as
    constants inside the code. Print results to stdout; the captured stdout
    is returned to you.

    Args:
        python_code: A complete Python program. Use print() to surface results.
    Returns:
        JSON with the captured stdout, or an error message.
    """
    if not CODE_INTERPRETER_ID:
        return json.dumps({"error": "CODE_INTERPRETER_ID env var is missing — sandbox unavailable"})

    session_id = ""
    started = time.time()
    try:
        start = _agentcore_data.start_code_interpreter_session(
            codeInterpreterIdentifier=CODE_INTERPRETER_ID,
            name=f"scoring-sandbox-{int(time.time())}",
        )
        session_id = start.get("sessionId", "")

        resp = _agentcore_data.invoke_code_interpreter(
            codeInterpreterIdentifier=CODE_INTERPRETER_ID,
            sessionId=session_id,
            name="executeCode",
            arguments={"code": python_code, "language": "python"},
        )

        # Consume the streaming response.
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
        entry = {
            "code": python_code,
            "output": output,
            "durationMs": int((time.time() - started) * 1000),
            "sessionId": session_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _sandbox_log.get().append(entry)
        return json.dumps({"sessionId": session_id, "output": output})
    except Exception as e:
        err_output = f"sandbox error: {e}"
        entry = {
            "code": python_code,
            "output": err_output,
            "durationMs": int((time.time() - started) * 1000),
            "sessionId": session_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error": str(e),
        }
        _sandbox_log.get().append(entry)
        return json.dumps({"error": err_output, "sessionId": session_id})
    finally:
        if session_id:
            try:
                _agentcore_data.stop_code_interpreter_session(
                    codeInterpreterIdentifier=CODE_INTERPRETER_ID,
                    sessionId=session_id,
                )
            except Exception:
                pass


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
    "You are the OrgIQ Scoring agent. Compute and report expertise scores, "
    "leaderboards, and influence metrics.\n\n"
    "Scoring approach: weighted in-degree centrality across all edge tables "
    "(person_skills, team_memberships, project_contributions, decision_participants, "
    "collaborations, mentions). Scores are normalized 0-100.\n\n"
    "Use compute_expertise_scores to (re)run scoring, optionally filtered by topic.\n"
    "Use get_leaderboard for current rankings (reads people.expertise_score).\n"
    "Use get_scores for historical snapshots from DynamoDB.\n"
    "Use run_in_sandbox for any computation that's clearer in Python than SQL — "
    "PageRank variants, statistical tests, custom centrality formulas, "
    "or post-processing of leaderboard data. Always pass any data the snippet "
    "needs as inline constants because the sandbox has no Aurora access.\n\n"
    "Always explain the scoring methodology when presenting results."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-scoring-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = RegistryAgent(
    role=MODEL_ROLE,
    **_MODEL_DEFAULTS,
    baked=SYSTEM_PROMPT,
    agent_name="scoring",
    build=lambda system_prompt, model_id: Agent(
        model=BedrockModel(**_model_kwargs(model_id)),
        tools=[compute_expertise_scores, get_scores, get_leaderboard, run_in_sandbox],
        system_prompt=system_prompt,
    ),
)


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    token = _sandbox_log.set([])  # fresh list scoped to this invocation's context
    try:
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
            return {"agent": "scoring", "error": "missing input_text/prompt/message"}

        # Genuine AG-UI streaming when the caller asked for it — the middleware
        # sets "stream": true for user-facing invocations. A2A sub-agent calls
        # from the supervisor do not, and keep the synchronous dict path below,
        # which is what they expect to receive.
        # ``scoped_vars`` re-establishes _sandbox_log inside the generator: the
        # ``finally`` below resets it the moment this returns, which is before
        # the stream has run a single tool.
        if wants_stream(payload):
            return stream_agui(
                payload=payload,
                input_text=input_text,
                live_agent=_agent,
                agent_id="orgiq-scoring",
                agent_name="Scoring",
                model_id=_agent.model_id,
                ctx_var=_current_ctx,
                scoped_vars=[(_sandbox_log, [])],
            )

        # ── Sprint 2 instrumentation ─────────────────────────────────────────
        # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
        ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
        ctx_token = _current_ctx.set(ctx)
        shared_token = set_active_ctx(ctx)

        log.info(
            "Scoring handling (invocation=%s, parent=%s): %s",
            ctx.invocation_id, ctx.parent_invocation_id or "—", text_fingerprint(input_text),
        )

        with with_orgiq_root(
            ctx,
            agent_id="orgiq-scoring",
            agent_name="Scoring",
            prompt_version=_agent.prompt_sha,
            model_id=_agent.model_id,
            model_registry_version=_agent.registry_version or None,
        ) as oi_span:  # noqa: F841 — oi_span reserved for future guardrail stamping
            t0 = time.monotonic()
            try:
                result = _agent(input_text)
            finally:
                _current_ctx.reset(ctx_token)
                reset_active_ctx(shared_token)
            duration_ms = int((time.monotonic() - t0) * 1000)

            response_text = str(result)

            try:
                bundle = ctx.build_trace_bundle(
                    prompt=input_text,
                    response=response_text,
                    agent_id="orgiq-scoring",
                    agent_name="Scoring",
                    model_id=_agent.model_id,
                    duration_ms=duration_ms,
                    prompt_version=_agent.prompt_sha,
                )
                post_trace(bundle)
            except Exception as exc:  # noqa: BLE001
                log.warning("scoring: trace emission failed: %s", exc)

        executions = list(_sandbox_log.get())
        response: dict = {
            "agent": "scoring",
            "response": response_text,
            "invocationId": ctx.invocation_id,
            "toolCalls": ctx.project_tool_calls(),
        }
        if executions:
            response["sandboxExecutions"] = executions
        return attach_usage(response, ctx, _agent.model_id)
    finally:
        _sandbox_log.reset(token)


if __name__ == "__main__":
    app.run()
