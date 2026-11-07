"""Offline tests for the migration ledger (DE-20). A fake executor and an
in-memory ledger stand in for PostgreSQL; test_migrate_postgres.py runs the
same runner against a real one."""
import contextlib
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import Mock

import migrate as m
import schema_manifest as sm


class FakeExecutor:
    def __init__(self):
        self.executed, self.transactions, self.dry_rows = [], [], []
        self.fail_on = None

    def _check(self, sql):
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f'ERROR: syntax error near {self.fail_on}')

    def execute(self, sql, params=None):
        self._check(sql)
        self.executed.append(sql)

    def query(self, sql, params=None):
        return list(self.dry_rows)

    def transaction(self, statements):
        for s in statements:
            self._check(s)
        self.transactions.append(list(statements))


class FakeLedger:
    def __init__(self):
        self.rows_by_id = {}

    def ensure(self):
        pass

    def rows(self):
        return {k: dict(v) for k, v in self.rows_by_id.items()}

    def _row(self, entry_id, kind, checksum):
        return self.rows_by_id.setdefault(entry_id, {'id': entry_id, 'kind': kind, 'checksum': checksum})

    def record_applied(self, entry_id, kind, checksum, by, duration_ms):
        self._row(entry_id, kind, checksum).update(checksum=checksum, status='applied', applied_by=by, applied_at='now')

    def record_failed(self, entry_id, kind, checksum, by, error, duration_ms):
        self._row(entry_id, kind, checksum).update(checksum=checksum, status='failed', last_error=str(error))

    def record_plan(self, entry_id, kind, checksum, report, sha, by):
        row = self._row(entry_id, kind, checksum)
        keep = row.get('status') == 'approved' and row.get('dry_run_sha') == sha and row.get('checksum') == checksum
        row.update(checksum=checksum, dry_run_report=json.loads(json.dumps(report)), dry_run_sha=sha,
                   status='approved' if keep else 'planned')
        if not keep:
            row.update(approved_by=None, approval_age_s=None)

    def record_approval(self, entry_id, sha, by):
        row = self.rows_by_id.get(entry_id)
        if not row or row.get('dry_run_sha') != sha:
            return False
        row.update(status='approved', approved_by=by, approval_age_s=0)
        return True


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / 'a_schema.sql').write_text('CREATE TABLE IF NOT EXISTS a (id int);\n')
        (self.dir / 'v_schema.sql').write_text('CREATE TABLE v (id int);\nINSERT INTO v VALUES (1);\n')
        (self.dir / 'd.sql').write_text('BEGIN;\nDELETE FROM a;\nCOMMIT;\n')
        (self.dir / 'd.dry-run.sql').write_text("SELECT 'table:a' AS name, count(*) AS rows FROM a;\n")
        (self.dir / 'seed.sql').write_text('INSERT INTO a VALUES (1);\n')
        self.manifest = self.dir / 'manifest.json'
        self.write_manifest()
        self.x, self.ledger, self.lines = FakeExecutor(), FakeLedger(), []
        self.commands = []
        self.envs = []

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self, extra=()):
        entries = [
            {'id': 'a', 'file': 'a_schema.sql', 'kind': 'repeatable'},
            {'id': 'v', 'file': 'v_schema.sql', 'kind': 'versioned'},
            {'id': 'seed', 'file': 'seed.sql', 'kind': 'seed'},
            {'id': 'd', 'file': 'd.sql', 'dry_run_file': 'd.dry-run.sql', 'kind': 'data', 'before': 'middleware'},
            *extra,
        ]
        self.manifest.write_text(json.dumps({'entries': entries, 'seed_run': ['a', 'seed']}))

    def runner(self, run_command=None):
        def run(argv, cwd, env=None):
            self.commands.append(argv)
            self.envs.append(env)
            return run_command(argv) if run_command else 0
        return m.Runner(self.x, self.ledger, lambda: 'arn:aws:sts::1:assumed-role/dev/alice',
                        manifest_path=self.manifest, schema_dir=self.dir,
                        out=self.lines.append, run_command=run)

    def test_a_changed_checksum_reapplies_a_repeatable_file(self):
        self.assertEqual(self.runner().apply(schema_only=True), m.OK)
        self.assertEqual(self.x.executed, ['CREATE TABLE IF NOT EXISTS a (id int);'])
        self.assertEqual(self.runner().apply(schema_only=True), m.OK)
        self.assertEqual(len(self.x.executed), 1, 'an unchanged repeatable file must not re-run')
        (self.dir / 'a_schema.sql').write_text('CREATE TABLE IF NOT EXISTS a (id int);\nALTER TABLE a ADD COLUMN IF NOT EXISTS b int;\n')
        self.assertEqual(self.runner().apply(schema_only=True), m.OK)
        self.assertEqual(self.x.executed[1:], ['CREATE TABLE IF NOT EXISTS a (id int);',
                                               'ALTER TABLE a ADD COLUMN IF NOT EXISTS b int;'])
        self.assertEqual(self.ledger.rows()['a']['applied_by'], 'arn:aws:sts::1:assumed-role/dev/alice')

    def test_a_versioned_entry_runs_once_in_one_transaction(self):
        self.runner().apply(schema_only=True)
        self.runner().apply(schema_only=True)
        self.assertEqual(self.x.transactions, [['CREATE TABLE v (id int);', 'INSERT INTO v VALUES (1);']])
        (self.dir / 'v_schema.sql').write_text('CREATE TABLE v (id bigint);\n')
        self.assertEqual(self.runner().apply(schema_only=True), m.REFUSED)
        self.assertEqual(len(self.x.transactions), 1, 'a changed versioned file is an error, never a re-run')

    def test_schema_only_never_runs_data_or_seed(self):
        self.runner().apply(schema_only=True)
        self.assertNotIn('d', self.ledger.rows())
        self.assertNotIn('seed', self.ledger.rows())
        self.assertFalse(any('DELETE' in s for t in self.x.transactions for s in t))

    def test_a_data_entry_is_refused_without_approval(self):
        self.assertEqual(self.runner().apply(), m.REFUSED)
        self.assertIn('not approved', '\n'.join(self.lines))
        self.assertIn('python -m schema.migrate approve d --sha', '\n'.join(self.lines))
        self.assertFalse(any('DELETE' in s for t in self.x.transactions for s in t))
        self.x.dry_rows = [{'name': 'table:a', 'rows': 3}]
        self.runner().plan()
        self.assertEqual(self.ledger.rows()['d']['status'], 'planned')
        self.assertEqual(self.runner().apply(), m.REFUSED, 'planned is not approved')

    def test_a_stale_sha_is_refused_and_the_latest_one_applies(self):
        self.x.dry_rows = [{'name': 'table:a', 'rows': 3}]
        self.runner().plan()
        stale = self.ledger.rows()['d']['dry_run_sha']
        self.x.dry_rows = [{'name': 'table:a', 'rows': 4}]
        self.runner().plan()
        latest = self.ledger.rows()['d']['dry_run_sha']
        self.assertNotEqual(stale, latest)
        self.assertEqual(self.runner().approve('d', stale), m.REFUSED)
        self.assertEqual(self.ledger.rows()['d']['status'], 'planned')
        self.assertEqual(self.runner().approve('d', latest), m.OK)
        self.assertEqual(self.ledger.rows()['d']['approved_by'], 'arn:aws:sts::1:assumed-role/dev/alice')
        self.assertEqual(self.runner().apply(), m.OK)
        self.assertEqual(self.x.transactions[-1], ['DELETE FROM a;'], 'BEGIN/COMMIT are the runner\'s, not the file\'s')
        self.assertEqual(self.ledger.rows()['d']['status'], 'applied')

    def test_a_replan_with_a_different_report_withdraws_the_approval(self):
        self.x.dry_rows = [{'name': 'table:a', 'rows': 3}]
        self.runner().plan()
        self.runner().approve('d', self.ledger.rows()['d']['dry_run_sha'])
        self.runner().plan()
        self.assertEqual(self.ledger.rows()['d']['status'], 'approved', 'same report keeps the approval')
        self.x.dry_rows = [{'name': 'table:a', 'rows': 9}]
        self.runner().plan()
        self.assertEqual(self.ledger.rows()['d']['status'], 'planned')

    def approved(self, rows=100):
        self.x.dry_rows = [{'name': 'table:a', 'rows': rows}]
        self.runner().plan()
        self.runner().approve('d', self.ledger.rows()['d']['dry_run_sha'])

    def test_apply_refuses_growth_beyond_tolerance_a_new_table_or_an_old_approval(self):
        self.approved(100)
        self.x.dry_rows = [{'name': 'table:a', 'rows': 106}]
        self.assertEqual(self.runner().apply(only='d'), m.REFUSED)
        self.assertIn('grew from 100 to 106', '\n'.join(self.lines))
        self.x.dry_rows = [{'name': 'table:a', 'rows': 100}, {'name': 'table:b', 'rows': 0}]
        self.assertEqual(self.runner().apply(only='d'), m.REFUSED)
        self.assertIn('new table(s) since approval: table:b', '\n'.join(self.lines))
        self.x.dry_rows = [{'name': 'table:a', 'rows': 105}]
        self.ledger.rows_by_id['d']['approval_age_s'] = 25 * 3600
        self.assertEqual(self.runner().apply(only='d'), m.REFUSED)
        self.assertIn('older than 24 hours', '\n'.join(self.lines))
        self.ledger.rows_by_id['d']['approval_age_s'] = 60
        self.assertEqual(self.runner().apply(only='d'), m.OK, '5% growth is within tolerance')

    def test_a_changed_data_entry_needs_a_new_plan(self):
        self.approved()
        (self.dir / 'd.sql').write_text('DELETE FROM a WHERE id > 0;\n')
        self.assertEqual(self.runner().apply(only='d'), m.REFUSED)
        self.assertIn('changed since it was approved', '\n'.join(self.lines))

    def test_a_failure_records_failed_and_exits_non_zero(self):
        self.x.fail_on = 'INSERT INTO v'
        self.assertEqual(self.runner().apply(schema_only=True), m.FAILED)
        row = self.ledger.rows()['v']
        self.assertEqual(row['status'], 'failed')
        self.assertIn('syntax error', row['last_error'])
        self.assertEqual(self.ledger.rows()['a']['status'], 'applied')
        self.x.fail_on = None
        self.assertEqual(self.runner().apply(schema_only=True), m.OK, 'a failed versioned entry retries')
        self.assertEqual(self.ledger.rows()['v']['status'], 'applied')

    def test_a_failing_repeatable_statement_stops_the_run(self):
        self.x.fail_on = 'CREATE TABLE IF NOT EXISTS a'
        self.assertEqual(self.runner().apply(schema_only=True), m.FAILED)
        self.assertEqual(self.ledger.rows()['a']['status'], 'failed')
        self.assertNotIn('v', self.ledger.rows(), 'nothing after a failure runs')

    def test_already_exists_is_success_for_a_repeatable_file(self):
        def execute(sql, params=None):
            raise RuntimeError('relation "a" already exists')
        self.x.execute = execute
        self.assertEqual(self.runner().apply(only='a'), m.OK)

    def test_the_gate_names_the_commands_for_an_unapplied_before_entry(self):
        self.assertEqual(self.runner().gate('middleware'), m.GATED)
        text = '\n'.join(self.lines)
        for cmd in ('plan --only d', 'approve d --sha', 'apply --only d'):
            self.assertIn(cmd, text)
        self.assertEqual(self.runner().gate('portal'), m.OK)
        self.approved()
        self.runner().apply(only='d')
        self.assertEqual(self.runner().gate('middleware'), m.OK)

    def test_a_command_entry_runs_its_dry_run_and_apply_commands(self):
        self.write_manifest([{'id': 'c', 'kind': 'data', 'cwd': 'middleware',
                              'dry_run_command': ['tool', '--dry-run', '--report', '{report}'],
                              'apply_command': ['tool', '--report', '{report}'],
                              'report': {'rows': 'claimed', 'fields': ['claimed', 'perWorkItem']}}])

        def run(argv):
            Path(argv[-1]).write_text(json.dumps({'claimed': 9, 'perWorkItem': {'w': 9}, 'startedAt': 'volatile'}))
            return 0
        self.runner(run).plan(only='c')
        row = self.ledger.rows()['c']
        self.assertEqual(row['dry_run_report'], {'affected_rows': 9, 'detail': {'claimed': 9, 'perWorkItem': {'w': 9}}})
        self.runner(run).approve('c', row['dry_run_sha'])
        self.assertEqual(self.runner(run).apply(only='c'), m.OK)
        self.assertEqual([c[:2] for c in self.commands], [['tool', '--dry-run'], ['tool', '--dry-run'], ['tool', '--report']])
        self.assertEqual(self.runner(lambda argv: 1).apply(only='c'), m.OK, 'applied entries do not re-run')

    def test_an_entry_env_fills_only_what_the_shell_leaves_unset(self):
        entry = {'id': 'c', 'kind': 'data', 'env': {'MIGRATE_TEST_STORE': 'dynamo', 'MIGRATE_TEST_PREFIX': 'p-'},
                 'dry_run_command': ['tool', '--report', '{report}'], 'apply_command': ['tool']}
        self.write_manifest([entry])
        with mock.patch.dict(os.environ, {'MIGRATE_TEST_PREFIX': 'operator-'}):
            self.runner().plan(only='c')
        self.assertEqual(self.envs[-1]['MIGRATE_TEST_STORE'], 'dynamo')
        self.assertEqual(self.envs[-1]['MIGRATE_TEST_PREFIX'], 'operator-')
        without = {k: v for k, v in entry.items() if k != 'env'}
        self.assertEqual(sm.entry_checksum(entry, self.dir), sm.entry_checksum(without, self.dir),
                         'env is operator config, so adding it never re-plans an applied entry')

    def test_a_failing_command_records_failed(self):
        self.write_manifest([{'id': 'c', 'kind': 'data', 'dry_run_command': ['t', '{report}'],
                              'apply_command': ['t', '{report}'], 'report': {'rows': 'n'}}])
        ok = lambda argv: (Path(argv[-1]).write_text('{"n": 1}'), 0)[1]  # noqa: E731
        self.runner(ok).plan(only='c')
        self.runner(ok).approve('c', self.ledger.rows()['c']['dry_run_sha'])
        calls = iter([ok, lambda argv: 7])
        self.assertEqual(self.runner(lambda argv: next(calls)(argv)).apply(only='c'), m.FAILED)
        self.assertEqual(self.ledger.rows()['c']['status'], 'failed')
        self.assertIn('exited 7', self.ledger.rows()['c']['last_error'])


class PieceTests(unittest.TestCase):
    def test_tolerance(self):
        base = {'affected_rows': 100, 'tables': {'t': 100}}
        self.assertTrue(m.within_tolerance(base, {'affected_rows': 105, 'tables': {'t': 105}})[0])
        self.assertFalse(m.within_tolerance(base, {'affected_rows': 106, 'tables': {'t': 106}})[0])
        self.assertTrue(m.within_tolerance(base, {'affected_rows': 10, 'tables': {'t': 10}})[0])
        self.assertFalse(m.within_tolerance({'affected_rows': 0}, {'affected_rows': 1})[0])
        self.assertFalse(m.within_tolerance(None, {'affected_rows': 0})[0])

    def test_report_sha_ignores_key_order(self):
        self.assertEqual(m.report_sha({'a': 1, 'b': 2}), m.report_sha({'b': 2, 'a': 1}))

    def test_bind_inlines_literals_and_leaves_casts(self):
        self.assertEqual(m.bind("SELECT :a, :n, CAST(:r AS JSONB), x::text, :z", {'a': "it's", 'n': 3, 'r': '{}', 'z': None}),
                         "SELECT 'it''s', 3, CAST('{}' AS JSONB), x::text, NULL")
        with self.assertRaises(m.MigrationError):
            m.bind('SELECT :missing', {'other': 1})

    def test_data_api_transaction_commits_or_rolls_back(self):
        rds = Mock()
        rds.begin_transaction.return_value = {'transactionId': 'tx-1'}
        x = m.DataApiExecutor(rds, 'arn', 'secret', 'db')
        x.transaction(['CREATE TABLE t (id int)'])
        self.assertEqual(rds.execute_statement.call_args.kwargs['transactionId'], 'tx-1')
        rds.commit_transaction.assert_called_once()
        rds.execute_statement.side_effect = RuntimeError('ERROR: boom')
        with self.assertRaises(RuntimeError):
            x.transaction(['CREATE TABLE t (id int)'])
        rds.rollback_transaction.assert_called_once()

    def test_identity_is_never_a_flag(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            m.main(['--by', 'someone', 'status'])


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.data = sm.load_manifest()
        self.ids = [e['id'] for e in self.data['entries']]

    def test_every_file_exists_and_the_ledger_is_first(self):
        for e in self.data['entries']:
            for key in ('file', 'dry_run_file'):
                if e.get(key):
                    self.assertTrue((sm.SCHEMA_DIR / e[key]).is_file(), e[key])
        self.assertEqual(self.data['entries'][0]['file'], 'schema_migrations_schema.sql')

    def test_both_loaders_read_the_manifest(self):
        import apply_all_seed
        import load_schema
        for path in ('load_schema.py', 'apply_all_seed.py'):
            self.assertEqual(len(re.findall(r"_schema\.sql'", (sm.SCHEMA_DIR / path).read_text())), 0, path)
        self.assertIn('manifest_schema_files()', (sm.SCHEMA_DIR / 'load_schema.py').read_text())
        self.assertEqual(apply_all_seed.FILES, sm.seed_run_files())
        self.assertTrue(hasattr(load_schema, 'manifest_schema_files'))

    def test_the_demo_cast_is_never_loaded_by_default(self):
        # identity_schema.sql is a repeatable entry every deploy loads; the demo
        # accounts (u-operator is admin in every tenant) live apart from it and
        # only `apply_all_seed.py --demo-identities` applies them.
        import apply_all_seed
        identity = (sm.SCHEMA_DIR / 'identity_schema.sql').read_text()
        self.assertNotRegex(identity, r'INSERT INTO (app_users|user_tenant_roles)\b')
        self.assertNotIn("('u-", identity)
        demo = (sm.SCHEMA_DIR / 'seed_demo_identities.sql').read_text()
        self.assertIn("('u-operator', 'orgiq',    'admin')", demo)
        files = [e.get('file') for e in self.data['entries']]
        self.assertNotIn('seed_demo_identities.sql', files)
        self.assertNotIn('schema/seed_demo_identities.sql', sm.seed_run_files())
        self.assertNotIn('schema/seed_demo_identities.sql', apply_all_seed.FILES)
        self.assertEqual(apply_all_seed.DEMO_IDENTITIES, 'schema/seed_demo_identities.sql')

    def test_order_constraints_survive(self):
        files = sm.schema_files()
        self.assertEqual(files.index('spend_ledger_schema.sql'), files.index('program_schema.sql') + 1)
        self.assertLess(files.index('agent_bots_schema.sql'), files.index('agent_budgets_schema.sql'))
        self.assertNotIn('environments_schema.sql', files, 'its tail needs seed rows')
        seed = sm.seed_run_files()
        self.assertEqual(seed[-1], 'schema/graph_readonly_role.sql')
        self.assertLess(seed.index('schema/seed_program.sql'), seed.index('schema/environments_schema.sql'))

    def test_the_page_thread_migration_gates_the_middleware(self):
        e = next(e for e in self.data['entries'] if e['id'] == '2026-10-27-page-thread')
        self.assertEqual((e['kind'], e['before']), ('data', 'middleware'))
        self.assertIn('--dry-run', e['dry_run_command'])
        self.assertNotIn('--dry-run', e['apply_command'])
        drop = next(e for e in self.data['entries'] if e['id'] == '2026-09-05-drop-newsroom')
        self.assertEqual(drop['kind'], 'data')

    def test_malformed_manifests_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'm.json'
            for bad in ({'entries': []}, {'entries': [{'id': 'x', 'kind': 'weird', 'file': 'x'}]},
                        {'entries': [{'id': 'x', 'kind': 'data', 'file': 'x'}]},
                        {'entries': [{'id': 'x', 'kind': 'seed', 'file': 'x'}], 'seed_run': ['y']}):
                p.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    sm.load_manifest(p)


if __name__ == '__main__':
    unittest.main()
