"""Who owns an agent's trace, as the X-Ray annotations the middleware filters on.

The middleware lists X-Ray traces for a non-admin caller with a filter
expression over two annotations (``annotation.user_id = "…" AND
annotation.tenant = "…"``, middleware/src/lib/trace-owner.ts). A trace that
carries neither is the cross-tenant admin's alone, so every agent span this
fleet opens is tagged with its verified caller here.

The owner comes from the signed auth block only (invoke_auth.verified_identity),
never from the payload's top level or its ``input``. An unsigned run that dev
mode trusts (no AGENT_INVOKE_SECRET, INSECURE_DEV_MODE=true, not production)
is tagged with the demo identity and the home tenant, the identity the
middleware's cookie-less dev session uses. Anything else (an unverified block
outside dev mode, a block without a sub or tenant) tags nothing.

OpenTelemetry span attributes reach X-Ray as metadata unless their keys are
listed in the ``aws.xray.annotations`` attribute, which turns them into
indexed annotations a filter expression can match.

The annotation names are mirrored by TRACE_OWNER_ANNOTATIONS in
middleware/src/lib/trace-owner.ts; middleware/src/lib/__tests__/trace-owner.test.ts
and test_trace_owner.py keep the two equal.
"""

from __future__ import annotations

from typing import Any, Optional

try:  # package import (agents._shared) or flat import (image: /app/_shared on sys.path)
    from .invoke_auth import insecure_dev_mode, verified_identity
except ImportError:  # pragma: no cover — flat layout
    from invoke_auth import insecure_dev_mode, verified_identity

#: The annotation naming the trace's user (the verified ``auth.sub``).
USER_ANNOTATION = "user_id"
#: The annotation naming the trace's tenant (the verified ``auth.tenant``).
TENANT_ANNOTATION = "tenant"
#: The span attribute listing which attributes X-Ray indexes as annotations.
XRAY_ANNOTATIONS_ATTRIBUTE = "aws.xray.annotations"
#: The cookie-less demo identity's subject (middleware/src/lib/demo-sub.ts).
DEMO_SUB = "demo-user"
#: The home tenant (kb_resolver.HOME_TENANT, tenants/kb-prefixes.json).
HOME_TENANT = "orgiq"


def trace_owner(payload: Any) -> Optional[tuple[str, str]]:
    """``(user_id, tenant)`` for the payload's verified caller, or ``None``.

    Reads the identity through ``verified_identity``, which remembers the
    answer for the same payload object, so the agent's own later read of the
    block is not refused as a replay."""
    ident = verified_identity(payload) if isinstance(payload, dict) else None
    if ident is None:
        # Dev mode with no block at all is still a local, unsigned run.
        return (DEMO_SUB, HOME_TENANT) if insecure_dev_mode() else None
    if not ident.signed:
        return (DEMO_SUB, HOME_TENANT)
    sub = ident.auth.get("sub")
    tenant = ident.auth.get("tenant")
    if isinstance(sub, str) and sub and isinstance(tenant, str) and tenant:
        return (sub, tenant)
    return None


def owner_attributes(owner: Optional[tuple[str, str]]) -> dict[str, object]:
    """The span attributes that tag a span with ``owner`` (empty for none)."""
    if not owner:
        return {}
    user_id, tenant = owner
    return {
        USER_ANNOTATION: user_id,
        TENANT_ANNOTATION: tenant,
        XRAY_ANNOTATIONS_ATTRIBUTE: [USER_ANNOTATION, TENANT_ANNOTATION],
    }


def tag_span(span: Any, owner: Optional[tuple[str, str]]) -> None:
    """Set the owner annotations on ``span``. Never raises: a span that
    cannot take attributes (None, a non-recording span) is left alone."""
    if span is None or not owner:
        return
    try:
        if hasattr(span, "is_recording") and not span.is_recording():
            return
        for key, value in owner_attributes(owner).items():
            span.set_attribute(key, value)
    except Exception:  # noqa: BLE001 — instrumentation must never fail the invocation
        pass
