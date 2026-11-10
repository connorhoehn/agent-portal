"""Signed caller identity on an agent invoke (middleware → supervisor).

The middleware puts the signed-in caller in the invoke payload's ``auth`` block
(``{sub, role, tenant, actor?}``) and the supervisor picks its guardrail and
tools from it. The block used to be trusted as sent, so anyone able to call
``InvokeAgentRuntime`` directly could claim any role. Now the middleware signs
it with the existing service envelope (``service-http-v1``, the same HMAC the
agents' callbacks use — callbacks.py) and the supervisor verifies it here:

    payload["auth"]      the identity
    payload["sessionId"] the conversation id the identity is bound to
    payload["authSig"]   v1.orgiq-middleware.<ts>.<mac> over both

The canonical body is ``{"auth": {...string fields...}, "conversationId": ...}``
with sorted keys and no spaces, built identically by
``middleware/src/lib/agent-invoke-auth.ts``. The secret is
``AGENT_INVOKE_SECRET`` (``_ID`` names it in Secrets Manager on a deployed
runtime, secret_resolver.py).

Without a secret the block is trusted only under ``INSECURE_DEV_MODE=true`` and
outside production (local runs keep working); otherwise an unverified block
counts as no block — the least-privileged caller.

Every agent that reads the caller's tenant, role or sub reads it here and only
here (the supervisor, the read agents' retrieval tenant in kb_resolver, the
assessment agents' tenant floor in tenant_guard), never from the payload's top
level or the caller's structured ``input`` (``request_fields``). The
supervisor re-signs its verified caller for the sub-agents it invokes, as
``orgiq-supervisor``.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

try:  # package import (agents._shared) or flat import (image: /app/_shared on sys.path)
    from .callbacks import sign_service_request, verify_service_request
    from .secret_resolver import SecretResolutionError, resolve_secret
except ImportError:  # pragma: no cover — flat layout
    from callbacks import sign_service_request, verify_service_request
    from secret_resolver import SecretResolutionError, resolve_secret

log = logging.getLogger(__name__)

SECRET_ENV = "AGENT_INVOKE_SECRET"
AUDIENCE = "orgiq-agent/invoke-auth"
SERVICE_ID = "orgiq-middleware"
#: The supervisor re-signs the verified caller for the sub-agents it invokes.
SUPERVISOR_SERVICE_ID = "orgiq-supervisor"
ALLOWED_SERVICES = (SERVICE_ID, SUPERVISOR_SERVICE_ID)
METHOD = "POST"
TARGET = "/invocations"
#: A streamed run can sit in the runtime's queue before the handler reads it.
TTL_SEC = 300


@dataclass(frozen=True)
class InvokeIdentity:
    auth: dict
    conversation_id: str
    #: True when the signature checked out; False for the dev-mode trust path.
    signed: bool


def canonical_body(auth: dict, conversation_id: str) -> str:
    fields = {k: v for k, v in sorted(auth.items()) if isinstance(k, str) and isinstance(v, str)}
    return json.dumps(
        {"auth": fields, "conversationId": conversation_id or ""},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )


def insecure_dev_mode(env=None) -> bool:
    """INSECURE_DEV_MODE=true and not production (service-runtime's rule, plus APP_ENV)."""
    env = os.environ if env is None else env
    flag = (env.get("INSECURE_DEV_MODE") or "").strip().lower() == "true"
    production = env.get("NODE_ENV") == "production" or env.get("APP_ENV") == "production"
    return flag and not production


def verified_identity(payload: dict) -> InvokeIdentity | None:
    """The payload's identity when it may be trusted, else ``None``."""
    if not isinstance(payload, dict):
        return None
    auth = payload.get("auth")
    if not isinstance(auth, dict):
        return None
    conversation_id = payload.get("sessionId") if isinstance(payload.get("sessionId"), str) else ""
    try:
        secret = resolve_secret(SECRET_ENV)
    except SecretResolutionError as exc:
        log.error("invoke-auth: %s", exc)
        return None
    if not secret:
        if insecure_dev_mode():
            return InvokeIdentity(auth=auth, conversation_id=conversation_id, signed=False)
        log.warning("invoke-auth: %s is unset outside dev mode; the auth block is not trusted", SECRET_ENV)
        return None
    sig = payload.get("authSig")
    ok, why = verify_service_request(
        sig if isinstance(sig, str) else "", METHOD, TARGET, canonical_body(auth, conversation_id),
        secret=secret, allowed_services=list(ALLOWED_SERVICES), audience=AUDIENCE, ttl_sec=TTL_SEC,
    )
    if not ok:
        log.warning("invoke-auth: auth block refused (%s); treating the caller as least privileged", why)
        return None
    return InvokeIdentity(auth=auth, conversation_id=conversation_id, signed=True)


def verified_auth(payload) -> dict | None:
    """The verified ``auth`` block, or ``None``. The only place an agent reads
    tenant, role or sub from: never the payload's top level, never ``input``."""
    ident = verified_identity(payload) if isinstance(payload, dict) else None
    return ident.auth if ident else None


def sign_identity(auth: dict, conversation_id: str, *, service_id: str = SUPERVISOR_SERVICE_ID) -> str | None:
    """``authSig`` for a block this agent hands down (the supervisor to a
    sub-agent), or ``None`` when no secret is configured (dev mode: the
    sub-agent then trusts the block only under its own dev flag)."""
    try:
        secret = resolve_secret(SECRET_ENV)
    except SecretResolutionError as exc:
        log.error("invoke-auth: %s", exc)
        return None
    if not secret:
        return None
    return sign_service_request(
        METHOD, TARGET, canonical_body(auth, conversation_id),
        secret=secret, service_id=service_id, audience=AUDIENCE,
    )


#: Top-level keys only the middleware's body builder (or the supervisor) sets:
#: identity and the trace join. Mirrors INVOKE_IDENTITY_KEYS in
#: middleware/src/lib/agent-invoke-auth.ts.
IDENTITY_KEYS = frozenset({
    "auth", "authSig", "tenant", "sub", "role", "actor",
    "userId", "user_id", "sessionId", "session_id", "runtimeSessionId",
    "runId", "run_id", "invocationId", "parentInvocationId", "parent_invocation_id",
    "threadId", "thread_id",
})


def request_fields(payload) -> dict:
    """The caller's structured fields (``mode``, ``document``, ...).

    The middleware nests them under ``input`` (a JSON object, or the JSON text
    of one); a payload without ``input`` (a direct or test invoke) uses its own
    top level. Identity keys are removed either way, so a structured field can
    never stand in for the verified caller.
    """
    if not isinstance(payload, dict):
        return {}
    raw = payload.get("input")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = None
        if not isinstance(raw, dict):
            return {}
    source = raw if isinstance(raw, dict) else payload
    return {k: v for k, v in source.items() if k not in IDENTITY_KEYS and k != "input"}
