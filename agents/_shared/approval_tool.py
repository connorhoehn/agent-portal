"""Human-in-the-loop approval tool for high-stakes agent actions.

Workflow agents call `request_approval` when they're about to perform an action
that requires explicit human sign-off (e.g. a transaction over a Cedar-gated
amount threshold). The tool:

  1. POSTs the request to middleware (`POST /api/observability/approvals/request`),
     which inserts a row in `observability.approvals` and broadcasts an SSE event
     that the portal listens to.
  2. Long-polls `GET /api/observability/approvals/:id` every 2 seconds until the
     row's status flips from PENDING to APPROVED / REJECTED / EXPIRED, or the
     local 5-minute timeout fires (whichever comes first).

The server also enforces a 5-minute expiry on read — so if the middleware
restarts mid-poll, the next read will still flip a stale PENDING row to EXPIRED.

The middleware URL is read from MIDDLEWARE_URL (defaults to http://middleware:3001
inside the docker network used by docker-compose).

Service auth: BOTH halves of this loop are sessionless machine calls, and both
carry the same credential. When `APPROVALS_REQUEST_SECRET` is set in the
runtime's environment we send it as `x-approvals-auth` on the POST *and* on
every poll; when it is unset we send no header, matching today's behaviour and
the middleware guard's own open-when-unconfigured rule (see
`_shared/callbacks.py`).

The poll needs it because `GET /approvals/:id` is a DUAL-caller route: a human
reads it through the portal under session + Cedar, and this tool reads it with
no cookie at all. Against a session-enforcing deployment an unauthenticated
poll 401s forever — the human approves, the agent never hears, and the tool
reports EXPIRED five minutes later. That is the failure this header prevents.

Unlike the trace callback there is NO second delivery path here, so a rejected
call fails closed — status 'ERROR', never 'APPROVED' — and says which variable
to fix. A rejected *poll* also stops polling immediately rather than burning
five minutes on a request that cannot start succeeding.
"""

import os
import time
from typing import Any

import httpx
from strands import tool

try:  # normal path: imported as `_shared.approval_tool`
    from . import callbacks
except ImportError:  # loaded as a bare top-level module (scripts, notebooks)
    import callbacks  # type: ignore[no-redef]

MIDDLEWARE_URL = os.environ.get("MIDDLEWARE_URL", "http://middleware:3001")

# 5 min total budget = 150 polls at 2s each.
_POLL_INTERVAL_SEC = 2
_MAX_POLLS = 150
_HTTP_TIMEOUT_SEC = 10.0


@tool
def request_approval(tx_id: str, payload: dict, reason: str) -> dict:
    """Request human approval for a high-stakes action. Blocks until decided or timeout.

    Call this BEFORE performing any action that needs explicit human sign-off
    (e.g. a transaction whose amount exceeds the Cedar-defined threshold). The
    middleware records the request, notifies approvers via SSE, and this tool
    blocks for up to 5 minutes waiting for a decision.

    Args:
        tx_id: External transaction id (idempotency key for the caller's audit log).
        payload: Arbitrary JSON describing the action (e.g. {"amount": 25000,
            "counterparty": "ACME Corp", "currency": "USD"}). The `amount` field
            is read by Cedar when evaluating ApproveTransaction.
        reason: Human-readable explanation of why this action needs approval.

    Returns:
        dict with keys:
          - status: 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'ERROR'
          - note: free-text rationale from the approver (or error message)
          - approvalId: middleware row id (present except on early POST failure)
    """
    base = MIDDLEWARE_URL.rstrip("/")
    create_url = f"{base}/api/observability/approvals/request"
    body: dict[str, Any] = {
        "txId": tx_id,
        "agentId": os.environ.get("AGENT_ID", "unknown"),
        "payload": payload,
        "reason": reason,
    }

    # ── Create the approval row ──────────────────────────────────────────────
    # Empty dict when APPROVALS_REQUEST_SECRET is unset — the request then goes
    # out byte-for-byte as it did before service auth existed.
    auth = callbacks.auth_headers(callbacks.APPROVALS_REQUEST)
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
            resp = client.post(create_url, json=body, headers=auth)
            resp.raise_for_status()
            approval_id = resp.json().get("approvalId")
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if callbacks.is_auth_failure(code):
            # Fail closed: no approval row exists, so the caller must NOT treat
            # this as a decision. Naming the variable turns an opaque 401 into
            # a one-line fix.
            return {
                "status": "ERROR",
                "note": callbacks.auth_failure_note(callbacks.APPROVALS_REQUEST, code),
            }
        return {"status": "ERROR", "note": f"approval request failed: {exc}"}
    except Exception as exc:
        return {"status": "ERROR", "note": f"approval request failed: {exc}"}

    if not approval_id:
        return {"status": "ERROR", "note": "middleware returned no approvalId"}

    poll_url = f"{base}/api/observability/approvals/{approval_id}"

    # ── Long-poll until decided or budget exhausted ──────────────────────────
    # Same `auth` headers as the POST: the read side of this loop is a machine
    # call too (see the module docstring).
    last_err: str | None = None
    with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
        for _ in range(_MAX_POLLS):
            try:
                resp = client.get(poll_url, headers=auth)
                resp.raise_for_status()
                row = resp.json()
                status = row.get("status", "PENDING")
                if status != "PENDING":
                    return {
                        "status": status,
                        "note": row.get("decidedNote") or row.get("decided_note"),
                        "approvalId": approval_id,
                    }
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                if callbacks.is_auth_failure(code):
                    # Not transient and not survivable: the credential this
                    # runtime holds will be rejected on every remaining poll, so
                    # spending the full 5 minutes to report a fictitious EXPIRED
                    # is strictly worse than saying what is actually wrong. The
                    # approval row DOES exist and a human may well decide it —
                    # this agent just can't hear the answer.
                    return {
                        "status": "ERROR",
                        "note": callbacks.auth_failure_note(
                            callbacks.APPROVALS_REQUEST, code
                        ),
                        "approvalId": approval_id,
                    }
                last_err = str(exc)
            except Exception as exc:
                last_err = str(exc)
                # Transient HTTP error: keep polling — the row still exists.
            time.sleep(_POLL_INTERVAL_SEC)

    # Local budget exhausted. Server-side read will flip to EXPIRED on next read.
    return {
        "status": "EXPIRED",
        "note": last_err or "client poll timeout reached without decision",
        "approvalId": approval_id,
    }
