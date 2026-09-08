"""Tenant-floor tests for assessment-drafter, using the shared tenant_guard.

    cd agents/assessment-drafter && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))  # agents/

from _shared.tenant_guard import reject_wrong_tenant  # noqa: E402

EXPECTED_TENANT = "assessment"
AGENT_ID = "orgiq-assessment-drafter"


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


if __name__ == "__main__":
    unittest.main()
