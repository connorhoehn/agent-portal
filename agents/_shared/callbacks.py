"""Service auth for the middleware's three sessionless agent callbacks.

Why this exists
---------------
Three middleware routes are *machine* callbacks: a deployed runtime POSTs to
them with no session cookie, so they cannot take the Cedar/session gates the
rest of their routers take. Each instead carries an **optional** service-auth
guard — open when its env var is unset, a constant-time header compare when it
is set (`middleware/src/routes/{approvals,harness,assessment}.ts`):

    route                                          env var                        header
    POST /api/observability/approvals/request      APPROVALS_REQUEST_SECRET       x-approvals-auth
    POST /api/observability/harness/trace          HARNESS_TRACE_SECRET           x-harness-auth
    POST /api/assessment/runs/:runId/complete      ASSESSMENT_RUN_COMPLETE_SECRET x-assessment-run-auth

The agent half is this module. Runtimes and the middleware deploy separately
and in either order, so the contract mirrors the guard's own:

1. **Env var unset → send no header.** Byte-for-byte today's behaviour, so a
   fleet that ships before the middleware learns the secret is unaffected, and
   so is local dev / `agentcore dev` / docker-compose where nothing is set.
2. **Env var set → send the header on every call.** A runtime redeployed with
   the secret works against both an open middleware (the header is ignored)
   and a locked one.
3. **Never retry without the header.** A 401/403 is a real deployment-order
   mismatch; silently downgrading would only paper over it, and against a
   locked middleware it cannot work anyway.
4. **Never crash the agent.** Same rule as every other observability path here.

Env contract
------------
``APPROVALS_REQUEST_SECRET``        unlock the approval-request callback
``HARNESS_TRACE_SECRET``            unlock the trace callback
``ASSESSMENT_RUN_COMPLETE_SECRET``  unlock the assessment run-complete callback
``<VAR>_ID``                        Secrets Manager secret NAME for each of the above;
                                    resolved once per process (``secret_resolver.py``),
                                    ``PLAINTEXT_CALLBACK_SECRETS=1`` falls back to the
                                    plain variable. A failed lookup logs an error and
                                    sends nothing (fails closed)
``MIDDLEWARE_URL``                  base URL (default the compose service name)

``SERVICE_AUTH_LEGACY_HEADERS``     transition flag (lane C4): unset sends the signed
                                    envelope only; ``accept``/``allow`` also sends
                                    the static header, for a middleware that still
                                    needs it

Signed envelopes (lane C4)
--------------------------
With a secret set, every callback also carries service-runtime's signed
request envelope (``X-Service-Auth``, ``service-http-v1``), keyed by the same
secret, plus a fresh ``x-service-nonce``. The MAC covers the method, the exact
origin-form target (path + query), the exact UTF-8 body bytes sent, and the
audience ``<callback audience>#<nonce>`` — so the middleware's
``verifyServiceRequest`` refuses a tampered body/method/target/audience, a
stale timestamp, or a replayed nonce. ``sign_service_request`` below is a
byte-for-byte port of service-runtime 0.4.1's TS signer; the fixed vectors in
``middleware/src/lib/__tests__/fixtures/service-envelope-vectors.json`` are
checked by both languages (``test_service_envelope.py`` and
``service-envelope-contract.test.ts``).

By default the static header does NOT ride along: the middleware refuses the
bare header unless it is run with ``SERVICE_AUTH_LEGACY_HEADERS=accept``, so
the static secret stays off the wire. Set ``accept`` (or ``allow``) here only
when talking to an older middleware build that knows nothing but the header.
Rollout order: ``docs/agentcore-preview-surface.md`` §6a.

Values are read live from ``os.environ`` on each call — an env lookup is far
cheaper than the HTTP request it decorates, and reading live keeps tests and
`agentcore dev` honest. Surrounding whitespace is stripped: an operator
pasting from ``aws secretsmanager get-secret-value --output text`` can pick up
a trailing newline, which is not a legal HTTP header value at all and would
turn a header mismatch into an unsendable request.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlsplit

try:  # package import (agents._shared) or flat import (image: /app/_shared on sys.path)
    from .secret_resolver import SecretResolutionError, resolve_secret
except ImportError:
    from secret_resolver import SecretResolutionError, resolve_secret

log = logging.getLogger(__name__)

MIDDLEWARE_URL = os.environ.get("MIDDLEWARE_URL", "http://middleware:3001")

# Run-complete is a terminal status report, not something the agent should
# block on for long.
_HTTP_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Callback:
    """One sessionless middleware route and the credential that unlocks it."""

    #: Stable key used for the announce-once log.
    name: str
    #: Env var the runtime reads the shared secret from.
    env_var: str
    #: HTTP header the middleware compares that secret against.
    header: str
    #: Human-readable route, used in log/error text.
    route: str
    #: Signed-envelope audience prefix; must match the middleware's spec.
    audience: str = ""


APPROVALS_REQUEST = Callback(
    name="approvals.request",
    env_var="APPROVALS_REQUEST_SECRET",
    header="x-approvals-auth",
    route="POST /api/observability/approvals/request",
    audience="orgiq-middleware/approvals",
)

HARNESS_TRACE = Callback(
    name="harness.trace",
    env_var="HARNESS_TRACE_SECRET",
    header="x-harness-auth",
    route="POST /api/observability/harness/trace",
    audience="orgiq-middleware/harness-trace",
)

ASSESSMENT_RUN_COMPLETE = Callback(
    name="assessment.run_complete",
    env_var="ASSESSMENT_RUN_COMPLETE_SECRET",
    header="x-assessment-run-auth",
    route="POST /api/assessment/runs/:runId/complete",
    audience="orgiq-middleware/assessment-run-complete",
)

ALL_CALLBACKS = (APPROVALS_REQUEST, HARNESS_TRACE, ASSESSMENT_RUN_COMPLETE)

#: Callback names already logged at startup — the announcement is per process,
#: not per call, so a chatty agent doesn't fill CloudWatch with it.
_ANNOUNCED: set = set()
_ERRORED: set = set()


def secret_for(cb: Callback) -> str:
    """The configured secret for ``cb``, or ``""`` when unset/blank.

    Logs once per process per callback so an operator reading CloudWatch can
    tell whether *this* runtime version knows the secret — the single most
    useful fact when a callback starts 401ing.
    """
    try:
        value = resolve_secret(cb.env_var)
    except SecretResolutionError as exc:
        # Fail closed: unsigned, so the middleware refuses it. Never crash the agent.
        value = ""
        if cb.name not in _ERRORED:
            _ERRORED.add(cb.name)
            log.error("callbacks: %s", exc)
    if cb.name not in _ANNOUNCED:
        _ANNOUNCED.add(cb.name)
        log.info(
            "callbacks: %s → %s (%s %s)",
            cb.route,
            "sending service auth" if value else "no service auth",
            cb.env_var,
            "set" if value else "unset",
        )
    return value


def auth_headers(cb: Callback) -> dict:
    """``{header: secret}`` when the secret is configured, else ``{}``.

    Merge into an existing header dict; an empty result leaves the request
    exactly as it was before this module existed.
    """
    value = secret_for(cb)
    return {cb.header: value} if value else {}


# ── Signed envelope (service-runtime `service-http-v1`, lane C4) ──────────────

SERVICE_AUTH_HEADER = "X-Service-Auth"
SERVICE_NONCE_HEADER = "x-service-nonce"
#: Envelope service id the Strands agents sign as (middleware AGENT_SERVICE_ID).
AGENT_SERVICE_ID = "orgiq-agent"
LEGACY_HEADERS_ENV = "SERVICE_AUTH_LEGACY_HEADERS"

_ENVELOPE_VERSION = "v1"
_PROTOCOL = "service-http-v1"
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", text or ""):
        return None
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (ValueError, TypeError):
        return None


def canonical_request_payload(method: str, target: str, body: str, audience: str) -> str:
    """service-runtime's canonical string for a request envelope.

    TS builds ``{protocol, audience, method, target, body}`` and serialises it
    with sorted keys and ``JSON.stringify`` for each value. For an all-string
    object that is exactly ``json.dumps(sort_keys, separators=(",", ":"),
    ensure_ascii=False)``: both escape only ``"``, ``\\`` and C0 controls
    (``\\b \\f \\n \\r \\t`` short forms, ``\\u00xx`` lower-case otherwise).
    """
    if not audience.strip():
        raise ValueError("Service request audience is required")
    if not re.fullmatch(r"[A-Za-z]+", method or ""):
        raise ValueError("Invalid HTTP method")
    if not target.startswith("/") or re.search(r"[\s#]", target):
        raise ValueError("Service request target must be an exact origin-form path and query")
    payload = {
        "protocol": _PROTOCOL,
        "audience": audience,
        "method": method.upper(),
        "target": target,
        "body": body or "",
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _mac(secret: str, service_id: str, ts: int, payload: str) -> bytes:
    msg = f"{service_id}.{ts}.{payload}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).digest()


def sign_service_request(
    method: str,
    target: str,
    body: str,
    *,
    secret: str,
    service_id: str,
    audience: str,
    now: float | None = None,
) -> str:
    """``v1.<serviceId>.<unixTs>.<base64url mac>`` — service-runtime's signServiceRequest."""
    if not secret or not secret.strip():
        raise ValueError("secret must be a non-empty, non-whitespace string")
    if not service_id or not service_id.strip() or "." in service_id:
        raise ValueError("serviceId must be non-empty and must not contain '.'")
    ts = int(time.time() if now is None else now)
    mac = _mac(secret, service_id, ts, canonical_request_payload(method, target, body, audience))
    return f"{_ENVELOPE_VERSION}.{service_id}.{ts}.{_b64url(mac)}"


def verify_service_request(
    header: str,
    method: str,
    target: str,
    body: str,
    *,
    secret: str,
    allowed_services: Iterable[str],
    audience: str,
    now: float | None = None,
    ttl_sec: int = 60,
    tolerance_sec: int = 10,
) -> tuple[bool, str]:
    """Python mirror of service-runtime's verifyServiceRequest → ``(ok, serviceId|reason)``.

    Used by the cross-language contract tests; the middleware is the real
    verifier. MAC comparison is constant time (``hmac.compare_digest``).
    """
    parts = (header or "").split(".")
    if len(parts) != 4:
        return False, "malformed"
    version, service_id, ts_str, mac_b64 = parts
    if version != _ENVELOPE_VERSION or not service_id or not ts_str or not mac_b64:
        return False, "malformed"
    if not re.fullmatch(r"\d+", ts_str):
        return False, "malformed"
    presented = _b64url_decode(mac_b64)
    if presented is None or len(presented) != 32:
        return False, "malformed"
    if service_id not in set(allowed_services):
        return False, "unknown-service"
    ts = int(ts_str)
    now_sec = int(time.time() if now is None else now)
    if ts > now_sec + tolerance_sec:
        return False, "future-skew"
    if ts < now_sec - ttl_sec:
        return False, "stale"
    try:
        payload = canonical_request_payload(method, target, body, audience)
    except ValueError:
        return False, "malformed"
    if hmac.compare_digest(_mac(secret, service_id, ts, payload), presented):
        return True, service_id
    return False, "bad-signature"


def nonce_audience(audience: str, nonce: str) -> str:
    """The audience actually signed: the callback's prefix with the nonce bound in."""
    return f"{audience}#{nonce}"


def new_nonce() -> str:
    """24 base64url chars (144 bits) — inside the middleware's 16–128 bound."""
    return secrets.token_urlsafe(18)


def legacy_headers_allowed() -> bool:
    """True only when the transition flag says ``accept`` or ``allow``."""
    return (os.environ.get(LEGACY_HEADERS_ENV) or "").strip().lower() in ("accept", "allow")


def request_target(url: str) -> str:
    """Origin-form target (path + query) exactly as urllib/httpx put it on the wire."""
    parts = urlsplit(url)
    target = parts.path or "/"
    return f"{target}?{parts.query}" if parts.query else target


def request_headers(
    cb: Callback,
    method: str,
    url: str,
    body: bytes | str | None = None,
    *,
    service_id: str = AGENT_SERVICE_ID,
) -> dict:
    """Every auth header this request should carry, or ``{}`` when the secret is unset.

    ``body`` must be the exact bytes sent. With a secret: the signed envelope
    and its nonce, plus the static header while the transition flag allows it.
    A signing failure never crashes the caller; it falls back to the static
    header so the request is no worse than before lane C4.
    """
    value = secret_for(cb)
    if not value:
        return {}
    headers: dict = {}
    if legacy_headers_allowed():
        headers[cb.header] = value
    try:
        text = body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else (body or "")
        nonce = new_nonce()
        headers[SERVICE_AUTH_HEADER] = sign_service_request(
            method, request_target(url), text,
            secret=value, service_id=service_id,
            audience=nonce_audience(cb.audience, nonce),
        )
        headers[SERVICE_NONCE_HEADER] = nonce
    except Exception as exc:  # noqa: BLE001 — a callback must never crash the agent
        log.warning("callbacks: could not sign %s (%s); sending the static header only", cb.route, exc)
        headers.pop(SERVICE_AUTH_HEADER, None)
        headers.pop(SERVICE_NONCE_HEADER, None)
        headers[cb.header] = value
    return headers


def is_auth_failure(status: Any) -> bool:
    """True for the statuses the middleware guards return (401; 403 defensively)."""
    return status in (401, 403)


def auth_failure_note(cb: Callback, status: Any) -> str:
    """One actionable sentence for a rejected callback.

    Distinguishes the two failure modes an operator has to tell apart:
    the runtime sent nothing (deployed before the secret existed) versus the
    runtime sent the *wrong* value (secret rotated under it).
    """
    if secret_for(cb):
        return (
            f"{cb.route} rejected this runtime's {cb.header} (HTTP {status}): the "
            f"{cb.env_var} baked into this runtime does not match the middleware's "
            "secret — redeploy OrgIQ-AgentCoreRuntime with the current value"
        )
    return (
        f"{cb.route} requires service auth (HTTP {status}) and {cb.env_var} is unset "
        "in this runtime — redeploy OrgIQ-AgentCoreRuntime with the middleware's "
        "secret in that variable"
    )


def reset_announcements() -> None:
    """Test hook — forget which callbacks have already logged their state."""
    _ANNOUNCED.clear()
    _ERRORED.clear()


# ── Assessment run-complete client ────────────────────────────────────────────


def post_run_complete(
    run_id: str,
    *,
    status: str,
    summary: str | None = None,
    error: str | None = None,
    files_written: list | None = None,
    scoring_log: list | None = None,
    middleware_url: str | None = None,
) -> dict:
    """Report a finished assessment run to the middleware.

    This is the canonical, header-aware client for the third callback. On the
    real Aurora path it is the ONLY thing that moves a launched run out of
    ``status: 'running'`` — nothing else calls ``updateRunStatus`` outside the
    operator-initiated ``/stop``, so a run that never reports back holds a slot
    against ``RUN_CONCURRENCY_CAP`` forever.

    Unlike the trace callback there is no second delivery path, so a failure is
    reported back to the caller rather than swallowed — but it is still
    returned, never raised: a scorer that finished its work should not die
    because the status report bounced.

    Returns ``{"ok": bool, "status": <http status|None>, "run": <body>|None,
    "note": <message>|None}``.
    """
    if status not in ("completed", "failed"):
        return {"ok": False, "status": None, "run": None,
                "note": 'status must be "completed" or "failed"'}

    base = (middleware_url or MIDDLEWARE_URL).rstrip("/")
    url = f"{base}/api/assessment/runs/{run_id}/complete"

    body: dict = {"status": status}
    if summary is not None:
        body["summary"] = summary
    if error is not None:
        body["error"] = error
    if files_written is not None:
        body["files_written"] = list(files_written)
    if scoring_log is not None:
        body["scoring_log"] = list(scoring_log)

    try:
        data = json.dumps(body, default=str, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        return {"ok": False, "status": None, "run": None,
                "note": f"failed to serialise run-complete body: {exc}"}

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(request_headers(ASSESSMENT_RUN_COMPLETE, "POST", url, data))

    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
            raw = resp.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError):
            parsed = None
        return {"ok": True, "status": 200, "run": parsed, "note": None}
    except urllib.error.HTTPError as exc:
        if is_auth_failure(exc.code):
            note = auth_failure_note(ASSESSMENT_RUN_COMPLETE, exc.code)
            log.error("callbacks: %s", note)
        else:
            note = f"{url} -> HTTP {exc.code}"
            log.warning("callbacks: run-complete %s", note)
        return {"ok": False, "status": exc.code, "run": None, "note": note}
    except urllib.error.URLError as exc:
        note = f"{url} unreachable: {exc.reason}"
        log.warning("callbacks: run-complete %s", note)
        return {"ok": False, "status": None, "run": None, "note": note}
    except Exception as exc:  # noqa: BLE001 — a status report must not kill the run
        note = f"{url} unexpected error: {exc}"
        log.warning("callbacks: run-complete %s", note)
        return {"ok": False, "status": None, "run": None, "note": note}
