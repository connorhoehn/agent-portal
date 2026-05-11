"""
MCP Gateway Lambda tool: Graph Traversal (Aurora SQL backend).

Executes read-only SQL queries against the OrgIQ relational graph in Aurora
(see schema/orgiq_schema.sql) via the RDS Data API. Mirrors the previous
Cypher-based tool — the calling agent now writes SQL JOINs instead of MATCH.
"""

import json
import os
import re

import boto3

AURORA_CLUSTER_ARN = os.environ['AURORA_CLUSTER_ARN']
AURORA_SECRET_ARN = os.environ['AURORA_SECRET_ARN']
DB_NAME = os.environ.get('PROJECT_PREFIX', 'orgiq')
REGION = os.environ.get('REGION', 'us-east-1')

_rds = boto3.client('rds-data', region_name=REGION)

_READONLY_RE = re.compile(r'^\s*(WITH|SELECT|EXPLAIN)\b', re.IGNORECASE)


def _records_to_dicts(resp: dict) -> list:
    cols = [c.get('name', f'col{i}') for i, c in enumerate(resp.get('columnMetadata', []))]
    out = []
    for record in resp.get('records', []):
        row = {}
        for col, cell in zip(cols, record):
            row[col] = list(cell.values())[0] if cell else None
        out.append(row)
    return out


def handler(event: dict, context) -> dict:
    body = event if isinstance(event, dict) else json.loads(event)

    sql = body.get('sql') or body.get('query', '')
    parameters = body.get('parameters', {})
    explain = body.get('explain', False)

    if not _READONLY_RE.match(sql) or ';' in sql.strip().rstrip(';'):
        return {
            'statusCode': 403,
            'body': json.dumps({
                'error': 'Only single read-only SELECT/WITH/EXPLAIN statements are allowed via this MCP tool. Use graph-builder agent for writes.',
            }),
        }

    statement = f'EXPLAIN {sql}' if explain and not sql.upper().startswith('EXPLAIN') else sql

    rds_params = [
        {'name': k, 'value': {'stringValue': str(v)} if not isinstance(v, (int, float, bool)) else (
            {'longValue': v} if isinstance(v, int) else
            {'doubleValue': v} if isinstance(v, float) else
            {'booleanValue': v}
        )}
        for k, v in parameters.items()
    ]

    response = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=statement,
        parameters=rds_params,
        includeResultMetadata=True,
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'sql': sql,
            'parameters': parameters,
            'explain': explain,
            'results': _records_to_dicts(response),
        }, default=str),
    }
