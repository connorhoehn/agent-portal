"""Opt-in: row-level security (work item 22) against a real, disposable PostgreSQL.

Loads every repeatable schema file through the migration runner, then the
three role files in seed-run order (service_roles, graph_readonly_role,
row_level_security), and queries as `orgiq_app_middleware` exactly the way the
middleware's Data API wrapper does: one transaction, `set_config('app.tenant',
…, true)` (the SQL is read from middleware/src/providers/db-tenant.ts), the
statement, commit. Only the transport differs from Aurora: psql in a container
instead of the RDS Data API. This does NOT establish Aurora or Data API binding.

    docker run -d --name orgiq-rls-postgres-acceptance --label orgiq.validation=rls \\
      -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg16
    REAL_RLS_POSTGRES=1 ORGIQ_RLS_POSTGRES_CONTAINER=orgiq-rls-postgres-acceptance \\
      [ORGIQ_DOCKER='colima ssh -- sudo docker'] \\
      ../.venv-synth/bin/python -m unittest test_row_level_security_postgres -v

The container must carry the label orgiq.validation=rls. Each run creates and
drops its own database; the roles are cluster-wide and re-applied idempotently.
RLS_MEASURE=1 also times the extra statements with pgbench and prints them.
"""
import os
import re
import shlex
import subprocess
import unittest
import uuid
from pathlib import Path

import migrate as m

ENABLED = os.environ.get('REAL_RLS_POSTGRES') == '1'
CONTAINER = os.environ.get('ORGIQ_RLS_POSTGRES_CONTAINER', '')
DOCKER = shlex.split(os.environ.get('ORGIQ_DOCKER', 'docker'))
REPO = Path(__file__).resolve().parent.parent
ROLE_FILES = ['service_roles.sql', 'graph_readonly_role.sql', 'row_level_security.sql']
APP = 'orgiq_app_middleware'


def set_tenant_sql():
    """The wrapper's own statement, with its one parameter bound."""
    source = (REPO / 'middleware/src/providers/db-tenant.ts').read_text()
    return re.search(r"SET_TENANT_SQL = \"([^\"]+)\"", source).group(1)


def psql(db, script, user='postgres'):
    proc = subprocess.run(DOCKER + ['exec', '-i', CONTAINER, 'psql', '-U', user, '-d', db,
                                    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                          input=f'SET client_min_messages TO warning;\n{script}\n', capture_output=True, text=True)
    if proc.returncode != 0:
        raise m.MigrationError(proc.stderr.strip())
    return proc.stdout.strip()


@unittest.skipUnless(ENABLED, 'set REAL_RLS_POSTGRES=1 and ORGIQ_RLS_POSTGRES_CONTAINER')
class RowLevelSecurityPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CONTAINER:
            raise RuntimeError('ORGIQ_RLS_POSTGRES_CONTAINER is required')
        label = subprocess.run(DOCKER + ['inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', CONTAINER],
                               capture_output=True, text=True, check=True).stdout.strip()
        if label != 'rls':
            raise RuntimeError('Refusing a container without the dedicated acceptance label orgiq.validation=rls')
        cls.db = f'rls_{uuid.uuid4().hex[:10]}'
        psql('postgres', f'CREATE DATABASE {cls.db}')
        x = m.PsqlExecutor(DOCKER + ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', cls.db])
        lines = []
        runner = m.Runner(x, m.SqlLedger(x), m.local_identity, out=lines.append)
        if runner.apply(schema_only=True) != m.OK:
            raise RuntimeError('schema load failed:\n' + '\n'.join(lines))
        for name in ROLE_FILES:
            psql(cls.db, (REPO / 'schema' / name).read_text())
        # Fixture rows, written by the owner (RLS does not bind the migrating login).
        psql(cls.db, """
            INSERT INTO app_users (id, display_name) VALUES ('u-a', 'A'), ('u-b', 'B') ON CONFLICT DO NOTHING;
            INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES
              ('u-a', 'orgiq', 'member'), ('u-b', 'assessment', 'assessor') ON CONFLICT DO NOTHING;
            INSERT INTO saved_searches (id, owner_sub, tenant_id, payload) VALUES
              ('00000000-0000-0000-0000-00000000000a', 'u-a', 'orgiq', '{}'),
              ('00000000-0000-0000-0000-00000000000b', 'u-b', 'assessment', '{}');
            INSERT INTO pipeline_runs (id, definition_id, context_tenant) VALUES ('job:rls-1', 'bot:x', 'orgiq');
            INSERT INTO access_catalog_items (id, kind, tenant, role, title, description, sensitive, default_duration, steward_rule)
              VALUES ('role:assessment:rls', 'tenant-role', 'assessment', 'assessor', 'T', 'D', false, '30d', 'tenant-steward')
              ON CONFLICT DO NOTHING;
            INSERT INTO access_requests (id, requester_id, beneficiary_id, item_id, justification, duration, status)
              VALUES ('req-rls', 'u-b', 'u-b', 'role:assessment:rls', 'j', '30d', 'pending');
        """)

    @classmethod
    def tearDownClass(cls):
        psql('postgres', f'DROP DATABASE IF EXISTS {cls.db} WITH (FORCE)')

    def as_app(self, tenant, statement):
        """One wrapper transaction: begin, set_config, statement, commit."""
        bind = '' if tenant is None else set_tenant_sql().replace(':app_tenant', "'" + tenant.replace("'", "''") + "'") + ';'
        return psql(self.db, f'SET ROLE {APP};\nBEGIN;\n{bind}\n{statement};\nCOMMIT;').splitlines()[-1]

    def count(self, tenant, table, where='true'):
        return int(self.as_app(tenant, f'SELECT count(*) FROM {table} WHERE {where}'))

    def test_the_wrong_tenant_setting_returns_zero_rows(self):
        self.assertEqual(self.count('assessment', 'saved_searches', "tenant_id = 'orgiq'"), 0)
        self.assertEqual(self.count('assessment', 'user_tenant_roles', "tenant_id = 'orgiq'"), 0)
        self.assertEqual(self.count('orgiq', 'saved_searches', "tenant_id = 'orgiq'"), 1)

    def test_an_unset_setting_returns_zero_rows_and_star_returns_all(self):
        self.assertEqual(self.count(None, 'saved_searches'), 0)
        self.assertEqual(self.count('', 'saved_searches'), 0)
        self.assertEqual(self.count('*', 'saved_searches'), 2)
        self.assertEqual(self.count('orgiq,assessment', 'saved_searches'), 2)

    def test_the_setting_is_local_to_the_transaction(self):
        out = psql(self.db, f"SET ROLE {APP};\nBEGIN;\n{set_tenant_sql().replace(':app_tenant', chr(39) + '*' + chr(39))};\nCOMMIT;\n"
                            "SELECT coalesce(current_setting('app.tenant', true), '') || '|' || count(*) FROM saved_searches;")
        self.assertEqual(out.splitlines()[-1], '|0')

    def test_a_write_into_another_tenant_is_refused(self):
        with self.assertRaisesRegex(m.MigrationError, 'row-level security'):
            self.as_app('orgiq', "INSERT INTO saved_searches (id, owner_sub, tenant_id, payload) VALUES "
                                 "('00000000-0000-0000-0000-0000000000cc', 'u-a', 'assessment', '{}')")
        # An UPDATE cannot see the other tenant's row at all.
        self.assertEqual(self.as_app('orgiq', "WITH u AS (UPDATE saved_searches SET payload = '{\"x\":1}' "
                                              "WHERE tenant_id = 'assessment' RETURNING 1) SELECT count(*) FROM u"), '0')

    def test_parents_and_tenant_owned_tables(self):
        # A pipelines run shows to the tenant it acted for, and to pipelines.
        run = "id = 'job:rls-1'"
        self.assertEqual(self.count('orgiq', 'pipeline_runs', run), 1)
        self.assertEqual(self.count('pipelines', 'pipeline_runs', run), 1)
        self.assertEqual(self.count('assessment', 'pipeline_runs', run), 0)
        # An access request is visible through its catalog item's tenant.
        req = "id = 'req-rls'"
        self.assertEqual(self.count('assessment', 'access_requests', req), 1)
        self.assertEqual(self.count('orgiq', 'access_requests', req), 0)
        # Every assessment_* table answers to the assessment tenant only.
        self.assertEqual(self.as_app('orgiq', "SELECT count(*) FROM pg_class c WHERE c.relname LIKE 'assessment\\_%' "
                                              "AND c.relkind = 'r' AND NOT c.relrowsecurity"), '0')
        psql(self.db, "INSERT INTO assessment_configuration (key) VALUES ('rls-probe') ON CONFLICT DO NOTHING")
        self.assertEqual(self.count('orgiq', 'assessment_configuration', "key = 'rls-probe'"), 0)
        self.assertEqual(self.count('assessment', 'assessment_configuration', "key = 'rls-probe'"), 1)

    def test_the_middleware_holds_dml_on_the_newer_tenant_tables(self):
        # Sweep 4 Low 7: the microVM, voice and sweep tables, after the role files.
        for table in ('microvm_sessions', 'github_user_grants', 'voice_sessions', 'voice_tool_calls', 'sweep_runs'):
            got = psql(self.db, ' '.join(f"SELECT has_table_privilege('{APP}', '{table}', '{p}');"
                                         for p in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')))
            self.assertEqual(got.split(), ['t', 't', 't', 't'], table)
        self.assertEqual(self.count('orgiq', 'microvm_sessions'), 0)  # reachable, and filtered

    def test_roles_and_the_agents_passthrough(self):
        rows = psql(self.db, "SELECT rolname || ':' || rolbypassrls FROM pg_roles WHERE rolname LIKE 'orgiq\\_%' ORDER BY 1")
        for line in rows.splitlines():
            self.assertTrue(line.endswith(':false'), line)
        # The graph reader keeps reading the KB registry with no tenant setting.
        psql(self.db, "INSERT INTO knowledge_bases (name, slug, tenant, s3_prefix, aurora_table) "
                      "VALUES ('rls-kb', 'rls-kb', 'assessment', 'kb/rls/', 'bedrock_kb_rls') ON CONFLICT DO NOTHING")
        self.assertEqual(psql(self.db, "SET ROLE orgiq_graph_reader; SELECT count(*) FROM knowledge_bases WHERE slug = 'rls-kb';")
                         .splitlines()[-1], '1')
        self.assertEqual(self.count('orgiq', 'knowledge_bases', "slug = 'rls-kb'"), 0)

    @unittest.skipUnless(os.environ.get('RLS_MEASURE') == '1', 'set RLS_MEASURE=1 to time the transaction')
    def test_measure_the_set_local_transaction(self):
        """Prints the database-side cost; the Data API adds its own round trips."""
        query = "SELECT count(*) FROM saved_searches WHERE tenant_id = 'orgiq';"
        scripts = {
            'autocommit': query,
            'begin+set_config+commit': 'BEGIN;\n' + set_tenant_sql().replace(':app_tenant', "'orgiq'") + ';\n' + query + '\nCOMMIT;',
        }
        for name, body in scripts.items():
            psql(self.db, '')  # warm
            subprocess.run(DOCKER + ['exec', '-i', CONTAINER, 'sh', '-c', f'cat > /tmp/rls-{len(name)}.sql'],
                           input=body, text=True, check=True)
            out = subprocess.run(DOCKER + ['exec', CONTAINER, 'pgbench', '-n', '-U', APP, '-t', '5000', '-c', '1',
                                           '-f', f'/tmp/rls-{len(name)}.sql', self.db], capture_output=True, text=True, check=True).stdout
            latency = re.search(r'latency average = ([\d.]+) ms', out).group(1)
            print(f'\n  {name:<26} latency average {latency} ms')


if __name__ == '__main__':
    unittest.main()
