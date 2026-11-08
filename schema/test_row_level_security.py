"""Offline checks for row_level_security.sql (work item 22).

What PostgreSQL enforces is proven by test_row_level_security_postgres.py
(opt-in, a disposable container) and by the file's own $ASSERT$ block on every
apply. These tests pin what the file says and that it keeps up with the schema.
"""
import json
import re
import unittest
from pathlib import Path

from schema_manifest import seed_run_files

SCHEMA = Path(__file__).resolve().parent
SQL = (SCHEMA / 'row_level_security.sql').read_text()
CODE = '\n'.join(line for line in SQL.splitlines() if not line.lstrip().startswith('--'))
LISTED = dict(re.findall(r"^\s+\('([a-z_]+)',\s+'(.*)'\),?$", CODE, re.M))
TENANT_COLUMNS = ('tenant', 'tenant_id', 'context_tenant', 'left_tenant', 'right_tenant')
# Tables with a tenant column the file leaves alone on purpose (see its header).
EXCLUDED = {'observability.authz_events', 'observability.invocation_traces'}


def schema_tables():
    """table name -> its columns, across every schema file (CREATE TABLE and ADD COLUMN)."""
    tables = {}
    for path in sorted(SCHEMA.glob('*.sql')):
        text = path.read_text()
        for name, body in re.findall(r'CREATE TABLE(?: IF NOT EXISTS)?\s+([\w.]+)\s*\((.*?)\n\);', text, re.S | re.I):
            cols = {line.split()[0].lower() for line in body.splitlines() if line.strip() and not line.strip().startswith('--')}
            tables.setdefault(name.lower(), set()).update(cols)
        for name, col in re.findall(r'ALTER TABLE\s+(?:IF EXISTS\s+)?([\w.]+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+(\w+)', text, re.I):
            tables.setdefault(name.lower(), set()).add(col.lower())
    return tables


def covered(table):
    return table in LISTED or (table.startswith('assessment_') and table != 'assessment_document_mappings')


class RowLevelSecurityCoverageTests(unittest.TestCase):
    def test_every_table_with_a_tenant_column_is_covered_or_excluded_on_purpose(self):
        for table, cols in schema_tables().items():
            if cols & set(TENANT_COLUMNS) and table not in EXCLUDED:
                self.assertTrue(covered(table), f'{table} carries a tenant column but has no policy in row_level_security.sql')

    def test_every_tenant_owned_table_is_covered(self):
        for table in schema_tables():
            if table.startswith(('assessment_', 'access_', 'pipeline_')) or table in ('social_channels', 'social_bindings'):
                self.assertTrue(covered(table), table)

    def test_listed_tables_exist_in_the_schema(self):
        known = schema_tables()
        for table in LISTED:
            self.assertIn(table, known)

    def test_each_tenant_column_predicate_names_a_real_column(self):
        known = schema_tables()
        for table, predicate in LISTED.items():
            for col in re.findall(r'app_tenant_visible\(([a-z_.]+)\)', predicate):
                col = col.split('.')[-1]
                self.assertIn(col, known[table], f'{table}: {predicate}')


class MiddlewareReachTests(unittest.TestCase):
    """Sweep 4 Low 7: an RLS-listed table the middleware holds no grant on fails every write."""
    # The microVM runner's, the voice navigator's and the sweep ledger's tables.
    NEWER = ('microvm_sessions', 'github_user_grants', 'voice_sessions', 'voice_tool_calls', 'sweep_runs')

    def test_the_newer_tenant_tables_are_listed_and_tenant_scoped(self):
        for table in self.NEWER:
            self.assertEqual(LISTED.get(table), 'public.app_tenant_visible(tenant)', table)

    def test_they_load_before_the_role_files_so_the_schema_wide_grant_reaches_them(self):
        # load_schema.py applies every repeatable entry; the role files are seed
        # entries applied after them (seed run, or --roles-only after a migration).
        manifest = json.loads((SCHEMA / 'manifest.json').read_text())
        kinds = {e['file']: e['kind'] for e in manifest['entries'] if 'file' in e}
        files = {t: f for f in kinds for t in schema_tables_in(SCHEMA / f)}
        for table in self.NEWER:
            self.assertEqual(kinds[files[table]], 'repeatable', table)
        self.assertEqual(kinds['service_roles.sql'], 'seed')

    def test_service_roles_grants_dml_on_every_public_table(self):
        roles = (SCHEMA / 'service_roles.sql').read_text()
        block = roles[roles.index('$MIDDLEWARE$'):roles.rindex('$MIDDLEWARE$')]
        self.assertIn("c.relkind IN ('r', 'p', 'v', 'm')", block)
        self.assertIn('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO orgiq_app_middleware', block)
        # Only bedrock_kb is carved out.
        self.assertEqual(re.findall(r"c\.relname = '(\w+)'", block), ['bedrock_kb'])

    def test_the_apply_fails_when_an_rls_table_lacks_the_middlewares_dml(self):
        assert_block = CODE[CODE.index('DO $ASSERT$'):]
        self.assertIn('c.relrowsecurity', assert_block)
        for priv in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
            self.assertIn(f"has_table_privilege('orgiq_app_middleware', c.oid, '{priv}')", assert_block)
        self.assertIn('lacks its DML', assert_block)


def schema_tables_in(path):
    return {n.lower() for n in re.findall(r'CREATE TABLE(?: IF NOT EXISTS)?\s+([\w.]+)\s*\(', path.read_text(), re.I)}


class RowLevelSecurityShapeTests(unittest.TestCase):
    def test_unset_means_nothing_and_star_means_everything(self):
        fn = CODE[CODE.index('CREATE OR REPLACE FUNCTION public.app_tenant_visible'):CODE.index('$FN$;')]
        self.assertRegex(fn, r"WHEN '' THEN false")
        self.assertRegex(fn, r"WHEN '\*' THEN true")
        self.assertIn("current_setting('app.tenant', true)", fn)
        self.assertNotIn('SECURITY DEFINER', fn)

    def test_policies_bind_the_middleware_for_reads_and_writes(self):
        self.assertIn('FOR ALL TO orgiq_app_middleware USING (%s) WITH CHECK (%s)', CODE)
        self.assertIn('ENABLE ROW LEVEL SECURITY', CODE)

    def test_the_owner_keeps_bypassing_and_no_role_gains_bypassrls(self):
        self.assertNotRegex(CODE, re.compile(r'FORCE\s+ROW\s+LEVEL\s+SECURITY', re.I))
        self.assertNotRegex(CODE, re.compile(r'(?<![A-Za-z])BYPASSRLS\b'))
        self.assertNotRegex(CODE, re.compile(r'ALTER\s+ROLE', re.I))

    def test_the_agents_passthrough_is_read_only_and_only_on_the_kb_registry(self):
        self.assertEqual(re.findall(r'CREATE POLICY agents_read ON (\S+) AS PERMISSIVE FOR (\w+)', CODE),
                         [('public.knowledge_bases', 'SELECT')])

    def test_it_runs_last_in_the_seed(self):
        self.assertEqual(seed_run_files()[-1], 'schema/row_level_security.sql')

    def test_the_documented_statement_is_the_middleware_one(self):
        ts = (SCHEMA.parent / 'middleware/src/providers/db-tenant.ts').read_text()
        statement = re.search(r'SET_TENANT_SQL = "([^"]+)"', ts).group(1)
        self.assertIn(statement, SQL)
        self.assertIn(', true)', statement)  # LOCAL: never outlives the transaction


if __name__ == '__main__':
    unittest.main()
