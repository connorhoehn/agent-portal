"""
MCP Gateway Lambda tool: Graph Traversal

Executes openCypher queries against the OrgIQ Neptune Analytics graph.
Supports parameterized queries and query plan explanation.
"""

import json
import os

import boto3

NEPTUNE_GRAPH_ID = os.environ['NEPTUNE_GRAPH_ID']
REGION = os.environ.get('REGION', 'us-east-1')

neptune = boto3.client('neptune-graph', region_name=REGION)


def handler(event: dict, context) -> dict:
    """Handle MCP tool invocation for graph traversal queries."""
    body = event if isinstance(event, dict) else json.loads(event)

    query = body['query']
    parameters = body.get('parameters', {})
    explain = body.get('explain', False)

    # Validate query doesn't contain destructive operations unless authorized
    query_upper = query.upper().strip()
    destructive_keywords = ['DELETE', 'REMOVE', 'DROP', 'DETACH']
    for keyword in destructive_keywords:
        if keyword in query_upper and not query_upper.startswith('MATCH'):
            return {
                'statusCode': 403,
                'body': json.dumps({
                    'error': f'Destructive operation "{keyword}" not allowed via MCP tool. Use graph-builder agent directly.',
                }),
            }

    if explain:
        # Return query execution plan
        response = neptune.execute_query(
            graphIdentifier=NEPTUNE_GRAPH_ID,
            queryString=f'EXPLAIN {query}',
            language='OPEN_CYPHER',
            parameters=parameters,
        )
    else:
        # Execute the query
        response = neptune.execute_query(
            graphIdentifier=NEPTUNE_GRAPH_ID,
            queryString=query,
            language='OPEN_CYPHER',
            parameters=parameters,
        )

    # Parse the response payload
    payload = response.get('payload')
    if payload:
        result_data = json.loads(payload.read().decode('utf-8'))
    else:
        result_data = {'results': []}

    return {
        'statusCode': 200,
        'body': json.dumps({
            'query': query,
            'parameters': parameters,
            'explain': explain,
            'results': result_data.get('results', []),
        }),
    }
