"""
MCP Gateway Lambda tool: Knowledge Base Query

Queries the OrgIQ Bedrock Knowledge Base using the Retrieve API.
Supports natural language queries with optional metadata filters.
"""

import json
import os

import boto3

KB_ID = os.environ['KB_ID']
REGION = os.environ.get('REGION', 'us-east-1')

# Bedrock's DEFAULT search type against this Aurora/pgvector store returns the
# right nearest neighbours in EXACTLY REVERSE relevance order (it reports cosine
# distance in the `score` field), so a caller taking the top-N gets the least
# relevant hits. Measured top-1 accuracy over 8 queries: default 0/8, HYBRID 8/8.
# Kept as a literal rather than imported because this Lambda ships on its own —
# `agents/_shared/kb_resolver.py::KB_SEARCH_TYPE` is the same decision with the
# full write-up, and the two must be changed together.
KB_SEARCH_TYPE = os.environ.get('KB_SEARCH_TYPE', 'HYBRID')

bedrock_agent = boto3.client('bedrock-agent-runtime', region_name=REGION)


def handler(event: dict, context) -> dict:
    """Handle MCP tool invocation for knowledge base queries."""
    body = event if isinstance(event, dict) else json.loads(event)

    query = body['query']
    max_results = body.get('maxResults', 10)
    filters = body.get('filters')

    # Only one KB is registered today (kb_slug='default'); resolve straight to it.
    effective_kb_id = KB_ID

    # Build retrieval configuration
    retrieval_config = {
        'vectorSearchConfiguration': {
            'numberOfResults': max_results,
            'overrideSearchType': KB_SEARCH_TYPE,
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
