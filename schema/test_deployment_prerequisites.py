"""Offline checks for upgrade wiring; no AWS clients make network calls."""
import contextlib
import io
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

import apply_all_seed as seed
from load_schema import split_sql


class DeploymentPrerequisiteTests(unittest.TestCase):
    def test_reader_only_does_not_replay_seed_data(self):
        rds = Mock()
        with patch.object(seed, 'get_cluster_info', return_value=('cluster', 'admin', 'db')), \
                patch.object(seed.boto3, 'client', return_value=rds), \
                patch.object(seed, 'set_readonly_password', return_value=0) as password, \
                patch.object(seed, 'verify_readonly_role', return_value=0) as verify, \
                contextlib.redirect_stdout(io.StringIO()):
            result = seed.main(['--readonly-role-only'])
        expected = split_sql((seed.REPO_ROOT / 'schema/graph_readonly_role.sql').read_text())
        self.assertEqual(result, 0)
        self.assertEqual([c.kwargs['sql'] for c in rds.execute_statement.call_args_list], expected)
        password.assert_called_once()
        verify.assert_called_once()

    def test_unreadable_secret_is_reported_as_failure(self):
        sm = Mock()
        sm.get_secret_value.side_effect = RuntimeError('ResourceNotFoundException')
        rds = Mock()
        with patch.object(seed.boto3, 'client', return_value=sm), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.set_readonly_password(rds, 'cluster', 'admin', 'db', 'region'), 1)
        rds.execute_statement.assert_not_called()

    def test_malformed_secret_shapes_fail_cleanly(self):
        for raw in ['null', '[]', 'not-json', '{"password": 123}', '{"password": ""}']:
            with self.subTest(raw=raw):
                sm = Mock()
                sm.get_secret_value.return_value = {'SecretString': raw}
                rds = Mock()
                with patch.object(seed.boto3, 'client', return_value=sm), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(seed.set_readonly_password(rds, 'cluster', 'admin', 'db', 'region'), 1)
                rds.execute_statement.assert_not_called()

    def test_reader_option_resolves_sql_outside_repository_cwd(self):
        original = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                self.test_reader_only_does_not_replay_seed_data()
        finally:
            os.chdir(original)

    def test_missing_reader_secret_fails_without_altering_password(self):
        rds = Mock()
        with patch.object(seed, '_load_readonly_password', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.set_readonly_password(rds, 'cluster', 'admin', 'db', 'region'), 1)
        rds.execute_statement.assert_not_called()

    def test_reader_only_propagates_credential_failure_to_exit_status(self):
        with patch.object(seed, 'get_cluster_info', return_value=('cluster', 'admin', 'db')), \
                patch.object(seed.boto3, 'client', return_value=Mock()), \
                patch.object(seed, 'set_readonly_password', return_value=1), \
                patch.object(seed, 'verify_readonly_role', return_value=0), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.main(['--readonly-role-only']), 1)

    def test_comment_fk_replacement_stays_one_loader_statement(self):
        statements = split_sql((seed.REPO_ROOT / 'schema/assessment_schema.sql').read_text())
        migration = [s for s in statements if 'DROP CONSTRAINT IF EXISTS assessment_knowledge_comments_doc_id_fkey' in s]
        self.assertEqual(len(migration), 1)
        self.assertTrue(migration[0].startswith('DO $COMMENT_TARGET$'))
        self.assertIn('ADD CONSTRAINT assessment_knowledge_comments_doc_id_fkey', migration[0])
        self.assertIn('REFERENCES assessment_knowledge_nodes(id)', migration[0])
        self.assertNotIn('DELETE FROM', migration[0])
        self.assertIn('dispatch_payload JSONB', '\n'.join(statements))
        self.assertIn('dispatch_claimed_at TIMESTAMPTZ', '\n'.join(statements))


if __name__ == '__main__':
    unittest.main()
