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
``MIDDLEWARE_URL``                  base URL (default the compose service name)

Values are read live from ``os.environ`` on each call — an env lookup is far
cheaper than the HTTP request it decorates, and reading live keeps tests and
`agentcore dev` honest. Surrounding whitespace is stripped: an operator
pasting from ``aws secretsmanager get-secret-value --output text`` can pick up
a trailing newline, which is not a legal HTTP header value at all and would
turn a header mismatch into an unsendable request.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

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


APPROVALS_REQUEST = Callback(
    name="approvals.request",
    env_var="APPROVALS_REQUEST_SECRET",
    header="x-approvals-auth",
    route="POST /api/observability/approvals/request",
)

HARNESS_TRACE = Callback(
    name="harness.trace",
    env_var="HARNESS_TRACE_SECRET",
    header="x-harness-auth",
    route="POST /api/observability/harness/trace",
)

ASSESSMENT_RUN_COMPLETE = Callback(
    name="assessment.run_complete",
    env_var="ASSESSMENT_RUN_COMPLETE_SECRET",
    header="x-assessment-run-auth",
    route="POST /api/assessment/runs/:runId/complete",
)

ALL_CALLBACKS = (APPROVALS_REQUEST, HARNESS_TRACE, ASSESSMENT_RUN_COMPLETE)

#: Callback names already logged at startup — the announcement is per process,
#: not per call, so a chatty agent doesn't fill CloudWatch with it.
_ANNOUNCED: set = set()


def secret_for(cb: Callback) -> str:
    """The configured secret for ``cb``, or ``""`` when unset/blank.

    Logs once per process per callback so an operator reading CloudWatch can
    tell whether *this* runtime version knows the secret — the single most
    useful fact when a callback starts 401ing.
    """
    value = (os.environ.get(cb.env_var) or "").strip()
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

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(auth_headers(ASSESSMENT_RUN_COMPLETE))

    try:
        data = json.dumps(body, default=str, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        return {"ok": False, "status": None, "run": None,
                "note": f"failed to serialise run-complete body: {exc}"}

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
