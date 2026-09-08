"""Tenant-floor tests for assessment-drafter, using the shared tenant_guard."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))  # agents/

from _shared.tenant_guard import reject_wrong_tenant  # noqa: E402

EXPECTED_TENANT = "assessment"
AGENT_ID = "orgiq-assessment-drafter"


def test_orgiq_tenant_is_rejected():
    payload = {"auth": {"sub": "u1", "role": "member", "tenant": "orgiq"}}
    result = reject_wrong_tenant(payload, expected_tenant=EXPECTED_TENANT, agent_id=AGENT_ID)
    assert result is not None
    assert result["error"] == "forbidden"
    assert "orgiq" in result["detail"]


def test_missing_auth_block_is_rejected():
    result = reject_wrong_tenant({}, expected_tenant=EXPECTED_TENANT, agent_id=AGENT_ID)
    assert result is not None


def test_assessment_tenant_is_allowed():
    payload = {"auth": {"sub": "u1", "role": "lead-assessor", "tenant": "assessment"}}
    result = reject_wrong_tenant(payload, expected_tenant=EXPECTED_TENANT, agent_id=AGENT_ID)
    assert result is None
