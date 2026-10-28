#!/usr/bin/env python3
"""Schema migrations with a ledger and an approval gate (DE-20).

    python -m schema.migrate status
    python -m schema.migrate plan [--only ID]
    python -m schema.migrate approve ID --sha DRY_RUN_SHA
    python -m schema.migrate apply [--schema-only] [--only ID]
    python -m schema.migrate gate --before middleware

Entries come from schema/manifest.json (see schema_manifest.py) and are
recorded in `schema_migrations` (schema_migrations_schema.sql):

- repeatable: idempotent files, re-applied when their checksum changes. The
  first apply on an existing cluster runs every one once (the baseline) and
  records it.
- versioned: run once, inside one transaction; a changed checksum after apply
  is an error, never a re-run.
- data: moves or rewrites rows. `plan` runs its dry run and stores the report
  and its sha; `approve` must quote that sha; `apply` re-runs the dry run and
  refuses when the approval is older than 24 hours, the affected rows grew by
  more than 5% or a new table appeared.
- seed: demo data; never run here.

Identities come from `sts get-caller-identity` (the Data API transport) or the
OS user (`--psql`, a local PostgreSQL), never from a flag.

Exit codes: 0 ok, 1 a statement or command failed, 2 refused (approval
missing, stale or out of tolerance; a versioned file changed), 3 the gate
found an unapplied data entry.
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:  # `python -m schema.migrate` from the repo root
    from .load_schema import execute_with_retry, get_cluster_info, split_sql, warm_up
    from .schema_manifest import MANIFEST_PATH, SCHEMA_DIR, entry_checksum, load_manifest
except ImportError:  # `python -m unittest test_migrate` from schema/
    from load_schema import execute_with_retry, get_cluster_info, split_sql, warm_up
    from schema_manifest import MANIFEST_PATH, SCHEMA_DIR, entry_checksum, load_manifest

REPO_ROOT = SCHEMA_DIR.parent
LEDGER_FILE = SCHEMA_DIR / 'schema_migrations_schema.sql'

# Report tolerance between approval and apply (the spec's recommended default).
APPROVAL_TTL_HOURS = 24
ROW_GROWTH_PCT = 5

OK, FAILED, REFUSED, GATED = 0, 1, 2, 3
_TX_CONTROL = re.compile(r'^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;?$', re.I)


class MigrationError(Exception):
    pass


# --- transports -----------------------------------------------------------

def _literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql, params):
    """Inline `:name` parameters as literals (local psql transport only)."""
    if not params:
        return sql

    def sub(m):
        name = m.group(1)
        if name not in params:
            raise MigrationError(f'unbound parameter :{name}')
        return _literal(params[name])
    return re.sub(r'(?<![:\w]):([A-Za-z_]\w*)', sub, sql)


def _strip(sql):
    return sql.strip().rstrip(';').rstrip()


class DataApiExecutor:
    """The RDS Data API, with load_schema.py's retry for the scale-up race."""

    def __init__(self, rds, cluster_arn, secret_arn, db_name):
        self.rds, self.arn, self.secret, self.db = rds, cluster_arn, secret_arn, db_name

    @staticmethod
    def _params(params):
        out = []
        for name, value in (params or {}).items():
            if value is None:
                v = {'isNull': True}
            elif isinstance(value, bool):
                v = {'booleanValue': value}
            elif isinstance(value, int):
                v = {'longValue': value}
            else:
                v = {'stringValue': str(value)}
            out.append({'name': name, 'value': v})
        return out

    def _call(self, sql, params=None, **extra):
        if params:
            extra['parameters'] = self._params(params)
        return execute_with_retry(self.rds, self.arn, self.secret, self.db, sql, **extra)

    def warm(self):
        warm_up(self.rds, self.arn, self.secret, self.db)

    def query(self, sql, params=None):
        resp = self._call(_strip(sql), params, formatRecordsAs='JSON')
        return json.loads(resp.get('formattedRecords') or '[]')

    def execute(self, sql, params=None):
        self._call(sql, params)

    def transaction(self, statements):
        tx = self.rds.begin_transaction(resourceArn=self.arn, secretArn=self.secret,
                                        database=self.db)['transactionId']
        try:
            for stmt in statements:
                self._call(stmt, transactionId=tx)
            self.rds.commit_transaction(resourceArn=self.arn, secretArn=self.secret, transactionId=tx)
        except Exception:
            self.rds.rollback_transaction(resourceArn=self.arn, secretArn=self.secret, transactionId=tx)
            raise


class PsqlExecutor:
    """A local PostgreSQL through a psql command line, e.g.
    `docker exec -i <container> psql -U postgres -d <db>`. Each call is its own
    session; a transaction is sent as one BEGIN…COMMIT script."""

    def __init__(self, command):
        self.command = list(command)

    def _run(self, script):
        proc = subprocess.run(self.command + ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                              input=f'SET client_min_messages TO warning;\n{script}\n',
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise MigrationError(proc.stderr.strip() or f'psql exited {proc.returncode}')
        return proc.stdout

    def warm(self):
        self._run('SELECT 1;')

    def query(self, sql, params=None):
        out = self._run(f"WITH migrate_q AS ({_strip(bind(sql, params))}) "
                        "SELECT coalesce(json_agg(migrate_q), '[]'::json) FROM migrate_q;")
        # json_agg breaks lines between elements; -q leaves nothing else on stdout.
        return json.loads(out.strip() or '[]')

    def execute(self, sql, params=None):
        self._run(_strip(bind(sql, params)) + ';')

    def transaction(self, statements):
        self._run('BEGIN;\n' + '\n'.join(_strip(s) + ';' for s in statements) + '\nCOMMIT;')

    def run_batch(self, statements):
        """Fast path for an idempotent file: one session. False on any error so
        the caller falls back to statement-at-a-time."""
        try:
            self._run('\n'.join(_strip(s) + ';' for s in statements))
            return True
        except MigrationError:
            return False


def run_statements(executor, statements):
    """Apply an idempotent file the way load_schema.py does: `already exists`
    is success, anything else stops the entry."""
    batch = getattr(executor, 'run_batch', None)
    if batch is not None and batch(statements):
        return
    for i, stmt in enumerate(statements, 1):
        try:
            executor.execute(stmt)
        except Exception as e:  # noqa: BLE001
            if 'already exists' in str(e):
                continue
            raise MigrationError(f'statement {i}/{len(statements)}: {e}') from e


# --- the ledger -----------------------------------------------------------

class SqlLedger:
    """schema_migrations through any executor."""

    def __init__(self, executor):
        self.x = executor

    def ensure(self):
        run_statements(self.x, split_sql(LEDGER_FILE.read_text(encoding='utf-8')))

    def rows(self):
        rows = self.x.query(
            'SELECT id, kind, checksum, status, dry_run_report::text AS dry_run_report, dry_run_sha, '
            'approved_by, applied_by, applied_at::text AS applied_at, '
            'EXTRACT(EPOCH FROM now() - approved_at)::bigint AS approval_age_s '
            'FROM schema_migrations')
        out = {}
        for r in rows:
            if isinstance(r.get('dry_run_report'), str):
                r['dry_run_report'] = json.loads(r['dry_run_report'])
            out[r['id']] = r
        return out

    def record_applied(self, entry_id, kind, checksum, by, duration_ms):
        self.x.execute(
            "INSERT INTO schema_migrations (id, kind, checksum, status, applied_by, applied_at, duration_ms, updated_at) "
            "VALUES (:id, :kind, :checksum, 'applied', :by, now(), :ms, now()) "
            "ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, checksum = EXCLUDED.checksum, status = 'applied', "
            "applied_by = EXCLUDED.applied_by, applied_at = now(), duration_ms = EXCLUDED.duration_ms, "
            "last_error = NULL, updated_at = now()",
            {'id': entry_id, 'kind': kind, 'checksum': checksum, 'by': by, 'ms': int(duration_ms)})

    def record_failed(self, entry_id, kind, checksum, by, error, duration_ms):
        self.x.execute(
            "INSERT INTO schema_migrations (id, kind, checksum, status, applied_by, duration_ms, last_error, updated_at) "
            "VALUES (:id, :kind, :checksum, 'failed', :by, :ms, :error, now()) "
            "ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, status = 'failed', "
            "applied_by = EXCLUDED.applied_by, duration_ms = EXCLUDED.duration_ms, "
            "last_error = EXCLUDED.last_error, updated_at = now()",
            {'id': entry_id, 'kind': kind, 'checksum': checksum, 'by': by, 'ms': int(duration_ms),
             'error': str(error)[:2000]})

    def record_plan(self, entry_id, kind, checksum, report, sha, by):
        # A re-plan keeps an approval only when neither the report nor the
        # entry changed; otherwise the approver has to look again.
        keep = ("schema_migrations.status = 'approved' AND schema_migrations.dry_run_sha = EXCLUDED.dry_run_sha "
                "AND schema_migrations.checksum = EXCLUDED.checksum")
        self.x.execute(
            "INSERT INTO schema_migrations (id, kind, checksum, status, dry_run_report, dry_run_sha, planned_by, planned_at, updated_at) "
            "VALUES (:id, :kind, :checksum, 'planned', CAST(:report AS JSONB), :sha, :by, now(), now()) "
            f"ON CONFLICT (id) DO UPDATE SET status = CASE WHEN {keep} THEN 'approved' ELSE 'planned' END, "
            f"approved_by = CASE WHEN {keep} THEN schema_migrations.approved_by ELSE NULL END, "
            f"approved_at = CASE WHEN {keep} THEN schema_migrations.approved_at ELSE NULL END, "
            "checksum = EXCLUDED.checksum, dry_run_report = EXCLUDED.dry_run_report, "
            "dry_run_sha = EXCLUDED.dry_run_sha, planned_by = EXCLUDED.planned_by, planned_at = now(), "
            "last_error = NULL, updated_at = now()",
            {'id': entry_id, 'kind': kind, 'checksum': checksum, 'report': json.dumps(report, sort_keys=True),
             'sha': sha, 'by': by})

    def record_approval(self, entry_id, sha, by):
        rows = self.x.query(
            "UPDATE schema_migrations SET status = 'approved', approved_by = :by, approved_at = now(), "
            "updated_at = now() WHERE id = :id AND dry_run_sha = :sha AND status IN ('planned', 'approved') "
            "RETURNING id", {'id': entry_id, 'sha': sha, 'by': by})
        return bool(rows)


# --- reports --------------------------------------------------------------

def report_sha(report):
    return hashlib.sha256(json.dumps(report, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def sql_report(rows):
    """A dry-run query's (name, rows) pairs → the stored report."""
    tables = {str(r['name']): int(r['rows'] or 0) for r in rows}
    return {'affected_rows': sum(tables.values()), 'tables': tables}


def command_report(entry, raw):
    spec = entry.get('report') or {}
    fields = spec.get('fields')
    detail = {k: raw.get(k) for k in fields} if fields else raw
    rows_key = spec.get('rows')
    affected = int(raw.get(rows_key) or 0) if rows_key else 0
    return {'affected_rows': affected, 'detail': detail}


def within_tolerance(approved, fresh, pct=ROW_GROWTH_PCT):
    """(ok, reason) for applying `fresh` under an approval of `approved`."""
    if not isinstance(approved, dict):
        return False, 'no approved report on record'
    new_tables = sorted(set((fresh.get('tables') or {})) - set((approved.get('tables') or {})))
    if new_tables:
        return False, f"new table(s) since approval: {', '.join(new_tables)}"
    before, now = int(approved.get('affected_rows') or 0), int(fresh.get('affected_rows') or 0)
    if now > before and (before == 0 or (now - before) * 100 > pct * before):
        return False, f'affected rows grew from {before} to {now} (more than {pct}%)'
    return True, ''


# --- the runner -----------------------------------------------------------

def default_run_command(argv, cwd):
    return subprocess.run(argv, cwd=cwd).returncode


class Runner:
    def __init__(self, executor, ledger, identity, manifest_path=None, schema_dir=None,
                 out=print, run_command=default_run_command):
        self.x, self.ledger, self.identity = executor, ledger, identity
        self.manifest_path = Path(manifest_path or MANIFEST_PATH)
        self.schema_dir = Path(schema_dir or SCHEMA_DIR)
        self.entries = load_manifest(self.manifest_path)['entries']
        self.out, self.run_command = out, run_command
        self._who = None

    def who(self):
        if self._who is None:
            self._who = self.identity()
        return self._who

    def _entries(self, only=None, kinds=None):
        chosen = [e for e in self.entries if (only is None or e['id'] == only)
                  and (kinds is None or e['kind'] in kinds)]
        if only is not None and not chosen:
            raise MigrationError(f'no manifest entry {only!r} of a runnable kind')
        return chosen

    def _statements(self, rel):
        stmts = split_sql((self.schema_dir / rel).read_text(encoding='utf-8'))
        return [s for s in stmts if not _TX_CONTROL.match(s.strip())]

    def _commands(self, entry_id):
        return ('  python -m schema.migrate plan --only {0}\n'
                '  python -m schema.migrate approve {0} --sha <dry_run_sha from plan>\n'
                '  python -m schema.migrate apply --only {0}').format(entry_id)

    # dry runs
    def dry_run(self, entry):
        if entry.get('dry_run_file'):
            stmts = self._statements(entry['dry_run_file'])
            if len(stmts) != 1:
                raise MigrationError(f"{entry['id']}: a dry-run file must hold one query")
            return sql_report(self.x.query(stmts[0]))
        return command_report(entry, self._run_entry_command(entry, 'dry_run_command'))

    def _run_entry_command(self, entry, key):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = os.path.join(tmp, 'report.json')
            argv = [a.replace('{report}', report_path) for a in entry[key]]
            cwd = REPO_ROOT / entry.get('cwd', '.')
            code = self.run_command(argv, str(cwd))
            if code != 0:
                raise MigrationError(f"{entry['id']}: {' '.join(argv)} exited {code}")
            if not os.path.exists(report_path):
                return {}
            with open(report_path, encoding='utf-8') as f:
                return json.load(f)

    # commands
    def status(self):
        self.ledger.ensure()
        rows = self.ledger.rows()
        self.out(f"{'id':44} {'kind':10} {'status':9} {'checksum':9} approved_by / applied_at")
        for e in self.entries:
            if e['kind'] == 'seed':
                continue
            row = rows.get(e['id'])
            if row is None:
                self.out(f"{e['id']:44} {e['kind']:10} {'pending':9} {'-':9}")
                continue
            match = 'ok' if row['checksum'] == entry_checksum(e, self.schema_dir) else 'changed'
            self.out(f"{e['id']:44} {e['kind']:10} {row['status']:9} {match:9} "
                     f"{row.get('approved_by') or '-'} / {row.get('applied_at') or '-'}")
        return OK

    def plan(self, only=None):
        self.ledger.ensure()
        rows = self.ledger.rows()
        for e in self._entries(only, ('data',)):
            if (rows.get(e['id']) or {}).get('status') == 'applied':
                continue
            report = self.dry_run(e)
            sha = report_sha(report)
            self.ledger.record_plan(e['id'], e['kind'], entry_checksum(e, self.schema_dir), report, sha, self.who())
            self.out(f"planned {e['id']}: {json.dumps(report, sort_keys=True)}")
            self.out(f"  approve with: python -m schema.migrate approve {e['id']} --sha {sha}")
        return OK

    def approve(self, entry_id, sha):
        self.ledger.ensure()
        row = self.ledger.rows().get(entry_id)
        entry = next((e for e in self.entries if e['id'] == entry_id), None)
        if entry is None or entry['kind'] != 'data':
            self.out(f'✗ {entry_id} is not a data entry in the manifest')
            return REFUSED
        if row is None or row['status'] not in ('planned', 'approved') or not row.get('dry_run_sha'):
            self.out(f'✗ {entry_id} has no plan to approve; run plan first')
            return REFUSED
        if sha != row['dry_run_sha']:
            self.out(f"✗ refused: {sha} is not the latest plan's sha ({row['dry_run_sha']}); re-read the plan")
            return REFUSED
        if row['checksum'] != entry_checksum(entry, self.schema_dir):
            self.out(f'✗ refused: {entry_id} changed since it was planned; run plan again')
            return REFUSED
        if not self.ledger.record_approval(entry_id, sha, self.who()):
            self.out(f'✗ refused: the plan for {entry_id} changed underneath this approval')
            return REFUSED
        self.out(f'✓ {entry_id} approved by {self.who()}')
        return OK

    def apply(self, schema_only=False, only=None):
        kinds = ('repeatable', 'versioned') if schema_only else ('repeatable', 'versioned', 'data')
        self.ledger.ensure()
        rows = self.ledger.rows()
        for e in self._entries(only, kinds):
            code = getattr(self, f"_apply_{e['kind']}")(e, rows.get(e['id']))
            if code != OK:
                return code
        self.out('✓ migrations applied')
        return OK

    def gate(self, before):
        self.ledger.ensure()
        rows = self.ledger.rows()
        blocked = [e for e in self.entries if e['kind'] == 'data' and e.get('before') == before
                   and (rows.get(e['id']) or {}).get('status') != 'applied']
        for e in blocked:
            self.out(f"✗ {e['id']} must be applied before {before} deploys. Run:")
            self.out(self._commands(e['id']))
        return GATED if blocked else OK

    # per kind
    def _timed(self, e, checksum, work):
        started = time.monotonic()
        try:
            work()
        except Exception as err:  # noqa: BLE001
            ms = (time.monotonic() - started) * 1000
            self.ledger.record_failed(e['id'], e['kind'], checksum, self.who(), err, ms)
            self.out(f"✗ {e['id']} failed: {err}")
            return FAILED
        ms = (time.monotonic() - started) * 1000
        self.ledger.record_applied(e['id'], e['kind'], checksum, self.who(), ms)
        self.out(f"✓ {e['id']} ({e['kind']}, {int(ms)} ms)")
        return OK

    def _apply_repeatable(self, e, row):
        checksum = entry_checksum(e, self.schema_dir)
        if row and row['status'] == 'applied' and row['checksum'] == checksum:
            return OK
        return self._timed(e, checksum, lambda: run_statements(self.x, self._statements(e['file'])))

    def _apply_versioned(self, e, row):
        checksum = entry_checksum(e, self.schema_dir)
        if row and row['status'] == 'applied':
            if row['checksum'] == checksum:
                return OK
            self.out(f"✗ {e['id']} is versioned and changed after it was applied; add a new entry instead")
            return REFUSED
        return self._timed(e, checksum, lambda: self.x.transaction(self._statements(e['file'])))

    def _apply_data(self, e, row):
        if row and row['status'] == 'applied':
            return OK
        checksum = entry_checksum(e, self.schema_dir)
        refusal = None
        if not row or row['status'] != 'approved':
            refusal = 'it is not approved'
        elif row['checksum'] != checksum:
            refusal = 'it changed since it was approved'
        elif row.get('approval_age_s') is None or int(row['approval_age_s']) > APPROVAL_TTL_HOURS * 3600:
            refusal = f'its approval is older than {APPROVAL_TTL_HOURS} hours'
        else:
            fresh = self.dry_run(e)
            ok, why = within_tolerance(row.get('dry_run_report'), fresh)
            if not ok:
                refusal = f'the dry run moved beyond tolerance ({why})'
        if refusal:
            self.out(f"✗ refused {e['id']}: {refusal}. Run:")
            self.out(self._commands(e['id']))
            return REFUSED
        if e.get('file'):
            return self._timed(e, checksum, lambda: self.x.transaction(self._statements(e['file'])))
        return self._timed(e, checksum, lambda: self._run_entry_command(e, 'apply_command'))


# --- CLI ------------------------------------------------------------------

def sts_identity():
    import boto3
    return boto3.client('sts', region_name=os.environ.get('AWS_REGION', 'us-east-1')).get_caller_identity()['Arn']


def local_identity():
    return f'local:{getpass.getuser()}'


def build(args):
    if args.psql:
        executor, identity = PsqlExecutor(shlex.split(args.psql)), local_identity
    else:
        import boto3
        cluster_arn, secret_arn, db_name = get_cluster_info()
        rds = boto3.client('rds-data', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
        executor, identity = DataApiExecutor(rds, cluster_arn, secret_arn, db_name), sts_identity
    executor.warm()
    return Runner(executor, SqlLedger(executor), identity, manifest_path=args.manifest)


def main(argv=None):
    p = argparse.ArgumentParser(prog='python -m schema.migrate', description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--psql', help='a local PostgreSQL psql command line instead of the Aurora Data API')
    p.add_argument('--manifest', help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status')
    sp = sub.add_parser('plan')
    sp.add_argument('--only')
    sa = sub.add_parser('approve')
    sa.add_argument('id')
    sa.add_argument('--sha', required=True)
    sx = sub.add_parser('apply')
    sx.add_argument('--schema-only', action='store_true')
    sx.add_argument('--only')
    sg = sub.add_parser('gate')
    sg.add_argument('--before', required=True)
    args = p.parse_args(argv)
    try:
        runner = build(args)
        if args.cmd == 'status':
            return runner.status()
        if args.cmd == 'plan':
            return runner.plan(args.only)
        if args.cmd == 'approve':
            return runner.approve(args.id, args.sha)
        if args.cmd == 'apply':
            return runner.apply(schema_only=args.schema_only, only=args.only)
        return runner.gate(args.before)
    except MigrationError as e:
        print(f'✗ {e}')
        return FAILED


if __name__ == '__main__':
    sys.exit(main())
