"""Tenant-floor tests for assessment-scorer, using the shared tenant_guard.

    cd agents/assessment-scorer && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))  # agents/

from _shared.tenant_guard import reject_wrong_tenant  # noqa: E402

EXPECTED_TENANT = "assessment"
AGENT_ID = "orgiq-assessment-scorer"


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
        self.assertIsNone(_guard({"auth": {"sub": "u1", "role": "assessor", "tenant": "assessment"}}))

    def test_every_assessment_role_is_allowed(self):
        """The floor is tenancy, not role — role gating is Cedar's job."""
        for role in ("assessor", "lead-assessor", "program-lead", "admin"):
            with self.subTest(role=role):
                self.assertIsNone(_guard({"auth": {"sub": "u1", "role": role, "tenant": "assessment"}}))

    def test_malformed_payloads_are_rejected_rather_than_crashing(self):
        """A direct invoke that bypassed the middleware sends anything at all."""
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
