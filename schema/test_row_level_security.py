"""Offline checks for row_level_security.sql (work item 22).

What PostgreSQL enforces is proven by test_row_level_security_postgres.py
(opt-in, a disposable container) and by the file's own $ASSERT$ block on every
apply. These tests pin what the file says and that it keeps up with the schema.
"""
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
