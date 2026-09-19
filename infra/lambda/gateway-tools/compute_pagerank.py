"""
MCP Gateway Lambda tool: Compute PageRank against the Aurora relational graph.

Reads node and edge data from the orgiq_schema tables (see schema/orgiq_schema.sql)
via RDS Data API and runs an iterative PageRank in-memory. The scoring agent
owns durable score updates; this gateway tool never writes.
"""

import json
import os

import boto3

AURORA_CLUSTER_ARN = os.environ['AURORA_CLUSTER_ARN']
AURORA_SECRET_ARN = os.environ['AURORA_SECRET_ARN']
DB_NAME = os.environ.get('PROJECT_PREFIX', 'orgiq')
REGION = os.environ.get('REGION', 'us-east-1')

_rds = boto3.client('rds-data', region_name=REGION)


def _exec(sql: str, parameters: list | None = None) -> dict:
    kwargs = dict(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
        includeResultMetadata=True,
    )
    if parameters:
        kwargs['parameters'] = parameters
    return _rds.execute_statement(**kwargs)


def _rows(resp: dict) -> list:
    cols = [c.get('name') for c in resp.get('columnMetadata', [])]
    return [
        dict(zip(cols, [list(cell.values())[0] if cell else None for cell in record]))
        for record in resp.get('records', [])
    ]


# Edge tables that touch the `people` table — the union forms a directed graph
# treating all edges as inbound to the person side. `collaborations` is undirected
# so we expand it into both directions.
_PEOPLE_EDGES_SQL = """
WITH edges AS (
  SELECT person_id    AS source_id, skill_id       AS target_id FROM person_skills
  UNION ALL
  SELECT person_id    AS source_id, team_id        AS target_id FROM team_memberships
  UNION ALL
  SELECT person_id    AS source_id, project_id     AS target_id FROM project_contributions
  UNION ALL
  SELECT person_id    AS source_id, decision_id    AS target_id FROM decision_participants
  UNION ALL
  SELECT person_a_id  AS source_id, person_b_id    AS target_id FROM collaborations
  UNION ALL
  SELECT person_b_id  AS source_id, person_a_id    AS target_id FROM collaborations
)
SELECT source_id, target_id FROM edges
"""


def handler(event: dict, context) -> dict:
    body = event if isinstance(event, dict) else json.loads(event)

    damping_factor = float(body.get('dampingFactor', 0.85))
    max_iterations = int(body.get('maxIterations', 20))
    if body.get('writeBack'):
        return {'statusCode': 403, 'body': json.dumps({'error': 'This tool is read-only; use the scoring agent to persist scores.'})}

    # Nodes = all people (PageRank is scored on people; other tables are targets only)
    nodes = _rows(_exec('SELECT id, name FROM people'))
    if not nodes:
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'No people in graph', 'scores': []}),
        }

    edges = _rows(_exec(_PEOPLE_EDGES_SQL))

    node_ids = [n['id'] for n in nodes]
    node_set = set(node_ids)
    n = len(node_ids)

    # Build adjacency: out_degree and incoming map, restricted to person→person/anything.
    # For PageRank, we only count edges originating from people (other entities have no rank to redistribute).
    out_degree: dict[str, int] = {nid: 0 for nid in node_ids}
    incoming: dict[str, list[str]] = {nid: [] for nid in node_ids}
    for e in edges:
        src, tgt = e['source_id'], e['target_id']
        if src in node_set:
            out_degree[src] = out_degree.get(src, 0) + 1
        if tgt in node_set and src in node_set:
            incoming[tgt].append(src)

    # Iterate
    scores = {nid: 1.0 / n for nid in node_ids}
    for _ in range(max_iterations):
        new_scores = {}
        for nid in node_ids:
            rank_sum = sum(
                scores.get(src, 0.0) / max(out_degree.get(src, 1), 1)
                for src in incoming[nid]
            )
            new_scores[nid] = (1 - damping_factor) / n + damping_factor * rank_sum
        scores = new_scores

    max_score = max(scores.values()) or 1.0
    name_map = {n['id']: n.get('name', n['id']) for n in nodes}
    results = sorted(
        [
            {
                'nodeId': nid,
                'name': name_map.get(nid, nid),
                'pageRank': round((score / max_score) * 100, 2),
            }
            for nid, score in scores.items()
        ],
        key=lambda x: x['pageRank'],
        reverse=True,
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'dampingFactor': damping_factor,
            'iterations': max_iterations,
            'writtenBack': False,
            'nodeCount': len(results),
            'scores': results[:50],
        }),
    }
