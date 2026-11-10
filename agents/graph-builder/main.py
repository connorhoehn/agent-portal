import json
import logging
import os
import re
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
from _shared.untrusted_text import Fence, with_data_rule  # noqa: E402
from _shared.invoke_auth import verified_auth  # noqa: E402
from _shared.graph_extraction import (  # noqa: E402
    ENTITY_KINDS,
    caller_may_write,
    check_edge,
    check_extraction,
    check_node,
)
from _shared.agui_stream import stream_agui, wants_stream  # noqa: E402
from _shared.instrumentation import (  # noqa: E402
    attach_usage,
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
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
    "graph_builder_trace_ctx", default=None
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
MODEL_ROLE = "graph-builder"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": None, "default_max_tokens": None}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id
EMBED_MODEL = "amazon.titan-embed-text-v2:0"
CODE_INTERPRETER_ID = os.environ.get("CODE_INTERPRETER_ID", "")

_rds = boto3.client("rds-data", region_name=REGION)
_bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
_agentcore_data = boto3.client("bedrock-agentcore", region_name=REGION)

_sandbox_log: ContextVar[list[dict]] = ContextVar("sandbox_log", default=[])

# The verified caller of this invocation (``invoke_auth.verified_auth``), set
# by ``handle``. Every write tool asks ``_shared/graph_extraction.py`` whether
# this caller may write the graph (the orgiq tenant or the cross-tenant admin);
# with no verified caller nothing is written.
_caller_auth: ContextVar[dict | None] = ContextVar("graph_builder_caller_auth", default=None)


def _refused(kind: str, reason: str) -> str:
    return json.dumps({"refused": kind, "reason": reason})

# Each relationship label maps to the edge table that stores it.
# Cross-checked with schema/orgiq_schema.sql.
_REL_TABLES = {
    "HAS_SKILL":        ("person_skills",          "person_id", "skill_id"),
    "MEMBER_OF":        ("team_memberships",       "person_id", "team_id"),
    "WORKED_ON":        ("project_contributions",  "person_id", "project_id"),
    "MADE":             ("decision_participants",  "person_id", "decision_id"),
    "PARTICIPATED_IN":  ("decision_participants",  "person_id", "decision_id"),
}


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


def _p(name: str, value, type_hint: str | None = None) -> dict:
    """Build an RDS Data API parameter. Handles str/int/float/None."""
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, float):
        return {"name": name, "value": {"doubleValue": value}}
    return {"name": name, "value": {"stringValue": str(value)}}


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", value.lower().strip())


def _converse_text(resp: dict) -> str:
    """Concatenate the text blocks of a Bedrock Converse response.

    Why Converse and not InvokeModel: this agent's ``MODEL_ID`` is an
    AWS-native model (``amazon.nova-pro-v1:0`` by default), and the raw
    InvokeModel body is model-family specific — the Anthropic-shaped payload
    this used to send (``anthropic_version`` + a flat string ``content`` +
    ``max_tokens``) is a ValidationException against Nova, and the matching
    ``response["content"][0]["text"]`` read is the Anthropic response shape
    too. Converse is the model-agnostic surface, so this works for any model
    the fleet is pointed at, and it is the operation
    ``install_bedrock_usage_capture()`` watches — so these tokens now show up
    on the trace instead of vanishing.
    """
    blocks = ((resp.get("output") or {}).get("message") or {}).get("content") or []
    text = "".join(
        b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("text")
    )
    return text or "{}"


# ── Internal write steps ─────────────────────────────────────────────────────
# The merge_* functions and embed_and_store are NOT model tools. Their only
# caller is extract_and_build, which runs every element through
# check_extraction (_shared/graph_extraction.py) first: bounded fields, names
# found in the document, label pairs, weights 0-1 and edges only between
# accepted rows. Handing them to the model as tools would let document text
# that steers the model write past those checks, so MODEL_TOOLS below lists
# only extract_and_build and run_in_sandbox. The caller gate and shape checks
# stay here as a second line.


@instrumented_tool(_current_ctx.get)
def merge_person(person_id: str, name: str, email: str = "", team: str = "", role: str = "") -> str:
    """Upsert a Person row.

    Args:
        person_id: Unique identifier (e.g. 'alice_smith')
        name: Full display name
        email: Work email address (optional)
        team: Team or department name (optional)
        role: Job title / role (optional)

    Returns:
        JSON confirmation with row id
    """
    why = check_node("Person", person_id, name, _caller_auth.get())
    if why:
        return _refused("Person", why)
    safe = _safe_id(person_id)
    _exec_sql(
        """
        INSERT INTO people (id, name, email, title, team, updated_at)
        VALUES (:id, :name, :email, :title, :team, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name       = EXCLUDED.name,
          email      = COALESCE(NULLIF(EXCLUDED.email, ''), people.email),
          title      = COALESCE(NULLIF(EXCLUDED.title, ''), people.title),
          team       = COALESCE(NULLIF(EXCLUDED.team,  ''), people.team),
          updated_at = NOW()
        """,
        parameters=[
            _p("id", safe), _p("name", name),
            _p("email", email or ""), _p("title", role or ""), _p("team", team or ""),
        ],
    )
    return json.dumps({"merged": "Person", "id": safe})


@instrumented_tool(_current_ctx.get)
def merge_skill(skill_id: str, name: str, domain: str = "") -> str:
    """Upsert a Skill row.

    Args:
        skill_id: Unique identifier (e.g. 'kubernetes')
        name: Display name
        domain: Broader domain (e.g. 'Infrastructure', 'ML')

    Returns:
        JSON confirmation
    """
    why = check_node("Skill", skill_id, name, _caller_auth.get())
    if why:
        return _refused("Skill", why)
    safe = _safe_id(skill_id)
    _exec_sql(
        """
        INSERT INTO skills (id, name, domain)
        VALUES (:id, :name, :domain)
        ON CONFLICT (id) DO UPDATE SET
          name   = EXCLUDED.name,
          domain = COALESCE(NULLIF(EXCLUDED.domain, ''), skills.domain)
        """,
        parameters=[_p("id", safe), _p("name", name), _p("domain", domain or "")],
    )
    return json.dumps({"merged": "Skill", "id": safe})


@instrumented_tool(_current_ctx.get)
def merge_team(team_id: str, name: str) -> str:
    """Upsert a Team row."""
    why = check_node("Team", team_id, name, _caller_auth.get())
    if why:
        return _refused("Team", why)
    safe = _safe_id(team_id)
    _exec_sql(
        "INSERT INTO teams (id, name) VALUES (:id, :name) "
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
        parameters=[_p("id", safe), _p("name", name)],
    )
    return json.dumps({"merged": "Team", "id": safe})


@instrumented_tool(_current_ctx.get)
def merge_project(project_id: str, name: str, status: str = "") -> str:
    """Upsert a Project row."""
    why = check_node("Project", project_id, name, _caller_auth.get())
    if why:
        return _refused("Project", why)
    safe = _safe_id(project_id)
    _exec_sql(
        "INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) "
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "
        "status = COALESCE(NULLIF(EXCLUDED.status, ''), projects.status)",
        parameters=[_p("id", safe), _p("name", name), _p("status", status or "")],
    )
    return json.dumps({"merged": "Project", "id": safe})


@instrumented_tool(_current_ctx.get)
def merge_relationship(
    from_id: str,
    from_label: str,
    to_id: str,
    to_label: str,
    rel_type: str,
    weight: float = 1.0,
) -> str:
    """Upsert a relationship row in the appropriate edge table.

    Supported relationship types map to edge tables in schema/orgiq_schema.sql:
      HAS_SKILL        → person_skills
      MEMBER_OF        → team_memberships
      WORKED_ON        → project_contributions
      MADE             → decision_participants
      PARTICIPATED_IN  → decision_participants
      WORKED_WITH      → collaborations (canonical id ordering)

    Args:
        from_id: Source node id
        from_label: Source node label (Person, Team, Skill, Project, Decision)
        to_id: Target node id
        to_label: Target node label
        rel_type: Relationship type (UPPER_SNAKE_CASE)
        weight: Relationship strength 0.0-1.0 (default 1.0)
    """
    why = check_edge(rel_type, from_label, to_label, _caller_auth.get())
    if why:
        return _refused("relationship", why)
    from_safe = _safe_id(from_id)
    to_safe = _safe_id(to_id)
    rel = rel_type.upper().strip()

    if rel == "WORKED_WITH":
        a, b = sorted([from_safe, to_safe])
        if a == b:
            return json.dumps({"skipped": "self-loop", "id": a})
        _exec_sql(
            """
            INSERT INTO collaborations (person_a_id, person_b_id, weight, last_seen)
            VALUES (:a, :b, :weight, NOW())
            ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET
              weight    = GREATEST(collaborations.weight, EXCLUDED.weight),
              last_seen = NOW()
            """,
            parameters=[_p("a", a), _p("b", b), _p("weight", float(weight))],
        )
        return json.dumps({"merged": rel, "a": a, "b": b})

    mapping = _REL_TABLES.get(rel)
    if not mapping:
        return json.dumps({"error": f"unknown rel_type: {rel}", "from": from_safe, "to": to_safe})

    table, src_col, dst_col = mapping
    _exec_sql(
        f"""
        INSERT INTO {table} ({src_col}, {dst_col}, weight)
        VALUES (:src, :dst, :weight)
        ON CONFLICT ({src_col}, {dst_col}) DO UPDATE SET
          weight = GREATEST({table}.weight, EXCLUDED.weight)
        """,
        parameters=[_p("src", from_safe), _p("dst", to_safe), _p("weight", float(weight))],
    )
    return json.dumps({"merged": rel, "from": from_safe, "to": to_safe})


@instrumented_tool(_current_ctx.get)
def embed_and_store(node_id: str, node_label: str, content: str) -> str:
    """Embed a node (Titan V2, 1024d) and upsert into node_embeddings.

    Args:
        node_id: Row id in the source table (people.id, skills.id, etc.)
        node_label: Source table name as a label (Person, Skill, Team, Project, Decision)
        content: Text to embed (name + description + key properties)
    """
    if not caller_may_write(_caller_auth.get()):
        return _refused("embedding", "tenant")
    if node_label not in ENTITY_KINDS.values():
        return _refused("embedding", "kind")
    response = _bedrock_runtime.invoke_model(
        modelId=EMBED_MODEL,
        body=json.dumps({"inputText": content, "dimensions": 1024, "normalize": True}),
        contentType="application/json",
    )
    embedding = json.loads(response["body"].read())["embedding"]
    vector_str = "[" + ",".join(f"{v:.8f}" for v in embedding) + "]"

    _exec_sql(
        """
        INSERT INTO node_embeddings (node_id, node_type, content, embedding)
        VALUES (:node_id, :node_type, :content, CAST(:embedding AS vector))
        ON CONFLICT (node_id) DO UPDATE SET
          node_type = EXCLUDED.node_type,
          content   = EXCLUDED.content,
          embedding = EXCLUDED.embedding
        """,
        parameters=[
            _p("node_id", node_id),
            _p("node_type", node_label),
            _p("content", content[:4096]),
            _p("embedding", vector_str),
        ],
    )
    return json.dumps({"node_id": node_id, "dimensions": len(embedding), "stored": True})


@tool
@instrumented_tool(_current_ctx.get)
def extract_and_build(document_text: str, source_key: str = "") -> str:
    """Extract entities + relationships from a document and write them to Aurora.

    Pipeline:
      1. Bedrock NER extracts {people, skills, teams, projects, relationships}
      2. The extraction is checked against the schema, the document and the
         verified caller (_shared/graph_extraction.py); what fails is dropped
         and counted in ``dropped``
      3. Upserts each accepted entity via the internal merge_* steps
      4. Embeds people + skills into node_embeddings

    Args:
        document_text: Raw text (max 20,000 chars)
        source_key: S3 key for provenance (optional)
    """
    auth = _caller_auth.get()
    if not caller_may_write(auth):
        # No model call and no write for a caller outside the graph's tenant.
        return json.dumps({"error": "this caller may not write the org graph", "refused": "tenant",
                           "nodes_created": 0, "relationships_created": 0, "embeddings_stored": 0})
    # The document is untrusted: fenced with a random per-call delimiter,
    # tag look-alikes inside it defused, cut to 20,000 characters, and the
    # system prompt says the fenced block is data (_shared/untrusted_text.py).
    fenced = Fence().wrap(document_text, source=source_key or "unknown", max_chars=20_000)
    prompt = f"""Extract entities from the organizational document below for an org-knowledge graph.
Return ONLY valid JSON — no explanation, no markdown.

{fenced}

JSON schema:
{{
  "people": [{{"id": "slug", "name": "Full Name", "email": "", "team": "", "role": ""}}],
  "skills": [{{"id": "slug", "name": "Skill Name", "domain": ""}}],
  "teams": [{{"id": "slug", "name": "Team Name"}}],
  "projects": [{{"id": "slug", "name": "Project Name"}}],
  "relationships": [
    {{"from_id": "slug", "from_label": "Person", "to_id": "slug", "to_label": "Skill", "type": "HAS_SKILL", "weight": 0.9}}
  ]
}}

Rules:
- Use lowercase_underscore slugs for all ids
- Only extract entities explicitly mentioned in the text
- Relationship types: HAS_SKILL (Person to Skill), MEMBER_OF (Person to Team), WORKED_ON (Person to Project), WORKED_WITH (Person to Person)

JSON:"""

    resp, _served = invoke_with_fallback(
        lambda model_id: _bedrock_runtime.converse(
            modelId=model_id,
            system=[{"text": with_data_rule("You extract entities from organizational documents into JSON.")}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 2048},
        ),
        resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).chain,
    )
    raw_text = _converse_text(resp)

    start = raw_text.find("{")
    end = raw_text.rfind("}") + 1
    if start < 0 or end <= start:
        return json.dumps({"error": "No JSON in model response", "raw": raw_text[:500]})

    try:
        extracted = json.loads(raw_text[start:end])
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"JSON parse failed: {e}", "raw": raw_text[start:start + 500]})

    checked = check_extraction(extracted, document_text, auth)
    if checked.dropped_total:
        log.info("graph-builder: dropped %d extracted elements %s", checked.dropped_total, checked.dropped)

    nodes_created = 0
    rels_created = 0
    embeds_stored = 0

    for person in checked.entities["people"]:
        merge_person(
            person_id=person["id"],
            name=person["name"],
            email=person.get("email", ""),
            team=person.get("team", ""),
            role=person.get("role", ""),
        )
        content = f"{person['name']} {person.get('role', '')} {person.get('team', '')}"
        embed_and_store(node_id=person["id"], node_label="Person", content=content.strip())
        nodes_created += 1
        embeds_stored += 1

    for skill in checked.entities["skills"]:
        merge_skill(skill_id=skill["id"], name=skill["name"], domain=skill.get("domain", ""))
        embed_and_store(
            node_id=skill["id"],
            node_label="Skill",
            content=f"{skill['name']} {skill.get('domain', '')}".strip(),
        )
        nodes_created += 1
        embeds_stored += 1

    for team in checked.entities["teams"]:
        merge_team(team_id=team["id"], name=team["name"])
        nodes_created += 1

    for project in checked.entities["projects"]:
        merge_project(project_id=project["id"], name=project["name"], status=project.get("status", ""))
        nodes_created += 1

    for rel in checked.relationships:
        merge_relationship(
            from_id=rel["from_id"],
            from_label=rel["from_label"],
            to_id=rel["to_id"],
            to_label=rel["to_label"],
            rel_type=rel["type"],
            weight=rel["weight"],
        )
        rels_created += 1

    return json.dumps({
        "nodes_created": nodes_created,
        "relationships_created": rels_created,
        "embeddings_stored": embeds_stored,
        "dropped": checked.dropped,
        "fields_cleared": checked.fields_cleared,
        "source": source_key,
    })


@tool
@instrumented_tool(_current_ctx.get)
def run_in_sandbox(python_code: str) -> str:
    """Execute a Python snippet inside the AgentCore code-interpreter sandbox.

    Use this for data transformation, text parsing, regex extraction, JSON
    reshaping, or any computation that's cleaner in Python than SQL. The
    sandbox has Python 3 + numpy/pandas but NO network or database access —
    embed any input data as constants inside the code and use print() to
    surface results.

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
            name=f"graph-builder-sandbox-{int(time.time())}",
        )
        session_id = start.get("sessionId", "")

        resp = _agentcore_data.invoke_code_interpreter(
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
    "You are the OrgIQ Graph-Builder agent. Build and maintain the organizational "
    "knowledge graph in Aurora PostgreSQL (relational tables) with pgvector embeddings.\n\n"
    "Every graph write goes through extract_and_build(document_text): it extracts "
    "people, skills, teams, projects and relationships from the text, checks each "
    "one against that text, writes what passes and embeds people and skills. For a "
    "targeted edit, pass the text that states the fact to extract_and_build.\n\n"
    "Use run_in_sandbox for any data transformation or parsing that's cleaner in "
    "Python — e.g. deduplication logic, regex extraction or JSON reshaping. Embed "
    "input data as inline constants.\n\n"
    "Critical rules:\n"
    "- All writes are idempotent (INSERT ... ON CONFLICT DO UPDATE)\n"
    "- Only facts stated in the document are written\n"
    "- Titan Embeddings V2 at 1024 dimensions — do not change this\n"
    "- Vector embeddings are stored in the node_embeddings table"
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

#: The tools the model may call. The merge_* writers and embed_and_store are
#: internal steps of extract_and_build (see the note above merge_person).
MODEL_TOOLS = (extract_and_build, run_in_sandbox)

# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-graph-builder-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = RegistryAgent(
    role=MODEL_ROLE,
    **_MODEL_DEFAULTS,
    baked=SYSTEM_PROMPT,
    agent_name="graph-builder",
    build=lambda system_prompt, model_id: Agent(
        model=BedrockModel(**_model_kwargs(model_id)),
        tools=list(MODEL_TOOLS),
        system_prompt=with_data_rule(system_prompt),
    ),
)


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    token = _sandbox_log.set([])
    # The caller every write tool checks; read once, from the verified block only.
    caller = verified_auth(payload) if isinstance(payload, dict) else None
    auth_token = _caller_auth.set(caller)
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
            return {"agent": "graph-builder", "error": "missing input_text/prompt/message"}

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
                agent_id="orgiq-graph-builder",
                agent_name="Graph Builder",
                model_id=_agent.model_id,
                ctx_var=_current_ctx,
                scoped_vars=[(_sandbox_log, []), (_caller_auth, caller)],
            )

        # ── Sprint 2 instrumentation ─────────────────────────────────────────
        # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
        ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
        ctx_token = _current_ctx.set(ctx)
        shared_token = set_active_ctx(ctx)

        log.info(
            "Graph-Builder handling (invocation=%s, parent=%s): %s",
            ctx.invocation_id, ctx.parent_invocation_id or "—", text_fingerprint(input_text),
        )

        with with_orgiq_root(
            ctx,
            agent_id="orgiq-graph-builder",
            agent_name="Graph Builder",
            prompt_version=_agent.prompt_sha,
            model_id=_agent.model_id,
            model_registry_version=_agent.registry_version or None,
        ) as oi_span:
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
                    agent_id="orgiq-graph-builder",
                    agent_name="Graph-Builder",
                    model_id=_agent.model_id,
                    duration_ms=duration_ms,
                    prompt_version=_agent.prompt_sha,
                )
                post_trace(bundle)
            except Exception as exc:  # noqa: BLE001
                log.warning("graph-builder: trace emission failed: %s", exc)

        executions = list(_sandbox_log.get())
        response: dict = {
            "agent": "graph-builder",
            "response": response_text,
            "invocationId": ctx.invocation_id,
            "toolCalls": ctx.project_tool_calls(),
        }
        if executions:
            response["sandboxExecutions"] = executions
        return attach_usage(response, ctx, _agent.model_id)
    finally:
        _sandbox_log.reset(token)
        _caller_auth.reset(auth_token)


if __name__ == "__main__":
    app.run()
