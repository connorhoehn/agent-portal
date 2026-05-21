"""
MCP Gateway Lambda tool: Knowledge Base Query

Queries the OrgIQ Bedrock Knowledge Base using the Retrieve API.
Supports natural language queries with optional metadata filters.
"""

import json
import os

import boto3

KB_ID = os.environ['KB_ID']
NEWSROOM_KB_ID = os.environ.get('NEWSROOM_KB_ID', '')
REGION = os.environ.get('REGION', 'us-east-1')

bedrock_agent = boto3.client('bedrock-agent-runtime', region_name=REGION)


def handler(event: dict, context) -> dict:
    """Handle MCP tool invocation for knowledge base queries."""
    body = event if isinstance(event, dict) else json.loads(event)

    query = body['query']
    max_results = body.get('maxResults', 10)
    filters = body.get('filters')

    # Route to the correct KB based on kb_slug parameter
    kb_slug = ''
    if isinstance(event.get('parameters'), list):
        for p in event.get('parameters', []):
            if p.get('name') == 'kb_slug':
                kb_slug = str(p.get('value', ''))
                break
    elif isinstance(event.get('parameters'), dict):
        kb_slug = str(event.get('parameters', {}).get('kb_slug', ''))

    # Also check the parsed body (direct invocation path)
    if not kb_slug:
        kb_slug = str(body.get('kb_slug', ''))

    # Resolve KB ID: newsroom slug → NEWSROOM_KB_ID, default/others → KB_ID
    if kb_slug == 'newsroom' and NEWSROOM_KB_ID:
        effective_kb_id = NEWSROOM_KB_ID
    else:
        effective_kb_id = KB_ID

    # Build retrieval configuration
    retrieval_config = {
        'vectorSearchConfiguration': {
            'numberOfResults': max_results,
        }
    }

    # Apply metadata filters if provided
    if filters:
        filter_conditions = []

        if 'documentType' in filters:
            filter_conditions.append({
                'equals': {
                    'key': 'documentType',
                    'value': {'stringValue': filters['documentType']},
                }
            })

        if 'team' in filters:
            filter_conditions.append({
                'equals': {
                    'key': 'team',
                    'value': {'stringValue': filters['team']},
                }
            })

        if 'dateRange' in filters:
            date_range = filters['dateRange']
            if 'start' in date_range:
                filter_conditions.append({
                    'greaterThanOrEquals': {
                        'key': 'date',
                        'value': {'stringValue': date_range['start']},
                    }
                })
            if 'end' in date_range:
                filter_conditions.append({
                    'lessThanOrEquals': {
                        'key': 'date',
                        'value': {'stringValue': date_range['end']},
                    }
                })

        if len(filter_conditions) == 1:
            retrieval_config['vectorSearchConfiguration']['filter'] = filter_conditions[0]
        elif len(filter_conditions) > 1:
            retrieval_config['vectorSearchConfiguration']['filter'] = {
                'andAll': filter_conditions
            }

    # Execute retrieval
    response = bedrock_agent.retrieve(
        knowledgeBaseId=effective_kb_id,
        retrievalQuery={'text': query},
        retrievalConfiguration=retrieval_config,
    )

    # Format results
    results = []
    for result in response.get('retrievalResults', []):
        results.append({
            'content': result.get('content', {}).get('text', ''),
            'score': result.get('score', 0),
            'location': result.get('location', {}),
            'metadata': result.get('metadata', {}),
        })

    return {
        'statusCode': 200,
        'body': json.dumps({
            'query': query,
            'resultCount': len(results),
            'results': results,
        }),
    }
