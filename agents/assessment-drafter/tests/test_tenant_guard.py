"""Tenant-floor tests for assessment-drafter, using the shared tenant_guard.

    cd agents/assessment-drafter && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))  # agents/

from _shared.tenant_guard import reject_wrong_tenant  # noqa: E402

EXPECTED_TENANT = "assessment"
AGENT_ID = "orgiq-assessment-drafter"


# These cases exercise the guard's tenant logic on the dev-mode trust path (no
# secret, INSECURE_DEV_MODE=true); SignedOnly below covers a deployed runtime.
_DEV = mock.patch.dict(os.environ, {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "",
                                    "INSECURE_DEV_MODE": "true", "NODE_ENV": "", "APP_ENV": ""})


def setUpModule():
    _DEV.start()


def tearDownModule():
    _DEV.stop()


def _guard(payload):
    return reject_wrong_tenant(payload, expected_tenant=EXPECTED_TENANT, agent_id=AGENT_ID)


class TenantFloor(unittest.TestCase):
    def test_orgiq_tenant_is_rejected(self):
        result = _guard({"auth": {"sub": "u1", "role": "member", "tenant": "orgiq"}})
        self.assertIsNotNone(result)
        self.assertEqual(result["error"], "forbidden")
        self.assertIn("orgiq", result["detail"])

    def test_missing_auth_block_is_rejected(self):
        self.assertIsNotNone(_guard({}))

    def test_assessment_tenant_is_allowed(self):
        self.assertIsNone(
            _guard({"auth": {"sub": "u1", "role": "lead-assessor", "tenant": "assessment"}})
        )

    def test_malformed_payloads_are_rejected_rather_than_crashing(self):
        for payload in (None, "assessment", [], 7, {"auth": None}, {"auth": "assessment"},
                        {"auth": {}}, {"auth": {"tenant": None}}, {"tenant": "assessment"}):
            with self.subTest(payload=payload):
                result = _guard(payload)
                self.assertIsNotNone(result, msg=f"{payload!r} must not pass the tenant floor")
                self.assertEqual(result["agent"], AGENT_ID)
                self.assertEqual(result["error"], "forbidden")

    def test_tenant_match_is_exact(self):
        for tenant in ("Assessment", "assessment ", "assessments", "assess"):
            with self.subTest(tenant=tenant):
                self.assertIsNotNone(_guard({"auth": {"tenant": tenant}}))


class SignedOnly(unittest.TestCase):
    """With the invoke secret configured, only a signed block names the tenant."""

    SECRET = "invoke-secret-for-tests-0123456789"

    def setUp(self):
        env = mock.patch.dict(os.environ, {"AGENT_INVOKE_SECRET": self.SECRET, "INSECURE_DEV_MODE": ""})
        env.start()
        self.addCleanup(env.stop)

    def _signed(self, auth, conversation="conv-1"):
        from _shared import invoke_auth
        from _shared.callbacks import sign_service_request

        payload = {"auth": auth, "sessionId": conversation}
        payload["authSig"] = sign_service_request(
            invoke_auth.METHOD, invoke_auth.TARGET, invoke_auth.canonical_for(payload),
            secret=self.SECRET, service_id=invoke_auth.SERVICE_ID, audience=invoke_auth.AUDIENCE,
        )
        return payload

    def test_an_unsigned_assessment_block_is_refused(self):
        self.assertIsNotNone(_guard({"auth": {"sub": "u1", "tenant": "assessment"}}))

    def test_a_signed_assessment_block_passes(self):
        self.assertIsNone(_guard(self._signed({"sub": "u1", "tenant": "assessment"})))

    def test_a_top_level_or_input_tenant_never_counts(self):
        payload = self._signed({"sub": "u1", "tenant": "orgiq"})
        payload.update({"tenant": "assessment", "input": {"tenant": "assessment", "auth": {"tenant": "assessment"}}})
        self.assertIsNotNone(_guard(payload))


if __name__ == "__main__":
    unittest.main()
