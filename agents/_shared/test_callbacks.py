"""Unit tests for the machine-callback service auth — stdlib unittest, no network.

Run:  python -m unittest agents._shared.test_callbacks  (from repo root)
or:   cd agents/_shared && python -m unittest test_callbacks

Covers the contract in `callbacks.py`: header present when the secret is set,
absent when it is not, and what each callback does with a 401.

`approval_tool` imports httpx + strands, which are agent-image deps and are not
installed on a dev host. We install deterministic, network-free doubles for
both before importing it (and restore whatever was there afterwards) so the
header wiring is testable the same way the rest of `_shared` is.
"""

from __future__ import annotations

import io
import json
import json as _json
import os
import sys
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import callbacks as cb  # noqa: E402
from _shared import instrumentation as instr  # noqa: E402


# ── httpx / strands doubles ───────────────────────────────────────────────────


class StubHTTPStatusError(Exception):
    def __init__(self, message: str, response: "StubResponse") -> None:
        super().__init__(message)
        self.response = response


class StubResponse:
    def __init__(self, status_code: int = 200, body: dict | None = None) -> None:
        self.status_code = status_code
        self._body = body if body is not None else {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise StubHTTPStatusError(f"HTTP {self.status_code}", self)

    def json(self) -> dict:
        return self._body


class StubClient:
    """Records every request; responses are set per-test on the class."""

    posts: list = []
    gets: list = []
    post_response = StubResponse(200, {"approvalId": "ap-1"})
    get_response = StubResponse(200, {"status": "APPROVED", "decidedNote": "ok"})

    def __init__(self, timeout=None) -> None:  # noqa: ANN001 - stub
        pass

    def __enter__(self) -> "StubClient":
        return self

    def __exit__(self, *exc) -> bool:  # noqa: ANN002 - stub
        return False

    def post(self, url, json=None, content=None, headers=None):  # noqa: A002 - mirrors httpx
        if content is not None:  # signed path sends exact bytes (lane C4)
            StubClient.posts.append({"url": url, "json": _json.loads(content),
                                     "content": content, "headers": headers or {}})
            return StubClient.post_response
        StubClient.posts.append({"url": url, "json": json, "headers": headers or {}})
        return StubClient.post_response

    def get(self, url, headers=None):
        StubClient.gets.append({"url": url, "headers": headers or {}})
        return StubClient.get_response

    @classmethod
    def reset(cls) -> None:
        cls.posts = []
        cls.gets = []
        cls.post_response = StubResponse(200, {"approvalId": "ap-1"})
        cls.get_response = StubResponse(200, {"status": "APPROVED", "decidedNote": "ok"})


_SAVED_MODULES: dict = {}


def setUpModule() -> None:  # noqa: N802 - unittest hook
    for name in ("httpx", "strands"):
        _SAVED_MODULES[name] = sys.modules.get(name)
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.Client = StubClient
    httpx_stub.HTTPStatusError = StubHTTPStatusError
    sys.modules["httpx"] = httpx_stub
    strands_stub = types.ModuleType("strands")
    strands_stub.tool = lambda fn: fn  # `@tool` is identity here
    sys.modules["strands"] = strands_stub

    global approval_tool
    from _shared import approval_tool as _approval_tool  # noqa: PLC0415

    approval_tool = _approval_tool
    # `import httpx` inside approval_tool binds whichever module object was in
    # sys.modules the FIRST time it was imported — which may have been another
    # test file's double if that file loaded first. Rebind it explicitly so
    # these tests are independent of import order.
    _SAVED_MODULES["approval_tool.httpx"] = getattr(approval_tool, "httpx", None)
    approval_tool.httpx = httpx_stub


def tearDownModule() -> None:  # noqa: N802 - unittest hook
    saved_httpx = _SAVED_MODULES.pop("approval_tool.httpx", None)
    if saved_httpx is not None:
        approval_tool.httpx = saved_httpx
    for name, mod in _SAVED_MODULES.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod


# ── helpers ───────────────────────────────────────────────────────────────────


def _header(req, name: str) -> str | None:
    """Case-insensitive read of a header off a urllib Request."""
    for key, value in req.header_items():
        if key.lower() == name.lower():
            return value
    return None


def _ok_urlopen(body: bytes = b"{}"):
    """A urlopen double usable as a context manager."""
    resp = mock.MagicMock()
    resp.read.return_value = body
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    return mock.Mock(return_value=cm)


def _http_error(code: int):
    return urllib.error.HTTPError("http://mw/x", code, "Unauthorized", hdrs=None, fp=None)


def _clear_secrets() -> None:
    for callback in cb.ALL_CALLBACKS:
        os.environ.pop(callback.env_var, None)
    cb.reset_announcements()


# ── header contract ───────────────────────────────────────────────────────────


class AuthHeaderTests(unittest.TestCase):
    def setUp(self):
        _clear_secrets()

    def tearDown(self):
        _clear_secrets()

    def test_no_header_when_secret_unset(self):
        for callback in cb.ALL_CALLBACKS:
            self.assertEqual(cb.auth_headers(callback), {})

    def test_header_present_when_secret_set(self):
        for callback in cb.ALL_CALLBACKS:
            os.environ[callback.env_var] = "s3cret"
            self.assertEqual(cb.auth_headers(callback), {callback.header: "s3cret"})

    def test_header_names_match_the_middleware_guards(self):
        # These strings are compared byte-for-byte server-side; a typo here is
        # a 401 nobody can debug from the agent side.
        self.assertEqual(cb.APPROVALS_REQUEST.header, "x-approvals-auth")
        self.assertEqual(cb.HARNESS_TRACE.header, "x-harness-auth")
        self.assertEqual(cb.ASSESSMENT_RUN_COMPLETE.header, "x-assessment-run-auth")
        self.assertEqual(cb.APPROVALS_REQUEST.env_var, "APPROVALS_REQUEST_SECRET")
        self.assertEqual(cb.HARNESS_TRACE.env_var, "HARNESS_TRACE_SECRET")
        self.assertEqual(
            cb.ASSESSMENT_RUN_COMPLETE.env_var, "ASSESSMENT_RUN_COMPLETE_SECRET"
        )

    def test_blank_secret_reads_as_unset(self):
        os.environ[cb.HARNESS_TRACE.env_var] = "   "
        self.assertEqual(cb.auth_headers(cb.HARNESS_TRACE), {})

    def test_surrounding_whitespace_is_stripped(self):
        # `--output text` copy-paste picks up a newline, which is not a legal
        # header value at all.
        os.environ[cb.HARNESS_TRACE.env_var] = " s3cret\n"
        self.assertEqual(cb.auth_headers(cb.HARNESS_TRACE), {"x-harness-auth": "s3cret"})

    def test_auth_failure_note_names_the_variable(self):
        note_unset = cb.auth_failure_note(cb.HARNESS_TRACE, 401)
        self.assertIn("HARNESS_TRACE_SECRET", note_unset)
        self.assertIn("unset", note_unset)
        os.environ[cb.HARNESS_TRACE.env_var] = "wrong"
        note_set = cb.auth_failure_note(cb.HARNESS_TRACE, 401)
        self.assertIn("does not match", note_set)


# ── trace callback ────────────────────────────────────────────────────────────


class PostTraceTests(unittest.TestCase):
    BUNDLE = {"agentId": "orgiq-search", "prompt": "p", "response": "r"}

    def setUp(self):
        _clear_secrets()

    def tearDown(self):
        _clear_secrets()

    def test_no_header_when_secret_unset(self):
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            self.assertTrue(instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw"))
        req = opener.call_args[0][0]
        self.assertIsNone(_header(req, "x-harness-auth"))

    def test_header_sent_when_secret_set(self):
        os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            self.assertTrue(instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw"))
        req = opener.call_args[0][0]
        self.assertEqual(_header(req, "x-harness-auth"), "trace-secret")

    def test_401_returns_false_and_never_raises(self):
        opener = mock.Mock(side_effect=_http_error(401))
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            self.assertFalse(instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw"))

    def test_401_does_not_retry_without_the_header(self):
        os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        opener = mock.Mock(side_effect=_http_error(401))
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw")
        self.assertEqual(opener.call_count, 1)

    def test_401_still_emits_the_stdout_fallback(self):
        # The whole reason a rejected trace POST is survivable: CloudWatch has
        # the bundle regardless, so nothing is lost — only the fast path.
        opener = mock.Mock(side_effect=_http_error(401))
        buf = io.StringIO()
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(buf):
            instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw")
        line = buf.getvalue().strip()
        self.assertTrue(line.startswith("ORGIQ_TRACE:"))
        self.assertEqual(json.loads(line[len("ORGIQ_TRACE:"):])["agentId"], "orgiq-search")

    def test_401_logs_an_actionable_error(self):
        opener = mock.Mock(side_effect=_http_error(401))
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            with self.assertLogs(instr.log, level="ERROR") as logs:
                instr.post_trace(dict(self.BUNDLE), middleware_url="http://mw")
        joined = "\n".join(logs.output)
        self.assertIn("HARNESS_TRACE_SECRET", joined)
        self.assertIn("stdout", joined)


# ── approvals callback ────────────────────────────────────────────────────────


class RequestApprovalTests(unittest.TestCase):
    def setUp(self):
        _clear_secrets()
        StubClient.reset()

    def tearDown(self):
        _clear_secrets()
        StubClient.reset()

    def _call(self):
        return approval_tool.request_approval("tx-1", {"amount": 10}, "because")

    def test_no_header_when_secret_unset(self):
        result = self._call()
        self.assertEqual(result["status"], "APPROVED")
        self.assertEqual(StubClient.posts[0]["headers"], {})

    def test_header_sent_when_secret_set(self):
        os.environ["APPROVALS_REQUEST_SECRET"] = "approve-secret"
        self._call()
        headers = StubClient.posts[0]["headers"]
        self.assertEqual(headers["x-approvals-auth"], "approve-secret")
        # The envelope covers the exact bytes sent.
        nonce = headers["x-service-nonce"]
        ok, _ = cb.verify_service_request(
            headers["X-Service-Auth"], "POST", "/api/observability/approvals/request",
            StubClient.posts[0]["content"].decode("utf-8"),
            secret="approve-secret", allowed_services=["orgiq-agent"],
            audience=f"orgiq-middleware/approvals#{nonce}",
        )
        self.assertTrue(ok)

    def test_401_fails_closed_with_an_actionable_note(self):
        # No second delivery path here — the agent must not read a rejected
        # request as anything but an error.
        StubClient.post_response = StubResponse(401)
        result = self._call()
        self.assertEqual(result["status"], "ERROR")
        self.assertIn("APPROVALS_REQUEST_SECRET", result["note"])
        self.assertNotIn("approvalId", result)
        self.assertEqual(StubClient.gets, [])  # never polled

    def test_non_auth_http_error_keeps_the_old_message(self):
        StubClient.post_response = StubResponse(500)
        result = self._call()
        self.assertEqual(result["status"], "ERROR")
        self.assertIn("approval request failed", result["note"])


# ── approval LONG-POLL (the read half of the same loop) ───────────────────────
#
# GET /api/observability/approvals/:id is a dual-caller route: a human reads it
# under session + Cedar, this tool reads it with no cookie. Without the
# credential on the poll, a session-enforcing middleware 401s every one of the
# 150 polls and the tool reports a fictitious EXPIRED five minutes after the
# human already approved.


class ApprovalPollTests(unittest.TestCase):
    def setUp(self):
        _clear_secrets()
        StubClient.reset()

    def tearDown(self):
        _clear_secrets()
        StubClient.reset()

    def _call(self):
        return approval_tool.request_approval("tx-1", {"amount": 10}, "because")

    def test_poll_carries_the_same_credential_as_the_post(self):
        os.environ["APPROVALS_REQUEST_SECRET"] = "approve-secret"
        result = self._call()
        self.assertEqual(result["status"], "APPROVED")
        self.assertEqual(StubClient.gets[0]["headers"]["x-approvals-auth"], "approve-secret")
        self.assertIn("X-Service-Auth", StubClient.gets[0]["headers"])

    def test_poll_sends_no_header_when_the_secret_is_unset(self):
        # Byte-for-byte the pre-existing request, so nothing changes for a
        # middleware that has not been locked down yet.
        self._call()
        self.assertEqual(StubClient.gets[0]["headers"], {})

    def test_rejected_poll_stops_immediately_with_an_actionable_note(self):
        # NOT 150 polls ending in EXPIRED: a 401 cannot become a 200, and
        # "EXPIRED" would be a lie about a row a human may well have approved.
        os.environ["APPROVALS_REQUEST_SECRET"] = "approve-secret"
        StubClient.get_response = StubResponse(401)
        result = self._call()
        self.assertEqual(result["status"], "ERROR")
        self.assertIn("APPROVALS_REQUEST_SECRET", result["note"])
        self.assertEqual(result["approvalId"], "ap-1")  # the row does exist
        self.assertEqual(len(StubClient.gets), 1)


# ── assessment run-complete callback ──────────────────────────────────────────


class PostRunCompleteTests(unittest.TestCase):
    def setUp(self):
        _clear_secrets()

    def tearDown(self):
        _clear_secrets()

    def test_no_header_when_secret_unset(self):
        opener = _ok_urlopen(b'{"id":"run-1"}')
        with mock.patch("urllib.request.urlopen", opener):
            result = cb.post_run_complete(
                "run-1", status="completed", middleware_url="http://mw"
            )
        self.assertTrue(result["ok"])
        req = opener.call_args[0][0]
        self.assertIsNone(_header(req, "x-assessment-run-auth"))
        self.assertEqual(req.full_url, "http://mw/api/assessment/runs/run-1/complete")

    def test_header_sent_when_secret_set(self):
        os.environ["ASSESSMENT_RUN_COMPLETE_SECRET"] = "run-secret"
        opener = _ok_urlopen(b'{"id":"run-1"}')
        with mock.patch("urllib.request.urlopen", opener):
            cb.post_run_complete("run-1", status="failed", error="boom",
                                 middleware_url="http://mw")
        req = opener.call_args[0][0]
        self.assertEqual(_header(req, "x-assessment-run-auth"), "run-secret")
        self.assertEqual(json.loads(req.data.decode())["error"], "boom")

    def test_401_reports_failure_without_raising(self):
        opener = mock.Mock(side_effect=_http_error(401))
        with mock.patch("urllib.request.urlopen", opener):
            result = cb.post_run_complete(
                "run-1", status="completed", middleware_url="http://mw"
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 401)
        self.assertIn("ASSESSMENT_RUN_COMPLETE_SECRET", result["note"])
        self.assertEqual(opener.call_count, 1)  # no retry without the header

    def test_rejects_a_status_the_route_would_reject(self):
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener):
            result = cb.post_run_complete("run-1", status="running")
        self.assertFalse(result["ok"])
        self.assertEqual(opener.call_count, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
