"""Service auth for the harness runner's trace callback — stdlib unittest, no network.

Run:  cd infra/scripts && python3 -m unittest test_harness_auth

POST /api/observability/harness/trace is a sessionless machine callback: the
middleware's `requireTraceAuth` is open while HARNESS_TRACE_SECRET is unset and
does a constant-time compare of `x-harness-auth` once it is set. This runner
used to send no header at all, so setting the secret would have 401'd every
trace POST in the run. These tests pin the contract the fix implements, which is
the same one agents/_shared/callbacks.py implements for the fleet:

  * secret unset  → no header, request unchanged
  * secret set    → header on the TRACE call only; the session-gated harness
                    routes are not the thing this secret unlocks
  * a 401 is named as a config error, not reported as a flaky sink
"""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
from contextlib import redirect_stderr
from unittest import mock

import harness

TRACE_URL = "http://mw:3001/api/observability/harness/trace"
RUNS_URL = "http://mw:3001/api/observability/harness/runs"


def _ok_urlopen(body: bytes = b"{}"):
    resp = mock.MagicMock()
    resp.read.return_value = body
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    return mock.Mock(return_value=cm)


def _header(req, name: str) -> str | None:
    for key, value in req.header_items():
        if key.lower() == name.lower():
            return value
    return None


class TraceAuthHeaderTests(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict("os.environ", {}, clear=False)
        self._env.start()
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness._announced_trace_auth = False

    def tearDown(self):
        self._env.stop()
        harness._announced_trace_auth = False

    def _post(self, url: str):
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener), redirect_stderr(io.StringIO()):
            harness._http("POST", url, {"agentId": "orgiq-search"})
        return opener.call_args[0][0]

    def test_no_header_when_the_secret_is_unset(self):
        req = self._post(TRACE_URL)
        self.assertIsNone(_header(req, "x-harness-auth"))

    def test_header_sent_when_the_secret_is_set(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        req = self._post(TRACE_URL)
        self.assertEqual(_header(req, "x-harness-auth"), "trace-secret")

    def test_header_name_matches_the_middleware_guard(self):
        # requireTraceAuth reads req.headers['x-harness-auth'] — if this ever
        # drifts, the harness 401s with no other symptom.
        self.assertEqual(harness._TRACE_AUTH_HEADER, "x-harness-auth")
        self.assertEqual(harness._TRACE_AUTH_ENV, "HARNESS_TRACE_SECRET")

    def test_only_the_trace_route_gets_the_header(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        req = self._post(RUNS_URL)
        self.assertIsNone(_header(req, "x-harness-auth"))

    def test_a_query_string_does_not_hide_the_trace_route(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        headers = harness._service_auth_headers(TRACE_URL + "?debug=1")
        self.assertEqual(headers, {"x-harness-auth": "trace-secret"})

    def test_a_pasted_trailing_newline_is_stripped(self):
        # `aws secretsmanager get-secret-value --output text` adds one, and a
        # newline is not a legal header value at all.
        harness.os.environ["HARNESS_TRACE_SECRET"] = " trace-secret\n"
        req = self._post(TRACE_URL)
        self.assertEqual(_header(req, "x-harness-auth"), "trace-secret")

    def test_a_blank_secret_reads_as_unset(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "   "
        self.assertEqual(harness._service_auth_headers(TRACE_URL), {})

    def test_body_and_method_are_otherwise_untouched(self):
        req = self._post(TRACE_URL)
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(json.loads(req.data.decode()), {"agentId": "orgiq-search"})


class TraceAuthDiagnosticTests(unittest.TestCase):
    def setUp(self):
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness._announced_trace_auth = True  # silence the announce line

    def tearDown(self):
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness._announced_trace_auth = False

    def test_unset_secret_says_to_export_it(self):
        note = harness.trace_auth_hint(401)
        self.assertIn("HARNESS_TRACE_SECRET is unset", note)

    def test_set_secret_says_it_does_not_match(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "wrong"
        note = harness.trace_auth_hint(401)
        self.assertIn("does not match", note)

    def test_a_401_surfaces_as_an_http_error_carrying_its_status(self):
        # The run loop branches on `e.status in (401, 403)` to print the hint
        # instead of a generic trace-sink warning.
        err = urllib.error.HTTPError(TRACE_URL, 401, "Unauthorized", hdrs=None, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(harness.HttpError) as caught:
                harness._http("POST", TRACE_URL, {})
        self.assertEqual(caught.exception.status, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
