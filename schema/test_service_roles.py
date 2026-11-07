"""Offline checks for service_roles.sql and its applier (work item 19).

What PostgreSQL actually granted can only be asked of a live cluster;
apply_all_seed.verify_service_roles does that on every apply. These tests pin
what the file *says* and how the applier wires it.
"""
import contextlib
import io
import re
import unittest
from unittest.mock import Mock, patch

import apply_all_seed as seed
from load_schema import split_sql
from schema_manifest import seed_run_files

SQL = (seed.REPO_ROOT / 'schema/service_roles.sql').read_text()
CODE = '\n'.join(line for line in SQL.splitlines() if not line.lstrip().startswith('--'))
ROLES = ('orgiq_app_middleware', 'orgiq_graph_writer', 'orgiq_kb_service')


class ServiceRolesSqlTests(unittest.TestCase):
    def test_no_password_and_no_default_privileges(self):
        self.assertNotRegex(CODE, re.compile(r'\bPASSWORD\b', re.I))
        self.assertNotRegex(CODE, re.compile(r'ALTER\s+DEFAULT\s+PRIVILEGES', re.I))

    def test_escalation_attributes_are_negated_never_granted(self):
        for attr in ('SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS'):
            self.assertNotRegex(CODE, re.compile(rf'(?<!NO){attr}\b'), attr)

    def test_no_grant_all_truncate_references_or_trigger(self):
        for grant in re.findall(r"GRANT[^;']*", CODE, re.I):
            privileges = re.split(r'\bON\b', grant, maxsplit=1, flags=re.I)[0]
            self.assertNotRegex(privileges, re.compile(r'\b(ALL|TRUNCATE|REFERENCES|TRIGGER)\b', re.I), grant)

    def test_the_writer_never_deletes(self):
        writer = CODE[CODE.index('$WRITER$'):CODE.rindex('$WRITER$')]
        self.assertNotIn('DELETE', writer)
        self.assertIn('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO orgiq_graph_writer', writer)

    def test_the_writer_list_stays_inside_the_org_graph(self):
        writable = re.search(r'WRITABLE CONSTANT text\[\] := ARRAY\[(.*?)\];', CODE, re.S).group(1)
        names = set(re.findall(r"'([a-z_]+)'", writable))
        self.assertTrue(names)
        for forbidden in ('app_users', 'user_tenant_roles', 'tenants', 'knowledge_bases', 'bedrock_kb'):
            self.assertNotIn(forbidden, names)

    def test_the_knowledge_base_role_touches_bedrock_kb_only(self):
        kb = CODE[CODE.index('$KB$'):CODE.rindex('$KB$')]
        self.assertEqual(set(re.findall(r'ON TABLE (\S+) TO orgiq_kb_service', kb)), {'public.bedrock_kb'})

    def test_the_middleware_gets_no_ddl_beyond_create_on_public(self):
        ddl = re.findall(r'GRANT\s+CREATE\s+ON\s+SCHEMA\s+(\w+)\s+TO\s+(\w+)', CODE, re.I)
        self.assertEqual(ddl, [('public', 'orgiq_app_middleware')])


class ServiceRolesApplierTests(unittest.TestCase):
    def test_role_files_run_just_before_the_end_of_the_seed(self):
        files = seed_run_files()
        self.assertEqual(files[-2:], ['schema/service_roles.sql', 'schema/graph_readonly_role.sql'])

    def test_every_role_has_a_secret(self):
        self.assertEqual(tuple(sorted(r for r, _, _ in seed.SERVICE_ROLES)), ROLES)
        for role, secret, _ in seed.SERVICE_ROLES:
            self.assertTrue(secret.startswith('orgiq-aurora-') and secret.endswith('-credentials'), secret)

    def test_roles_only_applies_both_role_files_then_sets_and_verifies_every_password(self):
        rds = Mock()
        with patch.object(seed, 'get_cluster_info', return_value=('cluster', 'admin', 'db')), \
                patch.object(seed.boto3, 'client', return_value=rds), \
                patch.object(seed, 'set_readonly_password', return_value=0), \
                patch.object(seed, 'verify_readonly_role', return_value=0), \
                patch.object(seed, 'set_service_role_passwords', return_value=0) as passwords, \
                patch.object(seed, 'verify_service_roles', return_value=0) as verify, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.main(['--roles-only']), 0)
        expected = [s for f in seed.ROLE_FILES for s in split_sql((seed.REPO_ROOT / f).read_text())]
        self.assertEqual([c.kwargs['sql'] for c in rds.execute_statement.call_args_list], expected)
        passwords.assert_called_once()
        verify.assert_called_once()

    def test_a_missing_service_secret_is_a_failure_and_alters_nothing(self):
        rds = Mock()
        with patch.object(seed, '_load_password', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.set_service_role_passwords(rds, 'c', 's', 'db', 'r'), len(seed.SERVICE_ROLES))
        rds.execute_statement.assert_not_called()

    def test_a_wrong_engine_answer_fails_verification(self):
        rds = Mock()
        # Every probe answers True: the "must not" ones are then wrong.
        rds.execute_statement.return_value = {'records': [[{'booleanValue': True}] * len(seed.SERVICE_ROLE_PROBES)]}
        with contextlib.redirect_stdout(io.StringIO()):
            failures = seed.verify_service_roles(rds, 'c', 's', 'db')
        self.assertEqual(failures, sum(1 for *_, want in seed.SERVICE_ROLE_PROBES if not want))


if __name__ == '__main__':
    unittest.main()
