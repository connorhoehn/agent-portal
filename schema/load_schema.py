#!/usr/bin/env python3
"""Load schema files into Aurora using RDS Data API."""
import os
import re
import boto3
import sys

def get_cluster_info():
    cf = boto3.client('cloudformation', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    resp = cf.describe_stacks(StackName='OrgIQ-Aurora')
    outputs = {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0]['Outputs']}
    return outputs['ClusterArn'], outputs['CredentialsSecretArn'], outputs['DbName']

def split_sql(content):
    """Split SQL file into individual statements."""
    statements = []
    current = []
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.startswith('--') or not stripped:
            continue
        current.append(line)
        if stripped.endswith(';'):
            stmt = '\n'.join(current).strip()
            if stmt and not stmt.startswith('--'):
                statements.append(stmt)
            current = []
    return statements

def main():
    cluster_arn, secret_arn, db_name = get_cluster_info()
    rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

    schema_files = [
        'orgiq_schema.sql',
        'observability_schema.sql',
        'newsroom_schema.sql',
        'orgiq_kb_registry_schema.sql',
        'orgiq_work_items_schema.sql',
    ]

    for filename in schema_files:
        path = f'schema/{filename}'
        if not os.path.exists(path):
            print(f"⊘ {filename} not found, skipping")
            continue

        print(f"Loading {filename}...")
        with open(path) as f:
            content = f.read()

        statements = split_sql(content)
        for i, stmt in enumerate(statements, 1):
            try:
                rds.execute_statement(
                    resourceArn=cluster_arn,
                    secretArn=secret_arn,
                    database=db_name,
                    sql=stmt
                )
                print(f"  ✓ {i}/{len(statements)}")
            except Exception as e:
                if 'already exists' in str(e):
                    print(f"  ↻ {i}/{len(statements)} (already exists)")
                else:
                    print(f"  ✗ {i}/{len(statements)}: {e}")

    print("\n✓ Schema loaded")

if __name__ == '__main__':
    main()
