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
"""

import os
import time
from typing import Any

import httpx
from strands import tool

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
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
            resp = client.post(create_url, json=body)
            resp.raise_for_status()
            approval_id = resp.json().get("approvalId")
    except Exception as exc:
        return {"status": "ERROR", "note": f"approval request failed: {exc}"}

    if not approval_id:
        return {"status": "ERROR", "note": "middleware returned no approvalId"}

    poll_url = f"{base}/api/observability/approvals/{approval_id}"

    # ── Long-poll until decided or budget exhausted ──────────────────────────
    last_err: str | None = None
    with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
        for _ in range(_MAX_POLLS):
            try:
                resp = client.get(poll_url)
                resp.raise_for_status()
                row = resp.json()
                status = row.get("status", "PENDING")
                if status != "PENDING":
                    return {
                        "status": status,
                        "note": row.get("decidedNote") or row.get("decided_note"),
                        "approvalId": approval_id,
                    }
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
