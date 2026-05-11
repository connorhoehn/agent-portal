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
def query_graph(cypher: str) -> str:
    """Execute an openCypher query against the organizational knowledge graph (Aurora + Apache AGE).

    Use for deep graph analysis: find expertise gaps, collaboration clusters, knowledge silos,
    mentorship candidates, and influence patterns.

    Example patterns:
    - Expertise gap: MATCH (t:Team) WHERE NOT EXISTS { MATCH (t)<-[:MEMBER_OF]-(p:Person)-[:HAS_SKILL]->(:Skill {name: 'ML'}) } RETURN t.name
    - Isolated experts: MATCH (p:Person)-[:HAS_SKILL]->(s:Skill) WITH p, count(s) as skills WHERE skills > 5 RETURN p.name, skills ORDER BY skills DESC
    - Collaboration: MATCH (p1:Person)-[:WORKED_WITH]->(p2:Person) RETURN p1.name, p2.name, count(*) as collabs ORDER BY collabs DESC LIMIT 10

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


@tool
def retrieve_context(query: str, max_results: int = 5) -> str:
    """Retrieve supporting documents and evidence from the knowledge base to ground recommendations.

    Args:
        query: Topic or question to find supporting documentation for
        max_results: Number of documents to retrieve (default 5)

    Returns:
        JSON list of document excerpts with source citations
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


_model = BedrockModel(model_id=MODEL_ID)
_agent = Agent(
    model=_model,
    tools=[query_graph, retrieve_context],
    system_prompt=(
        "You are the OrgIQ Advisor agent. Provide strategic recommendations based on "
        "organizational graph analysis and document evidence.\n\n"
        "Your specialties:\n"
        "- Expertise gap analysis (skills missing on teams)\n"
        "- Knowledge silo detection (experts not connected to others)\n"
        "- Collaboration opportunity identification\n"
        "- Mentorship and succession planning\n"
        "- Team composition recommendations\n\n"
        "Always base recommendations on graph data and document evidence. "
        "Never speculate. Cite specific graph relationships and source documents."
    ),
)


@app.entrypoint()
async def handle(input_text: str, **kwargs) -> dict:
    result = _agent(input_text)
    return {"agent": "advisor", "response": str(result)}


if __name__ == "__main__":
    app.run()
