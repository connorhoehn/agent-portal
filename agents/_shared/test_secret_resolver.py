"""Unit tests for secret_resolver — botocore Stubber, no network, no AWS.

Run:  cd agents/_shared && python -m unittest test_secret_resolver
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import secret_resolver as sr  # noqa: E402

try:
    import boto3
    from botocore.stub import Stubber
except ImportError:  # pragma: no cover
    boto3 = None


@unittest.skipIf(boto3 is None, "boto3/botocore not installed")
class ResolveSecretTests(unittest.TestCase):
    def setUp(self):
        sr.reset_cache()
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ("FOO", "FOO_ID", sr.PLAINTEXT_FLAG):
            os.environ.pop(k, None)
        self.client = boto3.client(
            "secretsmanager", region_name="us-east-1",
            aws_access_key_id="x", aws_secret_access_key="y",
        )
        self.stub = Stubber(self.client)
        self.stub.activate()
        p = mock.patch("boto3.client", return_value=self.client)
        self.boto = p.start()
        self.addCleanup(p.stop)

    def _ok(self, name, value):
        self.stub.add_response("get_secret_value", {"SecretString": value, "Name": name},
                               {"SecretId": name})

    def test_unset_returns_empty(self):
        self.assertEqual(sr.resolve_secret("FOO"), "")

    def test_plain_variable_without_id_is_kept_for_local_dev(self):
        os.environ["FOO"] = " dev \n"
        self.assertEqual(sr.resolve_secret("FOO"), "dev")
        self.boto.assert_not_called()

    def test_fetches_by_name_strips_and_caches(self):
        os.environ["FOO_ID"] = "orgiq-foo-secret"
        self._ok("orgiq-foo-secret", "s3cret\n")  # only one response queued
        self.assertEqual(sr.resolve_secret("FOO"), "s3cret")
        self.assertEqual(sr.resolve_secret("FOO"), "s3cret")
        self.stub.assert_no_pending_responses()
        self.assertEqual(self.boto.call_count, 1)

    def test_id_wins_over_plaintext_value(self):
        os.environ.update({"FOO_ID": "n", "FOO": "old", sr.PLAINTEXT_FLAG: "1"})
        self._ok("n", "new")
        self.assertEqual(sr.resolve_secret("FOO"), "new")

    def test_failure_raises_clear_error(self):
        os.environ["FOO_ID"] = "orgiq-foo-secret"
        self.stub.add_client_error("get_secret_value", "AccessDeniedException")
        with self.assertRaises(sr.SecretResolutionError) as cm:
            sr.resolve_secret("FOO")
        msg = str(cm.exception)
        self.assertIn("FOO_ID", msg)
        self.assertIn("orgiq-foo-secret", msg)
        self.assertIn(sr.PLAINTEXT_FLAG, msg)

    def test_failure_is_not_cached(self):
        os.environ["FOO_ID"] = "n"
        self.stub.add_client_error("get_secret_value", "ThrottlingException")
        with self.assertRaises(sr.SecretResolutionError):
            sr.resolve_secret("FOO")
        self._ok("n", "v")
        self.assertEqual(sr.resolve_secret("FOO"), "v")

    def test_plaintext_flag_falls_back_when_lookup_fails(self):
        os.environ.update({"FOO_ID": "n", "FOO": "plain", sr.PLAINTEXT_FLAG: "1"})
        self.stub.add_client_error("get_secret_value", "ResourceNotFoundException")
        self.assertEqual(sr.resolve_secret("FOO"), "plain")

    def test_flag_without_plain_value_still_raises(self):
        os.environ.update({"FOO_ID": "n", sr.PLAINTEXT_FLAG: "1"})
        self.stub.add_client_error("get_secret_value", "ResourceNotFoundException")
        with self.assertRaises(sr.SecretResolutionError):
            sr.resolve_secret("FOO")

    def test_plain_value_without_flag_is_not_a_fallback(self):
        os.environ.update({"FOO_ID": "n", "FOO": "plain"})
        self.stub.add_client_error("get_secret_value", "ResourceNotFoundException")
        with self.assertRaises(sr.SecretResolutionError):
            sr.resolve_secret("FOO")

    def test_binary_only_secret_is_an_error(self):
        os.environ["FOO_ID"] = "n"
        self.stub.add_response("get_secret_value", {"SecretBinary": b"x", "Name": "n"}, {"SecretId": "n"})
        with self.assertRaises(sr.SecretResolutionError):
            sr.resolve_secret("FOO")


@unittest.skipIf(boto3 is None, "boto3/botocore not installed")
class CallbacksIntegrationTests(unittest.TestCase):
    def setUp(self):
        sr.reset_cache()

    def test_secret_for_uses_named_secret_and_fails_closed(self):
        import callbacks as cb
        cb.reset_announcements()
        env = {"APPROVALS_REQUEST_SECRET_ID": "orgiq-approvals-request-secret"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sr, "_fetch", return_value="abc") as fetch:
            self.assertEqual(cb.secret_for(cb.APPROVALS_REQUEST), "abc")
            fetch.assert_called_once_with("orgiq-approvals-request-secret")
            self.assertEqual(cb.auth_headers(cb.APPROVALS_REQUEST), {"x-approvals-auth": "abc"})
        sr.reset_cache()
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sr, "_fetch", side_effect=RuntimeError("denied")):
            with self.assertLogs("callbacks", level="ERROR"):
                self.assertEqual(cb.secret_for(cb.APPROVALS_REQUEST), "")
            self.assertEqual(cb.request_headers(cb.APPROVALS_REQUEST, "POST", "http://m/x", b"{}"), {})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
