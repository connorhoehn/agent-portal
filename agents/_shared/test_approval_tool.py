"""Unit tests for _shared/approval_tool.py — no network, no strands, no httpx.

`request_approval` is the only human-in-the-loop gate in the fleet: an agent
about to do something expensive blocks here until a person decides. Everything
worth testing about it is a *failure* behaviour, because the failure modes all
look like decisions:

  * a 401 on the POST must never read as a decision — no approval row exists;
  * a 401 on the **poll** must fail fast and say why. This is the regression
    the module docstring describes: the header used to go out only on the POST,
    so against a session-enforcing middleware every poll 401ed, the tool
    swallowed each one as transient, and five minutes later it reported
    `EXPIRED` — a fictitious verdict, invented after a human had already
    clicked approve;
  * a genuinely transient error must NOT stop the poll, because the approval
    row does still exist and a human is still looking at it.

`strands` and `httpx` are not installed in the offline test venv, so both are
stubbed in sys.modules before the import. The `@tool` stub is the identity
function, which means these tests exercise the raw Python callable — the
polling logic — and deliberately not Strands' schema generation.

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_approval_tool
"""

from __future__ import annotations

import json as _json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ── Stub httpx + strands before importing the module under test ──────────────

_httpx = types.ModuleType("httpx")


class _HTTPStatusError(Exception):
    def __init__(self, message="", *, request=None, response=None):
        super().__init__(message)
        self.request = request
        self.response = response


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise _HTTPStatusError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._payload


class _FakeClient:
    """Scripted client. `script` is consulted by the test via `_Server`."""

    server = None  # set per-test

    def __init__(self, timeout=None):
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, json=None, content=None, headers=None):
        if content is not None:  # signed path: exact bytes (lane C4)
            json = _json.loads(content)
        return _FakeClient.server.post(url, json, headers or {})

    def get(self, url, headers=None):
        return _FakeClient.server.get(url, headers or {})


_httpx.Client = _FakeClient
_httpx.HTTPStatusError = _HTTPStatusError
sys.modules.setdefault("httpx", _httpx)

_strands = types.ModuleType("strands")
_strands.tool = lambda fn: fn
sys.modules.setdefault("strands", _strands)

from _shared import approval_tool as at  # noqa: E402
from _shared import callbacks  # noqa: E402


class _Server:
    """Records every request and replays a scripted sequence of poll results."""

    def __init__(self, *, post_result=None, post_raises=None, polls=None):
        self.post_calls = []
        self.get_calls = []
        self._post_result = post_result or _FakeResponse(200, {"approvalId": "ap-1"})
        self._post_raises = post_raises
        # `polls` is a list of _FakeResponse or Exception; the LAST entry is
        # repeated once exhausted so a 150-poll budget test needs one item.
        self._polls = list(polls or [_FakeResponse(200, {"status": "PENDING"})])

    def post(self, url, body, headers):
        self.post_calls.append({"url": url, "body": body, "headers": headers})
        if self._post_raises is not None:
            raise self._post_raises
        return self._post_result

    def get(self, url, headers):
        self.get_calls.append({"url": url, "headers": headers})
        idx = min(len(self.get_calls) - 1, len(self._polls) - 1)
        item = self._polls[idx]
        if isinstance(item, Exception):
            raise item
        return item


def _err(code: int) -> _HTTPStatusError:
    return _HTTPStatusError(f"HTTP {code}", response=_FakeResponse(code))


class _Base(unittest.TestCase):
    def setUp(self):
        # Bind OUR httpx double onto the already-imported module rather than
        # relying on whichever stub reached sys.modules first. test_callbacks.py
        # installs its own; both files must pass in either order and in the
        # same process.
        httpx_patch = mock.patch.object(at, "httpx", _httpx)
        httpx_patch.start()
        self.addCleanup(httpx_patch.stop)
        callbacks.reset_announcements()
        self._saved = {
            k: os.environ.get(k)
            for k in ("APPROVALS_REQUEST_SECRET", "AGENT_ID")
        }
        os.environ.pop("APPROVALS_REQUEST_SECRET", None)
        os.environ["AGENT_ID"] = "orgiq-ingestion"
        # Never actually sleep: the real budget is 150 × 2s.
        sleeper = mock.patch.object(at.time, "sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        _FakeClient.server = None

    def run_tool(self, server, **kwargs):
        _FakeClient.server = server
        defaults = dict(
            tx_id="tx-1",
            payload={"amount": 25000, "counterparty": "ACME Corp"},
            reason="over the Cedar threshold",
        )
        defaults.update(kwargs)
        return at.request_approval(**defaults)


# ── Happy paths ──────────────────────────────────────────────────────────────


class DecisionTests(_Base):
    def test_approval_is_returned_with_the_note_and_row_id(self):
        server = _Server(
            polls=[_FakeResponse(200, {"status": "APPROVED", "decidedNote": "looks fine"})]
        )
        out = self.run_tool(server)
        self.assertEqual(out["status"], "APPROVED")
        self.assertEqual(out["note"], "looks fine")
        self.assertEqual(out["approvalId"], "ap-1")

    def test_rejection_is_passed_through_unchanged(self):
        server = _Server(
            polls=[_FakeResponse(200, {"status": "REJECTED", "decidedNote": "no"})]
        )
        self.assertEqual(self.run_tool(server)["status"], "REJECTED")

    def test_server_side_expiry_is_passed_through(self):
        server = _Server(polls=[_FakeResponse(200, {"status": "EXPIRED"})])
        self.assertEqual(self.run_tool(server)["status"], "EXPIRED")

    def test_snake_case_note_is_accepted(self):
        server = _Server(
            polls=[_FakeResponse(200, {"status": "APPROVED", "decided_note": "ok"})]
        )
        self.assertEqual(self.run_tool(server)["note"], "ok")

    def test_polling_stops_the_moment_a_decision_lands(self):
        server = _Server(
            polls=[
                _FakeResponse(200, {"status": "PENDING"}),
                _FakeResponse(200, {"status": "PENDING"}),
                _FakeResponse(200, {"status": "APPROVED"}),
            ]
        )
        self.run_tool(server)
        self.assertEqual(len(server.get_calls), 3)

    def test_request_body_and_urls(self):
        server = _Server(polls=[_FakeResponse(200, {"status": "APPROVED"})])
        self.run_tool(server)
        post = server.post_calls[0]
        self.assertTrue(
            post["url"].endswith("/api/observability/approvals/request"), post["url"]
        )
        self.assertEqual(post["body"]["txId"], "tx-1")
        self.assertEqual(post["body"]["agentId"], "orgiq-ingestion")
        self.assertEqual(post["body"]["reason"], "over the Cedar threshold")
        self.assertEqual(post["body"]["payload"]["amount"], 25000)
        self.assertTrue(
            server.get_calls[0]["url"].endswith("/api/observability/approvals/ap-1")
        )

    def test_budget_is_five_minutes(self):
        self.assertEqual(at._POLL_INTERVAL_SEC * at._MAX_POLLS, 300)


# ── The 401 regression ───────────────────────────────────────────────────────


class PollAuthFailureTests(_Base):
    def test_poll_401_fails_fast_and_does_not_invent_a_verdict(self):
        # THE regression. Before the fix this burned 150 polls and returned
        # EXPIRED — a decision the tool had no basis for, reported minutes
        # after a human had already approved the row.
        server = _Server(polls=[_err(401)])
        out = self.run_tool(server)
        self.assertEqual(out["status"], "ERROR")
        self.assertNotEqual(out["status"], "EXPIRED")
        self.assertEqual(len(server.get_calls), 1, "must stop after the first 401")
        self.assertEqual(self.sleep.call_count, 0, "must not burn the 5-minute budget")

    def test_poll_401_still_reports_the_row_id_the_human_is_looking_at(self):
        # The approval row exists and someone may well decide it; the agent
        # just cannot hear the answer. Handing back the id is what lets an
        # operator go find it.
        out = self.run_tool(_Server(polls=[_err(401)]))
        self.assertEqual(out["approvalId"], "ap-1")

    def test_poll_403_is_treated_the_same(self):
        out = self.run_tool(_Server(polls=[_err(403)]))
        self.assertEqual(out["status"], "ERROR")
        self.assertEqual(len(_FakeClient.server.get_calls), 1)

    def test_poll_401_note_names_the_variable_to_fix_when_unset(self):
        out = self.run_tool(_Server(polls=[_err(401)]))
        self.assertIn("APPROVALS_REQUEST_SECRET", out["note"])
        self.assertIn("unset", out["note"])

    def test_poll_401_note_distinguishes_a_stale_secret_from_a_missing_one(self):
        os.environ["APPROVALS_REQUEST_SECRET"] = "stale-value"
        callbacks.reset_announcements()
        out = self.run_tool(_Server(polls=[_err(401)]))
        self.assertIn("does not match", out["note"])
        self.assertIn("redeploy OrgIQ-AgentCoreRuntime", out["note"])


class PostAuthFailureTests(_Base):
    def test_post_401_is_an_error_not_a_decision_and_never_polls(self):
        server = _Server(post_raises=_err(401))
        out = self.run_tool(server)
        self.assertEqual(out["status"], "ERROR")
        self.assertIn("APPROVALS_REQUEST_SECRET", out["note"])
        self.assertEqual(server.get_calls, [], "no row exists, nothing to poll")

    def test_post_401_carries_no_approval_id(self):
        out = self.run_tool(_Server(post_raises=_err(401)))
        self.assertNotIn("approvalId", out)

    def test_post_403_is_treated_the_same(self):
        self.assertEqual(
            self.run_tool(_Server(post_raises=_err(403)))["status"], "ERROR"
        )


# ── Transient failures must not stop the poll ────────────────────────────────


class TransientFailureTests(_Base):
    def test_a_500_on_one_poll_does_not_abandon_the_request(self):
        server = _Server(
            polls=[
                _err(500),
                _FakeResponse(200, {"status": "APPROVED", "decidedNote": "yes"}),
            ]
        )
        out = self.run_tool(server)
        self.assertEqual(out["status"], "APPROVED")
        self.assertEqual(len(server.get_calls), 2)

    def test_a_connection_error_on_one_poll_does_not_abandon_the_request(self):
        server = _Server(
            polls=[
                ConnectionError("middleware restarting"),
                _FakeResponse(200, {"status": "APPROVED"}),
            ]
        )
        self.assertEqual(self.run_tool(server)["status"], "APPROVED")

    def test_budget_exhaustion_reports_expired_with_the_last_error(self):
        server = _Server(polls=[_err(503)])
        out = self.run_tool(server)
        self.assertEqual(out["status"], "EXPIRED")
        self.assertEqual(out["approvalId"], "ap-1")
        self.assertIn("503", out["note"])
        self.assertEqual(len(server.get_calls), at._MAX_POLLS)

    def test_a_never_decided_row_expires_after_the_full_budget(self):
        server = _Server(polls=[_FakeResponse(200, {"status": "PENDING"})])
        out = self.run_tool(server)
        self.assertEqual(out["status"], "EXPIRED")
        self.assertIn("poll timeout", out["note"])
        self.assertEqual(len(server.get_calls), at._MAX_POLLS)


class PostFailureTests(_Base):
    def test_unreachable_middleware_is_an_error_not_a_decision(self):
        out = self.run_tool(_Server(post_raises=ConnectionError("no route")))
        self.assertEqual(out["status"], "ERROR")
        self.assertIn("approval request failed", out["note"])

    def test_missing_approval_id_is_an_error(self):
        server = _Server(post_result=_FakeResponse(200, {}))
        out = self.run_tool(server)
        self.assertEqual(out["status"], "ERROR")
        self.assertIn("no approvalId", out["note"])
        self.assertEqual(server.get_calls, [])


# ── Service auth header ──────────────────────────────────────────────────────


class ServiceAuthHeaderTests(_Base):
    def test_no_header_when_the_secret_is_unset(self):
        server = _Server(polls=[_FakeResponse(200, {"status": "APPROVED"})])
        self.run_tool(server)
        self.assertEqual(server.post_calls[0]["headers"], {})
        self.assertEqual(server.get_calls[0]["headers"], {})

    def test_header_goes_on_the_post_AND_every_poll(self):
        # The poll half is the part that was missing. `GET /approvals/:id` is a
        # dual-caller route — a human reads it under session + Cedar, this tool
        # reads it with no cookie at all.
        os.environ["APPROVALS_REQUEST_SECRET"] = "s3cret"
        callbacks.reset_announcements()
        server = _Server(
            polls=[
                _FakeResponse(200, {"status": "PENDING"}),
                _FakeResponse(200, {"status": "PENDING"}),
                _FakeResponse(200, {"status": "APPROVED"}),
            ]
        )
        self.run_tool(server)
        post_headers = server.post_calls[0]["headers"]
        self.assertEqual(post_headers["x-approvals-auth"], "s3cret")
        self.assertTrue(post_headers["X-Service-Auth"].startswith("v1.orgiq-agent."))
        self.assertEqual(len(server.get_calls), 3)
        nonces = set()
        for call in server.get_calls:
            self.assertEqual(call["headers"]["x-approvals-auth"], "s3cret")
            self.assertIn("X-Service-Auth", call["headers"])
            nonces.add(call["headers"]["x-service-nonce"])
        # Each poll is signed fresh: a single-use nonce per request.
        self.assertEqual(len(nonces), 3)

    def test_a_pasted_trailing_newline_is_stripped(self):
        # `aws secretsmanager get-secret-value --output text` yields one; a
        # newline is not a legal HTTP header value, so it would turn a header
        # mismatch into an unsendable request.
        os.environ["APPROVALS_REQUEST_SECRET"] = "  s3cret\n"
        callbacks.reset_announcements()
        server = _Server(polls=[_FakeResponse(200, {"status": "APPROVED"})])
        self.run_tool(server)
        self.assertEqual(server.get_calls[0]["headers"]["x-approvals-auth"], "s3cret")


class NeverFabricatesApprovalTests(_Base):
    def test_no_failure_mode_returns_APPROVED(self):
        # A blanket assertion: the one verdict this tool must never invent is
        # the permissive one.
        cases = [
            _Server(post_raises=_err(401)),
            _Server(post_raises=_err(403)),
            _Server(post_raises=ConnectionError("down")),
            _Server(post_result=_FakeResponse(200, {})),
            _Server(polls=[_err(401)]),
            _Server(polls=[_err(403)]),
            _Server(polls=[_err(500)]),
            _Server(polls=[ConnectionError("down")]),
            _Server(polls=[_FakeResponse(200, {"status": "PENDING"})]),
            _Server(polls=[_FakeResponse(200, {})]),  # no status key at all
        ]
        for server in cases:
            with self.subTest(server=server):
                self.assertNotEqual(self.run_tool(server)["status"], "APPROVED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
