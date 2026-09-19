"""Schema load must never declare success after skipping required migrations."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('schema_loader_under_test', ROOT / 'schema/load_schema.py')
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


class SchemaLoaderTests(unittest.TestCase):
    def run_loader(self):
        with patch.object(loader, 'get_cluster_info', return_value=('cluster', 'secret', 'db')), \
                patch.object(loader.boto3, 'client', return_value=Mock()), \
                patch.object(loader, 'execute_with_retry') as execute, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                loader.main()
            except SystemExit as error:
                return error.code, execute, output.getvalue()
        return 0, execute, output.getvalue()

    def test_required_files_are_located_relative_to_loader_not_cwd(self):
        self.assertEqual(loader.SCHEMA_DIR, ROOT / 'schema')
        code, execute, output = self.run_loader()
        self.assertEqual(code, 0, output)
        self.assertGreater(execute.call_count, 100)
        self.assertIn('Schema loaded', output)

    def test_missing_migrations_fail_the_command(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(loader, 'SCHEMA_DIR', Path(directory)):
            code, execute, output = self.run_loader()
        self.assertEqual(code, 1)
        self.assertEqual(execute.call_count, 1)  # warm-up only
        self.assertIn('Required schema file is missing', output)
        self.assertNotIn('✓ Schema loaded', output)
