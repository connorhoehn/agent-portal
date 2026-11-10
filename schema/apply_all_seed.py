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
import json
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
# p-* cast), graph_readonly_role grants on an allow-list, and row_level_security
# is LAST (it names both files' roles and every tenant table).
FILES = seed_run_files()

# The demo sign-in cast (u-operator holds `admin` in every tenant). Never part
# of the manifest or the default run; only `--with-demo-users` (old name
# `--demo-identities`) applies it, and first, so the seeds that look users up
# (assessment_team_members_schema's EXISTS guard, access_schema's person
# re-link) find them. The switch refuses a production target (below).
DEMO_IDENTITIES = 'schema/seed_demo_identities.sql'

# The target environment: infra/environments/<name>.json (the file CDK deploys
# from, DE-17), named by --env or ORGIQ_ENV, default `lab`. A file with
# "production": true is a production target.
ENVIRONMENTS_DIR = REPO_ROOT / 'infra' / 'environments'
DEFAULT_ENVIRONMENT = 'lab'


def _is_production_word(value) -> bool:
    return isinstance(value, str) and value.strip().lower() in ('production', 'prod')


def demo_users_refusal(env_name: str | None, environ=None, env_dir: Path = ENVIRONMENTS_DIR) -> str | None:
    """Why the demo cast may not be applied to this target, or None when it may.

    Refused when the target environment's file says "production": true, when
    the file cannot be read (an unknown target is not assumed safe), or when
    this shell says production (NODE_ENV / APP_ENV)."""
    environ = os.environ if environ is None else environ
    for var in ('NODE_ENV', 'APP_ENV'):
        if _is_production_word(environ.get(var)):
            return f'{var}={environ.get(var)} names a production target'
    name = (env_name or environ.get('ORGIQ_ENV') or DEFAULT_ENVIRONMENT).strip()
    if not name or '/' in name or name.startswith('.'):
        return f'environment name {name!r} is not valid'
    path = env_dir / f'{name}.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return f'environment {name!r} cannot be read ({path.name}: {exc.__class__.__name__})'
    if not isinstance(data, dict):
        return f'environment {name!r} is not a JSON object'
    if data.get('production') is True:
        return f'environment {name!r} is marked "production": true'
    return None

# The role created by graph_readonly_role.sql, and the Secrets Manager secret
# OrgIQ-Aurora mints for it. The SQL file deliberately creates the role with no
# password — the credential lives only in Secrets Manager, never in git — so
# the one `ALTER ROLE ... PASSWORD` statement is issued here, from the secret.
READONLY_ROLE = 'orgiq_graph_reader'
READONLY_SECRET_NAME = 'orgiq-aurora-readonly-credentials'

# The per-service logins created by service_roles.sql (work item 19), each
# with the secret OrgIQ-Aurora mints for it and the env var that overrides the
# secret id. The master secret (get_cluster_info) stays the one that applies
# schema; these are what the services run as.
SERVICE_ROLES = (
    ('orgiq_app_middleware', 'orgiq-aurora-middleware-credentials', 'AURORA_MIDDLEWARE_SECRET_ARN'),
    ('orgiq_graph_writer', 'orgiq-aurora-graph-writer-credentials', 'AURORA_GRAPH_WRITER_SECRET_ARN'),
    ('orgiq_kb_service', 'orgiq-aurora-kb-credentials', 'AURORA_KB_SECRET_ARN'),
)
ROLE_FILES = ['schema/service_roles.sql', 'schema/graph_readonly_role.sql', 'schema/row_level_security.sql']

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
    return _load_password(region, os.environ.get('AURORA_READONLY_SECRET_ARN') or READONLY_SECRET_NAME)


def _load_password(region: str, name: str) -> str | None:
    """Fetch one role's password from the named secret, or None."""
    import boto3
    sm = boto3.client('secretsmanager', region_name=region)
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


def set_service_role_passwords(rds, arn: str, sec: str, db: str, region: str) -> int:
    """Give each service role (service_roles.sql) the password from its secret.

    Returns the failure count. A missing secret is a failure: that service is
    deployed to authenticate as its role, and would otherwise get no database.
    """
    failures = 0
    for role, default_name, env in SERVICE_ROLES:
        name = os.environ.get(env) or default_name
        print(f'{name}: setting {role} password')
        password = _load_password(region, name)
        if password is None:
            failures += 1
            continue
        failures += _alter_role_password(rds, arn, sec, db, role, password)
    return failures


def _alter_role_password(rds, arn: str, sec: str, db: str, role: str, password: str) -> int:
    sql = f"ALTER ROLE {role} WITH LOGIN PASSWORD '{password}'"
    for attempt in range(6):
        try:
            rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=sql)
            print(f'  ✓ {role} can now authenticate')
            return 0
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if any(r in msg for r in RETRYABLE) and attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            # Never echo the statement: it carries the password.
            print(f'  FAIL [ALTER ROLE {role} PASSWORD] -> {msg[:160]}')
            return 1
    return 1


# What each service role must and must not be able to do, asked of the engine.
# (role, privilege check SQL expression, expected)
SERVICE_ROLE_PROBES = (
    ('orgiq_graph_writer', "has_table_privilege('orgiq_graph_writer', 'people', 'UPDATE')", True),
    ('orgiq_graph_writer', "has_table_privilege('orgiq_graph_writer', 'people', 'DELETE')", False),
    ('orgiq_graph_writer', "has_table_privilege('orgiq_graph_writer', 'app_users', 'SELECT')", False),
    ('orgiq_graph_writer', "has_schema_privilege('orgiq_graph_writer', 'public', 'CREATE')", False),
    ('orgiq_kb_service', "has_table_privilege('orgiq_kb_service', 'bedrock_kb', 'INSERT')", True),
    ('orgiq_kb_service', "has_table_privilege('orgiq_kb_service', 'people', 'SELECT')", False),
    ('orgiq_app_middleware', "has_table_privilege('orgiq_app_middleware', 'app_users', 'UPDATE')", True),
    ('orgiq_app_middleware', "has_table_privilege('orgiq_app_middleware', 'app_users', 'TRUNCATE')", False),
    ('orgiq_app_middleware', "(SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = 'orgiq_app_middleware')", False),
)


def verify_service_roles(rds, arn: str, sec: str, db: str) -> int:
    """Ask PostgreSQL what each service role can do; count the wrong answers."""
    sql = 'SELECT ' + ', '.join(expr for _, expr, _ in SERVICE_ROLE_PROBES)
    try:
        resp = rds.execute_statement(resourceArn=arn, secretArn=sec, database=db, sql=sql)
    except Exception as e:  # noqa: BLE001
        print(f'  ✗ service-role verification failed: {str(e)[:160]}')
        return 1
    row = resp.get('records', [[]])[0]
    values = [list(cell.values())[0] if cell and not cell.get('isNull') else None for cell in row]
    failures = 0
    for (role, expr, expected), got in zip(SERVICE_ROLE_PROBES, values):
        ok = bool(got) == expected
        failures += 0 if ok else 1
        print(f"    {'✓' if ok else '✗'} {expr} = {got} (want {expected})")
    if not failures:
        print('  ✓ service-role boundaries confirmed by the engine')
    return failures


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
    parser.add_argument('--roles-only', action='store_true',
                        help='Apply every role file (service roles + reader), set their passwords and verify; '
                             'no seed data. Run after every migration.')
    parser.add_argument('--with-demo-users', '--demo-identities', dest='demo_identities', action='store_true',
                        help=f'Also apply {DEMO_IDENTITIES} (the demo sign-in cast, including an '
                             'all-tenant admin). Local and demo databases only: refused for a '
                             'production environment.')
    parser.add_argument('--env', default=None,
                        help=f'Target environment (infra/environments/<name>.json); default ORGIQ_ENV '
                             f'or {DEFAULT_ENVIRONMENT}. Decides whether --with-demo-users is allowed.')
    options = parser.parse_args(argv)
    if options.demo_identities and not (options.readonly_role_only or options.roles_only):
        why = demo_users_refusal(options.env)
        if why:
            print(f'refusing --with-demo-users: {why}', file=sys.stderr)
            return 2
    if options.readonly_role_only:
        files = ['schema/graph_readonly_role.sql']
    elif options.roles_only:
        files = ROLE_FILES
    else:
        files = FILES
    if options.demo_identities and not (options.readonly_role_only or options.roles_only):
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
    # The service roles exist whenever service_roles.sql ran (every run but
    # --readonly-role-only).
    if not options.readonly_role_only:
        total_fail += set_service_role_passwords(rds, arn, sec, db, region)
        total_fail += verify_service_roles(rds, arn, sec, db)

    return 1 if total_fail else 0


if __name__ == '__main__':
    sys.exit(main())
