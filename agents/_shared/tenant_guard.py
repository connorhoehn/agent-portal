"""Tenant floor for single-tenant agents.

Most agents in this fleet are gated by tenant at the middleware route layer
only (`middleware/src/routes/agents.ts` `agentTenant()`), never in the agent
itself — the six OrgIQ agents trust the middleware to have already rejected
a non-orgiq session before the invocation ever reaches them.

The assessment agents (`assessment-scorer`, `assessment-drafter`) add a
second, in-agent floor: they reject any invocation whose `auth.tenant` is not
`"assessment"`, including a payload with no `auth` block at all (a direct
invoke that bypassed the middleware gate). That is deliberately stricter than
the supervisor's `_resolve_identity`, which defaults an unrecognized/missing
tenant to `orgiq` rather than refusing — these two agents have no legitimate
cross-tenant caller, so there is nothing to default to.

Dependency-free (stdlib only) so it can be unit tested without
strands/bedrock_agentcore/boto3 installed.
"""

from __future__ import annotations

from typing import Any


def reject_wrong_tenant(payload: Any, *, expected_tenant: str, agent_id: str) -> dict | None:
    """None if ``payload.auth.tenant == expected_tenant``; else a rejection envelope.

    Args:
        payload: The raw invocation payload (or anything — non-dicts are
            treated as carrying no auth block, i.e. rejected).
        expected_tenant: The only tenant this agent serves, e.g. "assessment".
        agent_id: This agent's id, for the error detail (e.g. "orgiq-assessment-scorer").
    """
    auth = payload.get("auth") if isinstance(payload, dict) else None
    tenant = auth.get("tenant") if isinstance(auth, dict) else None
    if tenant != expected_tenant:
        return {
            "agent": agent_id,
            "error": "forbidden",
            "detail": (
                f"{agent_id} only serves the {expected_tenant!r} tenant (got {tenant!r})"
            ),
        }
    return None


def reject_wrong_mode_tenant(
    payload: Any, *, mode_tenants: dict[str, str], default_tenant: str, agent_id: str
) -> dict | None:
    """Per-mode tenant floor: a mode runs only for the tenant that owns it.

    ``mode_tenants`` maps a mode to its one allowed tenant; a mode absent from
    it (or a payload with no usable mode) falls to ``default_tenant``. Same
    stance as :func:`reject_wrong_tenant` — a missing ``auth`` block is
    refused, never defaulted.
    """
    mode = payload.get("mode") if isinstance(payload, dict) else None
    expected = mode_tenants.get(mode, default_tenant) if isinstance(mode, str) else default_tenant
    rejection = reject_wrong_tenant(payload, expected_tenant=expected, agent_id=agent_id)
    if rejection is not None and isinstance(mode, str):
        rejection["detail"] += f" for mode {mode!r}"
    return rejection
