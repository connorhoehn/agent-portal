import json
import os

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
GRAPH_NAME = f"{os.environ.get('PROJECT_PREFIX', 'orgiq')}_graph"

_bedrock = boto3.client("bedrock-agent-runtime", region_name=REGION)
_rds = boto3.client("rds-data", region_name=REGION)


@tool
def query_knowledge_base(query: str, max_results: int = 5) -> str:
    """Search the organizational knowledge base for documents, expertise, and decisions.

    Args:
        query: Natural language search query
        max_results: Number of results to return (default 5, max 20)

    Returns:
        JSON list of results with content, relevance score, and S3 source URI
    """
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
    return json.dumps(results, ensure_ascii=False)


@tool
def query_graph(cypher: str) -> str:
    """Execute an openCypher query against the organizational knowledge graph (Aurora + Apache AGE).

    Use MATCH/RETURN patterns to find people, teams, skills, and relationships.
    Example: MATCH (p:Person)-[:HAS_SKILL]->(s:Skill {name: 'Kubernetes'}) RETURN p.name, p.email LIMIT 10

    Args:
        cypher: openCypher query string

    Returns:
        JSON array of result rows
    """
    sql = (
        f"SELECT * FROM ag_catalog.cypher('{GRAPH_NAME}', $$ {cypher} $$) "
        f"as (result ag_catalog.agtype)"
    )
    response = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
    )
    records = []
    for row in response.get("records", []):
        records.append([list(field.values())[0] for field in row if field])
    return json.dumps(records, ensure_ascii=False)


_model = BedrockModel(model_id=MODEL_ID)
_agent = Agent(
    model=_model,
    tools=[query_knowledge_base, query_graph],
    system_prompt=(
        "You are the OrgIQ Search agent. Your role is to find people, teams, skills, "
        "documents, and decisions in the organizational knowledge base and graph.\n\n"
        "Use query_knowledge_base for document search and semantic retrieval.\n"
        "Use query_graph for relationship traversal (who knows whom, who has a skill, etc.).\n\n"
        "Always return source citations. Combine both tools for comprehensive answers."
    ),
)


@app.entrypoint()
async def handle(input_text: str, **kwargs) -> dict:
    result = _agent(input_text)
    return {"agent": "search", "response": str(result)}


if __name__ == "__main__":
    app.run()
