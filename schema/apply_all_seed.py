#!/usr/bin/env python3
"""Apply seed data with per-statement retry.

Freshly-created Aurora clusters intermittently throw
HttpEndpointNotEnabledException from the Data API for a while after creation
(frontend fleet propagation) — the shell apply-*.sh scripts have no retry and
die mid-file. This driver retries those (and throttles) with backoff.

Run from repo root:  python3 schema/apply_all_seed.py
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import time

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'schema'))
from load_schema import split_sql, get_cluster_info  # noqa: E402
from schema_manifest import seed_run_files  # noqa: E402
import boto3  # noqa: E402

RETRYABLE = ('HttpEndpointNotEnabledException', 'ThrottlingException', 'StatementTimeoutException')

# The seed run's order lives in schema/manifest.json (`seed_run`, DE-20), with
# the reason each file sits where it does on its entry. In short: the schema
# files the seeds write into come first so a seed-only run against an older
# database works, environments_schema follows seed_program (its tail seeds the
# p-* cast), and graph_readonly_role is LAST (it grants on an allow-list).
FILES = seed_run_files()

# The demo sign-in cast (u-operator holds `admin` in every tenant). Never part
# of the manifest or the default run; only `--demo-identities` applies it, and
# first, so the seeds that look users up (assessment_team_members_schema's
# EXISTS guard, access_schema's person re-link) find them.
DEMO_IDENTITIES = 'schema/seed_demo_identities.sql'

# The role created by graph_readonly_role.sql, and the Secrets Manager secret
# OrgIQ-Aurora mints for it. The SQL file deliberately creates the role with no
# password — the credential lives only in Secrets Manager, never in git — so
# the one `ALTER ROLE ... PASSWORD` statement is issued here, from the secret.
READONLY_ROLE = 'orgiq_graph_reader'
READONLY_SECRET_NAME = 'orgiq-aurora-readonly-credentials'

# Characters the generated password must not contain. The CDK secret generator
# excludes these (see infra/lib/aurora-stack.ts); we re-check rather than trust,
# because the only safe way to inline a password into ALTER ROLE is to know it
# holds no quote or backslash to escape.
_PASSWORD_FORBIDDEN = set("'\"\\`$;\n\r")


def _load_readonly_password(region: str) -> str | None:
    """Fetch the read-only role's password from Secrets Manager, or None.

    Missing, unreadable or malformed credentials return None. The caller counts
    this as failure: production read agents no longer fall back to admin.
    """
    import boto3
    sm = boto3.client('secretsmanager', region_name=region)
    name = os.environ.get('AURORA_READONLY_SECRET_ARN') or READONLY_SECRET_NAME
    try:
        raw = sm.get_secret_value(SecretId=name)['SecretString']
    except Exception as e:  # noqa: BLE001
        if 'ResourceNotFound' in type(e).__name__ or 'ResourceNotFound' in str(e):
            print(f'  ⊘ {name} not found — role left without a password '
                  '(deploy OrgIQ-Aurora, then re-run)')
            return None
        print(f'  ✗ could not read {name}: {str(e)[:160]}')
        return None

    import json
    try:
        payload = json.loads(raw)
        password = payload.get('password') if isinstance(payload, dict) else None
    except ValueError:
        password = None
    if not isinstance(password, str) or not password:
        print(f'  ✗ {name} has no "password" field')
        return None
    if set(password) & _PASSWORD_FORBIDDEN:
        # Fail loud rather than escape-and-hope. A password we cannot inline
        # safely is a generator bug, not something to work around here.
        print(f'  ✗ {name} password contains a character that cannot be '
              'safely inlined into ALTER ROLE — regenerate the secret')
        return None
    return password


def set_readonly_password(rds, arn: str, sec: str, db: str, region: str) -> int:
    """Give `orgiq_graph_reader` the password from Secrets Manager.

    Returns a failure count (0 or 1) so it folds into main()'s exit status.
    """
    print(f'{READONLY_SECRET_NAME}: setting {READONLY_ROLE} password')
    password = _load_readonly_password(region)
    if password is None:
        return 1  # production requires an authenticating reader credential

    sql = f"ALTER ROLE {READONLY_ROLE} WITH LOGIN PASSWORD '{password}'"
    for attempt in range(6):
        try:
            rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=sql)
            print(f'  ✓ {READONLY_ROLE} can now authenticate')
            return 0
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if any(r in msg for r in RETRYABLE) and attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            # Never echo the statement: it carries the password.
            print(f'  FAIL [ALTER ROLE {READONLY_ROLE} PASSWORD] -> {msg[:160]}')
            return 1
    return 1


def verify_readonly_role(rds, arn: str, sec: str, db: str) -> int:
    """Print what the role can actually do, straight from the engine.

    This is the only part of the proof that needs a live cluster — the offline
    tests can assert what the SQL *says*, but only PostgreSQL can say what it
    granted. Returns a failure count.
    """
    probe = f"""
        SELECT
          has_table_privilege('{READONLY_ROLE}', 'people', 'SELECT') AS can_select,
          has_table_privilege('{READONLY_ROLE}', 'people', 'INSERT') AS can_insert,
          has_table_privilege('{READONLY_ROLE}', 'people', 'UPDATE') AS can_update,
          has_table_privilege('{READONLY_ROLE}', 'people', 'DELETE') AS can_delete,
          has_schema_privilege('{READONLY_ROLE}', 'public', 'CREATE') AS can_create,
          (SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
             WHERE r.rolname = '{READONLY_ROLE}') AS owned_objects
    """
    try:
        resp = rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=probe)
    except Exception as e:  # noqa: BLE001
        print(f'  ✗ verification query failed: {str(e)[:160]}')
        return 1

    row = resp.get('records', [[]])[0]
    values = [list(cell.values())[0] if cell and not cell.get('isNull') else None for cell in row]
    names = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE on schema', 'owned objects']
    for name, value in zip(names, values):
        print(f'    {name:<16} {value}')

    can_select, can_insert, can_update, can_delete, can_create, owned = values
    problems = []
    if not can_select:
        problems.append('cannot SELECT (grants did not apply)')
    for label, flag in (('INSERT', can_insert), ('UPDATE', can_update),
                        ('DELETE', can_delete), ('CREATE', can_create)):
        if flag:
            problems.append(f'CAN {label} — the role is not read-only')
    if owned:
        problems.append(f'owns {owned} object(s) — an owner can always write')
    if problems:
        for p in problems:
            print(f'  ✗ {p}')
        return 1
    print('  ✓ read-only boundary confirmed by the engine')
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--readonly-role-only', action='store_true',
                        help='Apply reader grants/password only; do not replay demo seed data')
    parser.add_argument('--demo-identities', action='store_true',
                        help=f'Also apply {DEMO_IDENTITIES} (the demo sign-in cast, including an '
                             'all-tenant admin). Local and demo databases only.')
    options = parser.parse_args(argv)
    files = ['schema/graph_readonly_role.sql'] if options.readonly_role_only else FILES
    if options.demo_identities and not options.readonly_role_only:
        files = [DEMO_IDENTITIES, *files]
    arn, sec, db = get_cluster_info()
    rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    total_fail = 0

    for path in files:
        stmts = split_sql((REPO_ROOT / path).read_text(encoding='utf-8'))
        ok = skipped = failed = 0
        for st in stmts:
            for attempt in range(6):
                try:
                    rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=st)
                    ok += 1
                    break
                except Exception as e:
                    msg = str(e)
                    if 'already exists' in msg or 'duplicate key' in msg:
                        skipped += 1
                        break
                    if any(r in msg for r in RETRYABLE) and attempt < 5:
                        time.sleep(2 * (attempt + 1))
                        continue
                    failed += 1
                    print(f'  FAIL [{path}] {st[:70].replace(chr(10), " ")} -> {msg[:120]}')
                    break
        print(f'{path}: {ok} ok, {skipped} skipped, {failed} failed / {len(stmts)}')
        total_fail += failed

    # The read-only role's password (from Secrets Manager, never from a file)
    # and the engine's own answer about what that role can do.
    region = os.environ.get('AWS_REGION', 'us-east-1')
    total_fail += set_readonly_password(rds, arn, sec, db, region)
    total_fail += verify_readonly_role(rds, arn, sec, db)

    return 1 if total_fail else 0


if __name__ == '__main__':
    sys.exit(main())
