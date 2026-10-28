"""Opt-in: the migration ledger (DE-20) against a real, disposable PostgreSQL.

Only the transport differs from Aurora: statements go through psql inside a
dedicated container instead of the RDS Data API. The real manifest, the real
schema files and the real ledger SQL run. This does NOT establish Aurora, IAM
or Data API acceptance.

    REAL_MIGRATE_POSTGRES=1 ORGIQ_MIGRATE_POSTGRES_CONTAINER=<name> \\
      [ORGIQ_DOCKER='colima ssh -- sudo docker'] \\
      ../.venv-synth/bin/python -m unittest test_migrate_postgres

The container must carry the label orgiq.validation=de20 (pgvector/pgvector:pg16).
Each test creates and drops its own database.
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

import migrate as m
import schema_manifest as sm

ENABLED = os.environ.get('REAL_MIGRATE_POSTGRES') == '1'
CONTAINER = os.environ.get('ORGIQ_MIGRATE_POSTGRES_CONTAINER', '')
DOCKER = shlex.split(os.environ.get('ORGIQ_DOCKER', 'docker'))


def psql_command(db):
    return DOCKER + ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db]


@unittest.skipUnless(ENABLED, 'set REAL_MIGRATE_POSTGRES=1 and ORGIQ_MIGRATE_POSTGRES_CONTAINER')
class PostgresLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CONTAINER:
            raise RuntimeError('ORGIQ_MIGRATE_POSTGRES_CONTAINER is required')
        label = subprocess.run(DOCKER + ['inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', CONTAINER],
                               capture_output=True, text=True, check=True).stdout.strip()
        if label != 'de20':
            raise RuntimeError('Refusing a container without the dedicated acceptance label orgiq.validation=de20')

    def setUp(self):
        self.db = f'de20_{uuid.uuid4().hex[:10]}'
        m.PsqlExecutor(psql_command('postgres')).execute(f'CREATE DATABASE {self.db}')
        self.x = m.PsqlExecutor(psql_command(self.db))
        self.lines = []

    def tearDown(self):
        m.PsqlExecutor(psql_command('postgres')).execute(f'DROP DATABASE IF EXISTS {self.db} WITH (FORCE)')

    def runner(self, manifest=None, schema_dir=None, run_command=m.default_run_command):
        return m.Runner(self.x, m.SqlLedger(self.x), m.local_identity, manifest_path=manifest,
                        schema_dir=schema_dir, out=self.lines.append, run_command=run_command)

    def ledger(self):
        return {r['id']: r for r in self.x.query(
            'SELECT id, kind, checksum, status, approved_by, applied_by, applied_at::text AS applied_at, '
            'updated_at::text AS updated_at, duration_ms, last_error, dry_run_report, dry_run_sha FROM schema_migrations')}

    def test_the_real_manifest_baselines_records_and_gates(self):
        # Baseline: every repeatable file once, recorded with its checksum.
        self.assertEqual(self.runner().apply(schema_only=True), m.OK, '\n'.join(self.lines))
        rows = self.ledger()
        entries = sm.load_manifest()['entries']
        repeatable = [e for e in entries if e['kind'] == 'repeatable']
        self.assertEqual(sorted(rows), sorted(e['id'] for e in repeatable))
        for e in repeatable:
            self.assertEqual((rows[e['id']]['status'], rows[e['id']]['checksum']), ('applied', sm.entry_checksum(e)), e['id'])
            self.assertTrue(rows[e['id']]['applied_by'].startswith('local:'))
        self.assertTrue(self.x.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")[0]['ok'])

        # A second apply changes nothing.
        self.assertEqual(self.runner().apply(schema_only=True), m.OK)
        self.assertEqual({k: v['updated_at'] for k, v in self.ledger().items()},
                         {k: v['updated_at'] for k, v in rows.items()})

        # The page-thread entry gates a middleware deploy until applied.
        self.assertEqual(self.runner().gate('middleware'), m.GATED)
        self.assertIn('2026-10-27-page-thread', '\n'.join(self.lines))

        # drop-newsroom: plan sees the leftover table, a stale sha is refused,
        # the approved plan applies in one transaction.
        self.x.execute('CREATE TABLE pitches (id int)')
        self.x.execute("INSERT INTO pitches VALUES (1), (2)")
        self.x.execute("INSERT INTO tenants (id, display_name) VALUES ('newsroom', 'Newsroom') ON CONFLICT DO NOTHING")
        self.assertEqual(self.runner().apply(only='2026-09-05-drop-newsroom'), m.REFUSED)
        self.assertEqual(self.runner().plan(only='2026-09-05-drop-newsroom'), m.OK)
        row = self.ledger()['2026-09-05-drop-newsroom']
        self.assertEqual(row['status'], 'planned')
        self.assertEqual(row['dry_run_report']['tables']['table:pitches'], 2)
        self.assertEqual(row['dry_run_report']['tables']['tenants:newsroom'], 1)
        self.assertEqual(self.runner().approve('2026-09-05-drop-newsroom', '0' * 64), m.REFUSED)
        self.assertEqual(self.runner().approve('2026-09-05-drop-newsroom', row['dry_run_sha']), m.OK)
        self.assertTrue(self.ledger()['2026-09-05-drop-newsroom']['approved_by'].startswith('local:'))
        self.assertEqual(self.runner().apply(only='2026-09-05-drop-newsroom'), m.OK, '\n'.join(self.lines))
        self.assertEqual(self.ledger()['2026-09-05-drop-newsroom']['status'], 'applied')
        self.assertIsNone(self.x.query("SELECT to_regclass('pitches') AS t")[0]['t'])
        self.assertEqual(self.x.query("SELECT count(*) AS n FROM tenants WHERE id = 'newsroom'")[0]['n'], 0)

    def test_versioned_failure_tolerance_and_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'r.sql').write_text('CREATE TABLE IF NOT EXISTS r (id int);\n')
            (d / 'v.sql').write_text('CREATE TABLE v (id int);\nINSERT INTO v VALUES (1);\n')
            (d / 'bad.sql').write_text('CREATE TABLE bad (id int);\nINSERT INTO nowhere VALUES (1);\n')
            (d / 'd.sql').write_text('BEGIN;\nDELETE FROM r;\nCOMMIT;\n')
            (d / 'd.dry.sql').write_text("SELECT 'table:r' AS name, count(*) AS rows FROM r;\n")
            entries = [{'id': 'r', 'kind': 'repeatable', 'file': 'r.sql'},
                       {'id': 'v', 'kind': 'versioned', 'file': 'v.sql'},
                       {'id': 'd', 'kind': 'data', 'file': 'd.sql', 'dry_run_file': 'd.dry.sql'}]
            man = d / 'manifest.json'
            man.write_text(json.dumps({'entries': entries}))
            run = lambda: self.runner(man, d)  # noqa: E731

            self.assertEqual(run().apply(schema_only=True), m.OK)
            self.assertEqual(run().apply(schema_only=True), m.OK)
            self.assertEqual(self.x.query('SELECT count(*) AS n FROM v')[0]['n'], 1, 'versioned ran once')

            # A changed repeatable file re-applies.
            (d / 'r.sql').write_text('CREATE TABLE IF NOT EXISTS r (id int);\nALTER TABLE r ADD COLUMN IF NOT EXISTS note text;\n')
            self.assertEqual(run().apply(schema_only=True), m.OK)
            self.assertEqual(self.x.query("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'r' AND column_name = 'note'")[0]['n'], 1)

            # A failing versioned entry rolls back whole and records failed.
            man.write_text(json.dumps({'entries': entries + [{'id': 'bad', 'kind': 'versioned', 'file': 'bad.sql'}]}))
            self.assertEqual(run().apply(schema_only=True), m.FAILED)
            bad = self.ledger()['bad']
            self.assertEqual(bad['status'], 'failed')
            self.assertIn('nowhere', bad['last_error'])
            self.assertIsNone(self.x.query("SELECT to_regclass('bad') AS t")[0]['t'], 'the transaction rolled back')

            # Data: growth past 5% and an expired approval are refused.
            man.write_text(json.dumps({'entries': entries}))
            self.x.execute('INSERT INTO r (id) SELECT g FROM generate_series(1, 100) g')
            run().plan()
            run().approve('d', self.ledger()['d']['dry_run_sha'])
            self.x.execute('INSERT INTO r (id) SELECT g FROM generate_series(1, 6) g')
            self.assertEqual(run().apply(), m.REFUSED)
            self.x.execute('DELETE FROM r WHERE ctid IN (SELECT ctid FROM r WHERE id <= 6 LIMIT 6)')
            self.x.execute("UPDATE schema_migrations SET approved_at = now() - interval '25 hours' WHERE id = 'd'")
            self.assertEqual(run().apply(), m.REFUSED)
            self.assertIn('older than 24 hours', '\n'.join(self.lines))
            self.x.execute("UPDATE schema_migrations SET approved_at = now() WHERE id = 'd'")
            self.assertEqual(run().apply(), m.OK, '\n'.join(self.lines))
            self.assertEqual(self.x.query('SELECT count(*) AS n FROM r')[0]['n'], 0)
            self.assertEqual(self.ledger()['d']['status'], 'applied')

    def test_the_cli_reads_the_ledger(self):
        repo = sm.SCHEMA_DIR.parent
        cmd = shlex.join(psql_command(self.db))
        apply = subprocess.run([sys.executable, '-m', 'schema.migrate', '--psql', cmd, 'apply', '--schema-only'],
                               cwd=repo, capture_output=True, text=True)
        self.assertEqual(apply.returncode, 0, apply.stdout + apply.stderr)
        status = subprocess.run([sys.executable, '-m', 'schema.migrate', '--psql', cmd, 'status'],
                                cwd=repo, capture_output=True, text=True)
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertRegex(status.stdout, r'orgiq_schema\s+repeatable\s+applied\s+ok')
        self.assertRegex(status.stdout, r'2026-10-27-page-thread\s+data\s+pending')
        gate = subprocess.run([sys.executable, '-m', 'schema.migrate', '--psql', cmd, 'gate', '--before', 'middleware'],
                              cwd=repo, capture_output=True, text=True)
        self.assertEqual(gate.returncode, 3, gate.stdout)


if __name__ == '__main__':
    unittest.main()
