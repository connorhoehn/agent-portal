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
        'identity_schema.sql',
        'observability_schema.sql',
        'observability_authz_schema.sql',
        'newsroom_schema.sql',
        'orgiq_kb_registry_schema.sql',
        'orgiq_work_items_schema.sql',
        # The agentic loop: agent_jobs, agent_findings, graph_proposals. Was
        # applied only by apply_agentic_work.py, so a rebuild left the Work
        # page 500ing on missing tables.
        'agentic_work_schema.sql',
        # Document uploads via share links (standalone).
        'kb_upload_links_schema.sql',
        # Codebases agents work on. References `projects` (orgiq_schema), so it
        # loads after it — and agent_sdlc loads after this, since its change
        # requests reference agent_project_runs.
        'agent_projects_schema.sql',
        'agent_sdlc_schema.sql',
        # Bots + bot_runs. Loads last: it references agent_projects,
        # agent_project_runs, agent_jobs and projects, and its ALTERs add
        # linkage columns to tables the files above create.
        'agent_bots_schema.sql',
        # Initiative budget allocations. Loads after agent_bots_schema.sql
        # (spend reads join bot_runs) and orgiq_schema.sql (FK on projects).
        'agent_budgets_schema.sql',
        # Sprints, SME budget grants, work-item cost estimates, maintenance
        # baseline view. Loads last: references people, projects, work_items,
        # bots and bot_runs.
        'program_schema.sql',
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
