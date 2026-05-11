import json
import os
import re

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
KB_ID = os.environ.get("KB_ID", "")
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")

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

    Args:
        sql: PostgreSQL SELECT (or WITH ... SELECT) statement.

    Returns:
        JSON array of result rows keyed by column name.
    """
    if not _READONLY_RE.match(sql) or ";" in sql.strip().rstrip(";"):
        return json.dumps({"error": "Only single read-only SELECT/WITH statements are allowed."})

    resp = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
        includeResultMetadata=True,
    )
    return json.dumps(_records_to_dicts(resp), ensure_ascii=False, default=str)


@tool
def retrieve_context(query: str, max_results: int = 5) -> str:
    """Retrieve supporting documents from the Bedrock Knowledge Base.

    Args:
        query: Topic or question to find supporting documentation for
        max_results: Number of documents to retrieve (default 5)
    """
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
    return json.dumps(results, ensure_ascii=False)


def _model_kwargs() -> dict:
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
    tools=[query_graph, retrieve_context],
    system_prompt=(
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

    result = _agent(input_text)
    return {"agent": "advisor", "response": str(result)}


if __name__ == "__main__":
    app.run()
