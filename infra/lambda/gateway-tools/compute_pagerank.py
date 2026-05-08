"""
MCP Gateway Lambda tool: Compute PageRank

Computes PageRank scores for nodes in the OrgIQ Neptune Analytics graph.
Uses iterative openCypher queries to approximate PageRank.
Optionally writes scores back to graph node properties.
"""

import json
import os

import boto3

NEPTUNE_GRAPH_ID = os.environ['NEPTUNE_GRAPH_ID']
REGION = os.environ.get('REGION', 'us-east-1')

neptune = boto3.client('neptune-graph', region_name=REGION)


def execute_query(query: str, parameters: dict = None) -> dict:
    """Execute an openCypher query against Neptune Analytics."""
    params = {
        'graphIdentifier': NEPTUNE_GRAPH_ID,
        'queryString': query,
        'language': 'OPEN_CYPHER',
    }
    if parameters:
        params['parameters'] = parameters

    response = neptune.execute_query(**params)
    payload = response.get('payload')
    if payload:
        return json.loads(payload.read().decode('utf-8'))
    return {'results': []}


def handler(event: dict, context) -> dict:
    """Handle MCP tool invocation for PageRank computation."""
    body = event if isinstance(event, dict) else json.loads(event)

    node_label = body.get('nodeLabel', 'Person')
    damping_factor = body.get('dampingFactor', 0.85)
    max_iterations = body.get('maxIterations', 20)
    write_back = body.get('writeBack', False)

    # Step 1: Get all nodes and their outgoing relationship counts
    count_query = f"""
    MATCH (n:{node_label})
    OPTIONAL MATCH (n)-[r]->()
    RETURN n.id AS nodeId, n.name AS nodeName, count(r) AS outDegree
    """
    count_result = execute_query(count_query)
    nodes = count_result.get('results', [])

    if not nodes:
        return {
            'statusCode': 200,
            'body': json.dumps({
                'nodeLabel': node_label,
                'message': f'No {node_label} nodes found in graph',
                'scores': [],
            }),
        }

    # Step 2: Get adjacency (who points to whom)
    adjacency_query = f"""
    MATCH (source:{node_label})-[r]->(target:{node_label})
    RETURN source.id AS sourceId, target.id AS targetId
    """
    adjacency_result = execute_query(adjacency_query)
    edges = adjacency_result.get('results', [])

    # Step 3: Compute PageRank iteratively
    node_ids = [n['nodeId'] for n in nodes]
    n = len(node_ids)

    if n == 0:
        return {
            'statusCode': 200,
            'body': json.dumps({
                'nodeLabel': node_label,
                'message': 'No nodes to compute PageRank for',
                'scores': [],
            }),
        }

    # Initialize scores
    scores = {nid: 1.0 / n for nid in node_ids}

    # Build adjacency structures
    out_degree = {node['nodeId']: max(node['outDegree'], 1) for node in nodes}
    incoming = {nid: [] for nid in node_ids}
    for edge in edges:
        source = edge.get('sourceId')
        target = edge.get('targetId')
        if target in incoming and source in node_ids:
            incoming[target].append(source)

    # Iterate
    for _ in range(max_iterations):
        new_scores = {}
        for nid in node_ids:
            rank_sum = sum(
                scores.get(src, 0) / out_degree.get(src, 1)
                for src in incoming[nid]
            )
            new_scores[nid] = (1 - damping_factor) / n + damping_factor * rank_sum
        scores = new_scores

    # Normalize to 0-100 scale
    max_score = max(scores.values()) if scores else 1
    normalized = {
        nid: round((score / max_score) * 100, 2)
        for nid, score in scores.items()
    }

    # Build results with names
    name_map = {n['nodeId']: n.get('nodeName', n['nodeId']) for n in nodes}
    results = sorted(
        [
            {'nodeId': nid, 'name': name_map.get(nid, nid), 'pageRank': normalized[nid]}
            for nid in node_ids
        ],
        key=lambda x: x['pageRank'],
        reverse=True,
    )

    # Step 4: Optionally write back to graph
    if write_back:
        for item in results:
            write_query = f"""
            MATCH (n:{node_label} {{id: $nodeId}})
            SET n.pageRank = $score
            RETURN n.id AS nodeId
            """
            execute_query(write_query, {
                'nodeId': item['nodeId'],
                'score': item['pageRank'],
            })

    return {
        'statusCode': 200,
        'body': json.dumps({
            'nodeLabel': node_label,
            'dampingFactor': damping_factor,
            'iterations': max_iterations,
            'writtenBack': write_back,
            'nodeCount': len(results),
            'scores': results[:50],  # Return top 50 for response size limit
        }),
    }
