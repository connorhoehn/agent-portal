"""Exercise the MCP Lambda handler without network calls or AWS credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agents' / '_shared'))


class GatewaySqlTests(unittest.TestCase):
    def setUp(self):
        self.rds = Mock()
        self.rds.execute_statement.return_value = {'records': [], 'columnMetadata': []}
        spec = importlib.util.spec_from_file_location(
            'gateway_graph_under_test', ROOT / 'infra/lambda/gateway-tools/graph_traversal.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict('os.environ', {'AURORA_CLUSTER_ARN': 'cluster', 'AURORA_SECRET_ARN': 'reader'}), \
                patch('boto3.client', return_value=self.rds):
            spec.loader.exec_module(self.module)

    def test_mutation_attempts_never_reach_data_api(self):
        for sql in (
            'WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone',
            'EXPLAIN ANALYZE DELETE FROM people',
            'SELECT * INTO copied FROM people',
            'SELECT "pg_sleep"(300)',
            'SELECT 1; DELETE FROM people',
            {'invalid': 'sql'},
        ):
            with self.subTest(sql=sql):
                self.assertEqual(self.module.handler({'sql': sql}, None)['statusCode'], 403)
        self.rds.execute_statement.assert_not_called()

    def test_select_explain_and_boolean_parameter(self):
        result = self.module.handler({'sql': 'SELECT name FROM people WHERE enabled = :enabled',
                                      'parameters': {'enabled': True}, 'explain': True}, None)
        self.assertEqual(result['statusCode'], 200)
        args = self.rds.execute_statement.call_args.kwargs
        self.assertEqual(args['secretArn'], 'reader')
        self.assertTrue(args['sql'].startswith('EXPLAIN SELECT'))
        self.assertEqual(args['parameters'], [{'name': 'enabled', 'value': {'booleanValue': True}}])
        self.assertEqual(json.loads(result['body'])['results'], [])


class GatewayPageRankTests(unittest.TestCase):
    def test_hidden_writeback_parameter_is_rejected_before_database_access(self):
        rds = Mock()
        spec = importlib.util.spec_from_file_location(
            'gateway_pagerank_under_test', ROOT / 'infra/lambda/gateway-tools/compute_pagerank.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict('os.environ', {'AURORA_CLUSTER_ARN': 'cluster', 'AURORA_SECRET_ARN': 'reader'}), \
                patch('boto3.client', return_value=rds):
            spec.loader.exec_module(module)
        result = module.handler({'writeBack': True}, None)
        self.assertEqual(result['statusCode'], 403)
        rds.execute_statement.assert_not_called()
        rds.execute_statement.return_value = {'records': [], 'columnMetadata': []}
        self.assertEqual(module.handler({}, None)['statusCode'], 200)
        self.assertTrue(rds.execute_statement.call_args.kwargs['sql'].startswith('SELECT'))
