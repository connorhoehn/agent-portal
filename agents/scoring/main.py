import json
import os
import time

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
SCORES_TABLE = f"{PREFIX}-scores"

_rds = boto3.client("rds-data", region_name=REGION)
_dynamo = boto3.client("dynamodb", region_name=REGION)


def _cypher(query: str) -> list:
    sql = (
        f"SELECT * FROM ag_catalog.cypher('{GRAPH_NAME}', $$ {query} $$) "
        f"as (result ag_catalog.agtype)"
    )
    resp = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
    )
    return [[list(f.values())[0] for f in row if f] for row in resp.get("records", [])]


@tool
def compute_expertise_scores(topic: str = "", limit: int = 20) -> str:
    """Compute in-degree centrality scores as a PageRank proxy for expertise ranking.

    Counts how many relationships point to each Person node (collaboration mentions,
    skill associations, decision participation). Higher in-degree = more influential.

    Scores are written back as `expertise_score` properties on Person nodes in the graph
    and saved as snapshots to DynamoDB.

    Args:
        topic: Optional skill or domain to restrict scoring (e.g. 'Kubernetes', 'ML')
        limit: Maximum number of ranked people to return (default 20)

    Returns:
        JSON list of {id, name, score, normalized_score} sorted by score desc
    """
    if topic:
        cypher = (
            f"MATCH (p:Person)-[:HAS_SKILL]->(s:Skill) "
            f"WHERE toLower(s.name) CONTAINS toLower('{topic}') "
            f"OPTIONAL MATCH (p)<-[r]-() "
            f"WITH p, count(r) as in_degree "
            f"RETURN p.id as id, p.name as name, in_degree "
            f"ORDER BY in_degree DESC LIMIT {limit}"
        )
    else:
        cypher = (
            f"MATCH (p:Person) "
            f"OPTIONAL MATCH (p)<-[r]-() "
            f"WITH p, count(r) as in_degree "
            f"RETURN p.id as id, p.name as name, in_degree "
            f"ORDER BY in_degree DESC LIMIT {limit}"
        )

    rows = _cypher(cypher)
    if not rows:
        return json.dumps([])

    max_score = max(float(r[2]) for r in rows) if rows else 1.0
    max_score = max_score if max_score > 0 else 1.0

    results = []
    snapshot_time = int(time.time())

    for row in rows:
        person_id, name, raw_score = str(row[0]), str(row[1]), float(row[2])
        normalized = round((raw_score / max_score) * 100, 2)

        # Write back normalized score to graph node
        update_cypher = (
            f"MATCH (p:Person {{id: '{person_id}'}}) "
            f"SET p.expertise_score = {normalized} "
            f"RETURN p.id"
        )
        try:
            _cypher(update_cypher)
        except Exception:
            pass  # score update is best-effort

        # Snapshot to DynamoDB
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
            pass  # DynamoDB write is best-effort

        results.append(
            {"id": person_id, "name": name, "score": raw_score, "normalized_score": normalized}
        )

    return json.dumps(results, ensure_ascii=False)


@tool
def get_scores(person_id: str = "", topic: str = "", limit: int = 10) -> str:
    """Retrieve the most recent expertise scores from DynamoDB.

    Args:
        person_id: Filter to a specific person (optional)
        topic: Filter to a specific topic/skill domain (optional)
        limit: Maximum results (default 10)

    Returns:
        JSON list of score records
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
        # Scan recent snapshots — in production use a GSI on timestamp
        response = _dynamo.scan(
            TableName=SCORES_TABLE,
            Limit=limit * 3,
        )

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
def get_leaderboard(team: str = "", skill: str = "", limit: int = 10) -> str:
    """Generate an expertise leaderboard filtered by team or skill domain.

    Queries the live graph for current scores rather than DynamoDB snapshots.

    Args:
        team: Filter to members of a specific team (optional)
        skill: Filter to people with a specific skill (optional)
        limit: Number of entries in the leaderboard (default 10)

    Returns:
        JSON leaderboard with rank, person, score, and metadata
    """
    if team and skill:
        cypher = (
            f"MATCH (p:Person)-[:MEMBER_OF]->(t:Team {{name: '{team}'}}), "
            f"(p)-[:HAS_SKILL]->(s:Skill) "
            f"WHERE toLower(s.name) CONTAINS toLower('{skill}') "
            f"RETURN p.id, p.name, coalesce(p.expertise_score, 0) as score "
            f"ORDER BY score DESC LIMIT {limit}"
        )
    elif team:
        cypher = (
            f"MATCH (p:Person)-[:MEMBER_OF]->(t:Team {{name: '{team}'}}) "
            f"RETURN p.id, p.name, coalesce(p.expertise_score, 0) as score "
            f"ORDER BY score DESC LIMIT {limit}"
        )
    elif skill:
        cypher = (
            f"MATCH (p:Person)-[:HAS_SKILL]->(s:Skill) "
            f"WHERE toLower(s.name) CONTAINS toLower('{skill}') "
            f"RETURN p.id, p.name, coalesce(p.expertise_score, 0) as score "
            f"ORDER BY score DESC LIMIT {limit}"
        )
    else:
        cypher = (
            f"MATCH (p:Person) WHERE p.expertise_score IS NOT NULL "
            f"RETURN p.id, p.name, p.expertise_score as score "
            f"ORDER BY score DESC LIMIT {limit}"
        )

    rows = _cypher(cypher)
    leaderboard = [
        {"rank": i + 1, "id": str(r[0]), "name": str(r[1]), "score": float(r[2])}
        for i, r in enumerate(rows)
    ]
    return json.dumps(leaderboard, ensure_ascii=False)


_model = BedrockModel(model_id=MODEL_ID)
_agent = Agent(
    model=_model,
    tools=[compute_expertise_scores, get_scores, get_leaderboard],
    system_prompt=(
        "You are the OrgIQ Scoring agent. Compute and report expertise scores, "
        "leaderboards, and influence metrics.\n\n"
        "Scoring approach: in-degree centrality as a PageRank proxy. "
        "Scores are normalized 0-100. Higher = more mentioned/collaborated with.\n\n"
        "When asked to score, use compute_expertise_scores (optionally filtered by topic).\n"
        "When asked for current scores/rankings, use get_leaderboard or get_scores.\n"
        "Always explain the scoring methodology when presenting results."
    ),
)


@app.entrypoint()
async def handle(input_text: str, **kwargs) -> dict:
    result = _agent(input_text)
    return {"agent": "scoring", "response": str(result)}


if __name__ == "__main__":
    app.run()
