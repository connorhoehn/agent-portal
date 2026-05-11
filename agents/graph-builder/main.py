import json
import os
import re

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")
PREFIX = os.environ.get("PROJECT_PREFIX", "orgiq")
GRAPH_NAME = f"{PREFIX}_graph"
EMBED_MODEL = "amazon.titan-embed-text-v2:0"

_rds = boto3.client("rds-data", region_name=REGION)
_bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)


def _exec_sql(sql: str, parameters: list = None) -> dict:
    kwargs = dict(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
    )
    if parameters:
        kwargs["parameters"] = parameters
    return _rds.execute_statement(**kwargs)


def _cypher(query: str) -> list:
    sql = (
        f"SELECT * FROM ag_catalog.cypher('{GRAPH_NAME}', $$ {query} $$) "
        f"as (result ag_catalog.agtype)"
    )
    resp = _exec_sql(sql)
    return [[list(f.values())[0] for f in row if f] for row in resp.get("records", [])]


def _safe_id(value: str) -> str:
    """Normalise a string to a safe graph node id (lowercase, underscores)."""
    return re.sub(r"[^a-z0-9_]", "_", value.lower().strip())


@tool
def merge_person(person_id: str, name: str, email: str = "", team: str = "", role: str = "") -> str:
    """Create or update a Person node in the knowledge graph (idempotent MERGE).

    Args:
        person_id: Unique identifier (e.g. 'alice_smith' or email prefix)
        name: Full display name
        email: Work email address (optional)
        team: Team or department name (optional)
        role: Job title / role (optional)

    Returns:
        JSON confirmation with node id
    """
    safe = _safe_id(person_id)
    props = f"name: '{name}'"
    if email:
        props += f", email: '{email}'"
    if team:
        props += f", team: '{team}'"
    if role:
        props += f", role: '{role}'"

    cypher = (
        f"MERGE (p:Person {{id: '{safe}'}}) "
        f"SET p += {{{props}}} "
        f"RETURN p.id as id"
    )
    _cypher(cypher)
    return json.dumps({"merged": "Person", "id": safe})


@tool
def merge_skill(skill_id: str, name: str, domain: str = "") -> str:
    """Create or update a Skill node in the knowledge graph (idempotent MERGE).

    Args:
        skill_id: Unique identifier (e.g. 'kubernetes' or 'machine_learning')
        name: Display name for the skill
        domain: Broader domain category (e.g. 'Infrastructure', 'ML', 'Frontend')

    Returns:
        JSON confirmation with node id
    """
    safe = _safe_id(skill_id)
    props = f"name: '{name}'"
    if domain:
        props += f", domain: '{domain}'"

    cypher = (
        f"MERGE (s:Skill {{id: '{safe}'}}) "
        f"SET s += {{{props}}} "
        f"RETURN s.id as id"
    )
    _cypher(cypher)
    return json.dumps({"merged": "Skill", "id": safe})


@tool
def merge_relationship(
    from_id: str,
    from_label: str,
    to_id: str,
    to_label: str,
    rel_type: str,
    weight: float = 1.0,
) -> str:
    """Create or update a relationship between two nodes (idempotent MERGE).

    Common relationship types:
    - HAS_SKILL: Person → Skill
    - MEMBER_OF: Person → Team
    - WORKED_WITH: Person → Person
    - WORKED_ON: Person → Project
    - MADE: Person → Decision
    - MENTIONS: Document → Person

    Args:
        from_id: Source node id
        from_label: Source node label (Person, Skill, Team, Project, Decision)
        to_id: Target node id
        to_label: Target node label
        rel_type: Relationship type in UPPER_SNAKE_CASE
        weight: Relationship strength 0.0–1.0 (default 1.0)

    Returns:
        JSON confirmation
    """
    from_safe = _safe_id(from_id)
    to_safe = _safe_id(to_id)

    cypher = (
        f"MATCH (a:{from_label} {{id: '{from_safe}'}}), (b:{to_label} {{id: '{to_safe}'}}) "
        f"MERGE (a)-[r:{rel_type}]->(b) "
        f"SET r.weight = {weight} "
        f"RETURN type(r) as rel"
    )
    try:
        _cypher(cypher)
        return json.dumps({"merged": rel_type, "from": from_safe, "to": to_safe})
    except Exception as e:
        return json.dumps({"error": str(e), "from": from_safe, "to": to_safe})


@tool
def embed_and_store(node_id: str, node_label: str, content: str) -> str:
    """Generate a Titan Embeddings V2 (1024d) vector for a node and store it in pgvector.

    The embedding table schema:
      CREATE TABLE IF NOT EXISTS node_embeddings (
        node_id TEXT PRIMARY KEY, node_type TEXT, content TEXT, embedding vector(1024)
      );

    Args:
        node_id: The graph node id to embed
        node_label: Node type label (Person, Skill, Team, Project, Decision)
        content: Text to embed (typically name + description + key properties)

    Returns:
        JSON with {node_id, dimensions, stored: true}
    """
    response = _bedrock_runtime.invoke_model(
        modelId=EMBED_MODEL,
        body=json.dumps({"inputText": content, "dimensions": 1024, "normalize": True}),
        contentType="application/json",
    )
    embedding = json.loads(response["body"].read())["embedding"]
    vector_str = "[" + ",".join(f"{v:.8f}" for v in embedding) + "]"

    # Ensure the table exists (idempotent)
    _exec_sql(
        "CREATE TABLE IF NOT EXISTS node_embeddings "
        "(node_id TEXT PRIMARY KEY, node_type TEXT, content TEXT, embedding vector(1024))"
    )

    _exec_sql(
        "INSERT INTO node_embeddings (node_id, node_type, content, embedding) "
        "VALUES (:node_id, :node_type, :content, CAST(:embedding AS vector)) "
        "ON CONFLICT (node_id) DO UPDATE "
        "SET node_type = EXCLUDED.node_type, content = EXCLUDED.content, embedding = EXCLUDED.embedding",
        parameters=[
            {"name": "node_id", "value": {"stringValue": node_id}},
            {"name": "node_type", "value": {"stringValue": node_label}},
            {"name": "content", "value": {"stringValue": content[:4096]}},
            {"name": "embedding", "value": {"stringValue": vector_str}},
        ],
    )
    return json.dumps({"node_id": node_id, "dimensions": len(embedding), "stored": True})


@tool
def extract_and_build(document_text: str, source_key: str = "") -> str:
    """Extract entities from document text and write them to the knowledge graph.

    This is the main entry point for graph construction. It:
    1. Uses Bedrock to NER-extract entities from the document
    2. MERGEs Person, Skill, Team, Project, Decision nodes
    3. Creates relationships between extracted entities
    4. Generates embeddings for all new nodes

    Args:
        document_text: Raw text content to process (max 20,000 characters)
        source_key: S3 key of the source document for provenance tracking (optional)

    Returns:
        JSON summary of {nodes_created, relationships_created, embeddings_stored}
    """
    prompt = f"""Extract entities from this organizational document for a knowledge graph.
Return ONLY valid JSON — no explanation, no markdown.

Document (source: {source_key or 'unknown'}):
{document_text[:20000]}

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
- Relationship types: HAS_SKILL, MEMBER_OF, WORKED_WITH, WORKED_ON, MADE, MENTIONS

JSON:"""

    resp = _bedrock_runtime.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 2048,
            "anthropic_version": "bedrock-2023-05-31",
        }),
        contentType="application/json",
    )
    raw_text = json.loads(resp["body"].read()).get("content", [{}])[0].get("text", "{}")

    start = raw_text.find("{")
    end = raw_text.rfind("}") + 1
    if start < 0 or end <= start:
        return json.dumps({"error": "No JSON in model response", "raw": raw_text[:500]})

    try:
        extracted = json.loads(raw_text[start:end])
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"JSON parse failed: {e}", "raw": raw_text[start:start+500]})

    nodes_created = 0
    rels_created = 0
    embeds_stored = 0

    for person in extracted.get("people", []):
        merge_person(
            person_id=person.get("id", ""),
            name=person.get("name", ""),
            email=person.get("email", ""),
            team=person.get("team", ""),
            role=person.get("role", ""),
        )
        content = f"{person.get('name', '')} {person.get('role', '')} {person.get('team', '')}"
        embed_and_store(
            node_id=_safe_id(person.get("id", "")),
            node_label="Person",
            content=content.strip(),
        )
        nodes_created += 1
        embeds_stored += 1

    for skill in extracted.get("skills", []):
        merge_skill(
            skill_id=skill.get("id", ""),
            name=skill.get("name", ""),
            domain=skill.get("domain", ""),
        )
        embed_and_store(
            node_id=_safe_id(skill.get("id", "")),
            node_label="Skill",
            content=f"{skill.get('name', '')} {skill.get('domain', '')}".strip(),
        )
        nodes_created += 1
        embeds_stored += 1

    for team in extracted.get("teams", []):
        safe = _safe_id(team.get("id", team.get("name", "")))
        _cypher(
            f"MERGE (t:Team {{id: '{safe}'}}) "
            f"SET t.name = '{team.get('name', '')}' "
            f"RETURN t.id"
        )
        nodes_created += 1

    for project in extracted.get("projects", []):
        safe = _safe_id(project.get("id", project.get("name", "")))
        _cypher(
            f"MERGE (p:Project {{id: '{safe}'}}) "
            f"SET p.name = '{project.get('name', '')}' "
            f"RETURN p.id"
        )
        nodes_created += 1

    for rel in extracted.get("relationships", []):
        merge_relationship(
            from_id=rel.get("from_id", ""),
            from_label=rel.get("from_label", "Person"),
            to_id=rel.get("to_id", ""),
            to_label=rel.get("to_label", "Skill"),
            rel_type=rel.get("type", "RELATED_TO"),
            weight=float(rel.get("weight", 1.0)),
        )
        rels_created += 1

    return json.dumps({
        "nodes_created": nodes_created,
        "relationships_created": rels_created,
        "embeddings_stored": embeds_stored,
        "source": source_key,
    })


_model = BedrockModel(model_id=MODEL_ID)
_agent = Agent(
    model=_model,
    tools=[merge_person, merge_skill, merge_relationship, embed_and_store, extract_and_build],
    system_prompt=(
        "You are the OrgIQ Graph-Builder agent. Build and maintain the organizational "
        "knowledge graph in Aurora PostgreSQL with Apache AGE and pgvector.\n\n"
        "Primary workflow: extract_and_build(document_text) — this handles the full pipeline.\n\n"
        "For targeted edits: use merge_person, merge_skill, merge_relationship directly.\n\n"
        "Critical rules:\n"
        "- Always use MERGE (never CREATE) for idempotent graph writes\n"
        "- Use lowercase_underscore slugs for all node IDs\n"
        "- Embed nodes after creation with embed_and_store\n"
        "- Titan Embeddings V2 at 1024 dimensions — do not change this\n"
        "- Store vector embeddings in the node_embeddings pgvector table"
    ),
)


@app.entrypoint()
async def handle(input_text: str, **kwargs) -> dict:
    result = _agent(input_text)
    return {"agent": "graph-builder", "response": str(result)}


if __name__ == "__main__":
    app.run()
