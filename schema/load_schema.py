#!/usr/bin/env python3
"""Load schema files into Aurora using RDS Data API."""
import os
import re
import time
import boto3
import sys

# --- The cold-cluster scale-up race ---------------------------------------
# A freshly created Aurora Serverless v2 cluster sits cold at its 0.5-ACU
# minimum. The FIRST Data API call after idle triggers a scale-up, and while
# that scale-up is in flight the endpoint rejects the call with
# `HttpEndpointNotEnabledException: HttpEndpoint is not enabled for resource`
# — even though the HTTP endpoint IS enabled (verified HttpEndpointEnabled=True).
# The very next call, once the cluster has warmed, succeeds. We proved this with
# a warm-up probe that failed on attempt 1 (HttpEndpoint) then succeeded on 2.
#
# The old loop caught every exception and moved on, silently dropping that one
# statement. When the dropped statement was a CREATE TABLE / ADD COLUMN, a later
# dependent statement then failed on the now-missing object (e.g. `column
# "doc_type" does not exist`), so the hiccup cascaded — and a DIFFERENT
# statement caught the scale race on each re-run, so no single run ever
# completed the load. It still printed `✓ Schema loaded` regardless.
#
# The fix: retry ONLY the transient scale-up/resume/connection-reset errors with
# a short backoff, warm the cluster with a retried `SELECT 1` before any DDL,
# and let genuine SQL errors (syntax, real constraint violations) surface.

# Substrings that identify a transient scale-up / resume / connection-reset
# error that a retry will clear. Matched case-insensitively against str(e).
TRANSIENT_MARKERS = (
    'httpendpoint is not enabled',   # cold cluster, endpoint IS enabled
    'is not currently available',    # cluster resuming/scaling
    'cluster is scaling',
    'resuming',
    'is paused',
    'connection reset',
    'connection was closed',
    'timed out',
    'try again',
)
# Exception CLASS names the Data API raises for these transients. We match on
# name (not import) because botocore models them as dynamic client exceptions.
TRANSIENT_EXC_NAMES = (
    'HttpEndpointNotEnabledException',
    'DatabaseErrorException',
    'BadRequestException',
    'DatabaseResumingException',
    'StatementTimeoutException',
    'ServiceUnavailableError',
    'InternalServerErrorException',
)

# Retry policy: a fresh cluster typically needs one or two retries to warm; more
# headroom costs nothing on the happy path (no retry = no sleep) and covers a
# slow scale-up. 6 attempts with a 3s gap caps worst-case wait per statement at
# ~15s of sleeping — bounded, not a hang.
MAX_ATTEMPTS = 6
RETRY_SLEEP_S = 3

def is_transient(e):
    """True if `e` looks like the cold-cluster scale-up race, not a real error."""
    name = type(e).__name__
    if name in TRANSIENT_EXC_NAMES:
        # DatabaseError/BadRequest are also raised for genuine SQL errors, so
        # for those two we still require a transient marker in the message. The
        # dedicated scale-up exceptions (HttpEndpointNotEnabled, *Resuming) are
        # transient by definition.
        if name in ('DatabaseErrorException', 'BadRequestException'):
            return any(m in str(e).lower() for m in TRANSIENT_MARKERS)
        return True
    return any(m in str(e).lower() for m in TRANSIENT_MARKERS)

def execute_with_retry(rds, cluster_arn, secret_arn, db_name, sql):
    """execute_statement with backoff for the scale-up race.

    Retries only transient scale-up/resume/reset errors. `already exists` and
    genuine SQL errors are raised to the caller unchanged — the loop treats the
    former as success (↻) and the latter as a real failure.
    """
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return rds.execute_statement(
                resourceArn=cluster_arn,
                secretArn=secret_arn,
                database=db_name,
                sql=sql,
            )
        except Exception as e:
            # 'already exists' is idempotent success; never retry, let the caller
            # classify it. Genuine SQL errors also surface immediately.
            if 'already exists' in str(e) or not is_transient(e):
                raise
            last = e
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_SLEEP_S)
    raise last

def warm_up(rds, cluster_arn, secret_arn, db_name):
    """Scale the cluster up before real DDL with a retried `SELECT 1`.

    The first Data API call after idle eats the scale-up race (see the comment
    above), so we spend it on a throwaway probe instead of the first CREATE.
    """
    print("Warming up cluster (SELECT 1)...")
    execute_with_retry(rds, cluster_arn, secret_arn, db_name, 'SELECT 1')
    print("  ✓ cluster is warm")

def get_cluster_info():
    cf = boto3.client('cloudformation', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    resp = cf.describe_stacks(StackName='OrgIQ-Aurora')
    outputs = {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0]['Outputs']}
    return outputs['ClusterArn'], outputs['CredentialsSecretArn'], outputs['DbName']

def split_sql(content):
    """Split a SQL file into statements, respecting dollar-quoted blocks.

    A ';' inside $$ ... $$ (or $tag$ ... $tag$) does NOT end a statement. The
    original version split on any line ending in ';', which shredded every
    PL/pgSQL body into fragments: each fragment was sent to the Data API on its
    own and failed with a syntax error, so the CREATE FUNCTION never ran while
    the loader reported the rest of the file as fine. That silently dropped the
    knowledge_bases updated_at trigger function on every rebuild — the trigger
    that depends on it then failed too, one line further down.
    """
    statements = []
    current = []
    dollar_tag = None  # the open tag, e.g. '$$' or '$body$', or None

    for line in content.split('\n'):
        stripped = line.strip()
        # Comments and blanks are skipped only OUTSIDE a dollar-quoted body;
        # inside one they are part of the function source.
        if dollar_tag is None and (stripped.startswith('--') or not stripped):
            continue
        current.append(line)

        # Walk the line's dollar-quote markers so a tag opened and closed on
        # the same line nets out correctly.
        for tag in re.findall(r'\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$', line):
            if dollar_tag is None:
                dollar_tag = tag
            elif tag == dollar_tag:
                dollar_tag = None

        if dollar_tag is None and stripped.endswith(';'):
            stmt = '\n'.join(current).strip()
            if stmt and not stmt.startswith('--'):
                statements.append(stmt)
            current = []

    # A trailing statement with no closing ';' is still a statement.
    tail = '\n'.join(current).strip()
    if tail and not tail.startswith('--'):
        statements.append(tail)
    return statements

def main():
    cluster_arn, secret_arn, db_name = get_cluster_info()
    rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

    # Scale the cluster up before touching real DDL so the first CREATE doesn't
    # eat the cold-cluster scale-up race.
    warm_up(rds, cluster_arn, secret_arn, db_name)

    schema_files = [
        'orgiq_schema.sql',
        'identity_schema.sql',
        'observability_schema.sql',
        'observability_authz_schema.sql',
        # The observability sprint schemas. These were never in this list, so a
        # rebuilt cluster came up without the tables the middleware queries by
        # name — observability.approvals, .canary_experiments, .prompt_versions
        # and .prompt_version_meta are referenced across a dozen middleware
        # files, and each page hitting them 500s on a fresh database. They load
        # in sprint order because the later ones ALTER what the earlier ones
        # create.
        'observability_sprint1_schema.sql',
        'observability_sprint2_schema.sql',
        'observability_sprint3_promote_schema.sql',
        'observability_sprint4_calibration_schema.sql',
        'observability_sprint4_memory_schema.sql',
        'observability_sprint5_canary_schema.sql',
        'observability_sprint6_prompt_history_schema.sql',
        # The prompt CONTRACT columns (kind/tier/contract/owner_email/
        # eval_pass_rate) that sprint6's prompt_version_meta does not create.
        # Same bug class as the sprint schemas above, but failing softer and so
        # harder to spot: providers/prompt-library.ts `fetchAuroraMeta` SELECTs
        # all five by name and swallows the error, so a cluster missing this
        # ALTER does not 500 — the prompt library just silently degrades to
        # "Bedrock defaults" with every tier and contract blank. Loads directly
        # after the file that creates the table it alters.
        'prompt_contract_schema.sql',
        'observability_approvals_schema.sql',
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
        # The lab loop: fleet memory + human consults for computer-lab agents.
        'lab_loop_schema.sql',
        # L1 clusters + L2 artifacts distilled from lab_experiences (L0).
        # Loads right after it: distillation_cluster_members FKs
        # lab_experiences directly.
        'distillation_schema.sql',
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
        # The assessment tenant's own tables (docs/assessment-tenant.md).
        # Standalone — no FK into the org graph — so it can load anywhere;
        # kept here so a rebuilt cluster has the tables the Aurora path of
        # providers/assessment.ts will query.
        'assessment_schema.sql',
        # bot_runs.dispatched_by — who authorized a run, which is what lets the
        # per-SME budget_grants envelope be enforced. Additive ALTER, so it
        # loads after agent_bots_schema.sql creates the table.
        'agent_run_attribution_schema.sql',
        # NOTE: environments_schema.sql is deliberately NOT here. Its last
        # statement seeds environments for the p-* cast, and those ids are
        # created by seed_program.sql — which apply_all_seed.py applies, AFTER
        # this script. So on a from-scratch cluster the INSERT could only ever
        # fail its FK on projects ("violates foreign key constraint
        # environments_org_project_id_fkey"), taking this whole loader to
        # exit 1 with every other file already applied. A file whose tail
        # depends on seed rows belongs in the seed script, so that is where it
        # now loads.
        # Paired developer machines (compute_nodes, compute_pairing_codes).
        # No FK into the graph — owner_id is a bare app_users sub — so it can
        # load anywhere. providers/local-compute.ts queries both tables by name
        # with no fallback, so a rebuilt cluster without them 500s every
        # pairing and presence call.
        'local_compute_schema.sql',
    ]

    # Track genuine failures — statements that erred for a non-transient reason
    # and never succeeded after exhausting retries. These, and only these,
    # decide the exit status. Transient scale-up hiccups that a retry cleared
    # are NOT failures.
    failures = []  # list of (filename, index, total, error)

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
                execute_with_retry(rds, cluster_arn, secret_arn, db_name, stmt)
                print(f"  ✓ {i}/{len(statements)}")
            except Exception as e:
                if 'already exists' in str(e):
                    print(f"  ↻ {i}/{len(statements)} (already exists)")
                else:
                    # A real, non-transient error (or a transient one that
                    # survived every retry). Record it — the load did NOT
                    # fully apply, so we must not claim success.
                    print(f"  ✗ {i}/{len(statements)}: {e}")
                    failures.append((filename, i, len(statements), e))

    if failures:
        print(f"\n✗ Schema load INCOMPLETE — {len(failures)} statement(s) failed:")
        for filename, i, total, e in failures:
            print(f"  - {filename} [{i}/{total}]: {e}")
        sys.exit(1)

    print("\n✓ Schema loaded")

if __name__ == '__main__':
    main()
