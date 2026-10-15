"""Service auth for the harness runner — stdlib unittest, no network.

Run:  cd infra/scripts && python3 -m unittest test_harness_auth

TWO CREDENTIALS, TWO SCOPES.

`POST /api/observability/harness/trace` is a sessionless machine callback shared
with the agent fleet: the middleware's `requireTraceAuth` is open while
HARNESS_TRACE_SECRET is unset and does a constant-time compare of
`x-harness-auth` once it is set. This runner used to send no header at all, so
setting the secret would have 401'd every trace POST in the run.

Everything ELSE the runner calls — prompt-versions, harness runs, results, the
final PATCH, promote — is session-gated (tenant + Cedar) and the runner carries
no cookie. It reached those only through the middleware's dev demo-user
fallback, which is off wherever Cognito is configured, so the runner worked on a
laptop and 401'd wholesale in the deployment it exists for. HARNESS_RUNNER_SECRET
(`x-harness-runner-auth`) is the runner's own identity for those; the middleware
half is `serviceAuthOr(HARNESS_RUNNER_SERVICE_AUTH, ...)`, which never opens on
an unset secret.

What these tests pin, for both:

  * secret unset  → no header, request unchanged
  * secret set    → the trace credential goes on the TRACE call only, the
                    runner credential on every middleware call
  * a 401 is named as a config error — and names WHICH credential — instead of
    being reported as a flaky sink or a lapsed login
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
        harness.os.environ.pop("HARNESS_RUNNER_SECRET", None)
        harness._announced_trace_auth = False
        harness._announced_runner_auth = False

    def tearDown(self):
        self._env.stop()
        harness._announced_trace_auth = False
        harness._announced_runner_auth = False

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

    def test_the_trace_post_is_signed_over_its_exact_bytes(self):
        # Lane C4: the same envelope the agents send (agents/_shared/callbacks.py).
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        req = self._post(TRACE_URL)
        harness._signed_trace_headers  # noqa: B018 - imported the signer
        from _shared import callbacks  # noqa: PLC0415 - on sys.path via harness
        nonce = _header(req, "x-service-nonce")
        ok, _ = callbacks.verify_service_request(
            _header(req, "x-service-auth"), "POST", "/api/observability/harness/trace",
            req.data.decode("utf-8"), secret="trace-secret", allowed_services=["orgiq-agent"],
            audience=f"orgiq-middleware/harness-trace#{nonce}",
        )
        self.assertTrue(ok)
        self.assertEqual(_header(req, "x-harness-auth"), "trace-secret")  # transition: both

    def test_refuse_mode_drops_the_static_trace_header(self):
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        harness.os.environ["SERVICE_AUTH_LEGACY_HEADERS"] = "refuse"
        req = self._post(TRACE_URL)
        self.assertIsNone(_header(req, "x-harness-auth"))
        self.assertIsNotNone(_header(req, "x-service-auth"))

    def test_body_and_method_are_otherwise_untouched(self):
        req = self._post(TRACE_URL)
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(json.loads(req.data.decode()), {"agentId": "orgiq-search"})


class RunnerAuthHeaderTests(unittest.TestCase):
    """The control-plane credential — every middleware call, not just one."""

    def setUp(self):
        self._env = mock.patch.dict("os.environ", {}, clear=False)
        self._env.start()
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness.os.environ.pop("HARNESS_RUNNER_SECRET", None)
        harness._announced_trace_auth = False
        harness._announced_runner_auth = False

    def tearDown(self):
        self._env.stop()
        harness._announced_trace_auth = False
        harness._announced_runner_auth = False

    def _post(self, url: str):
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener), redirect_stderr(io.StringIO()):
            harness._http("POST", url, {"label": "nightly"})
        return opener.call_args[0][0]

    def test_no_header_when_the_secret_is_unset(self):
        # The middleware guard is closed-but-falls-through when unconfigured,
        # so sending nothing is exactly right: the request is what it was.
        self.assertIsNone(_header(self._post(RUNS_URL), "x-harness-runner-auth"))

    def test_header_on_a_control_plane_call_when_the_secret_is_set(self):
        harness.os.environ["HARNESS_RUNNER_SECRET"] = "runner-secret"
        self.assertEqual(
            _header(self._post(RUNS_URL), "x-harness-runner-auth"), "runner-secret"
        )

    def test_header_name_matches_the_middleware_guard(self):
        # serviceAuthOr reads req.headers['x-harness-runner-auth']; drift here
        # 401s the whole run with no other symptom.
        self.assertEqual(harness._RUNNER_AUTH_HEADER, "x-harness-runner-auth")
        self.assertEqual(harness._RUNNER_AUTH_ENV, "HARNESS_RUNNER_SECRET")

    def test_the_trace_call_carries_BOTH_credentials(self):
        # /trace is gated by the trace secret, but it is still reached through
        # the same runner. Sending only one of the two is how the previous fix
        # left the run half-authenticated.
        harness.os.environ["HARNESS_RUNNER_SECRET"] = "runner-secret"
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        req = self._post(TRACE_URL)
        self.assertEqual(_header(req, "x-harness-runner-auth"), "runner-secret")
        self.assertEqual(_header(req, "x-harness-auth"), "trace-secret")

    def test_the_trace_secret_is_never_sent_as_the_runner_credential(self):
        # Two scopes: the trace secret is deployed to nine agent runtimes and
        # must not double as write access to the harness control plane.
        harness.os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        self.assertEqual(harness._service_auth_headers(RUNS_URL), {})

    def test_a_pasted_trailing_newline_is_stripped(self):
        harness.os.environ["HARNESS_RUNNER_SECRET"] = " runner-secret\n"
        self.assertEqual(
            _header(self._post(RUNS_URL), "x-harness-runner-auth"), "runner-secret"
        )

    def test_a_blank_secret_reads_as_unset(self):
        harness.os.environ["HARNESS_RUNNER_SECRET"] = "   "
        self.assertEqual(harness._service_auth_headers(RUNS_URL), {})

    def test_a_query_string_does_not_hide_a_control_plane_route(self):
        harness.os.environ["HARNESS_RUNNER_SECRET"] = "runner-secret"
        self.assertEqual(
            harness._service_auth_headers(RUNS_URL + "?limit=5"),
            {"x-harness-runner-auth": "runner-secret"},
        )


class RunnerAuthDiagnosticTests(unittest.TestCase):
    """A 401 has to name the fix, not the symptom."""

    def setUp(self):
        harness.os.environ.pop("HARNESS_RUNNER_SECRET", None)
        harness._announced_runner_auth = True  # silence the announce line

    def tearDown(self):
        harness.os.environ.pop("HARNESS_RUNNER_SECRET", None)
        harness._announced_runner_auth = False

    def test_unset_secret_says_to_export_it_and_why_it_used_to_work(self):
        note = harness.runner_auth_hint(401)
        self.assertIn("HARNESS_RUNNER_SECRET is unset", note)
        self.assertIn("demo-user", note)

    def test_set_secret_says_it_may_not_match_or_may_not_be_wired(self):
        harness.os.environ["HARNESS_RUNNER_SECRET"] = "wrong"
        note = harness.runner_auth_hint(401)
        self.assertIn("does not match", note)
        self.assertIn("no HARNESS_RUNNER_SECRET wired", note)

    def test_the_hint_dispatches_on_the_url(self):
        # A 401 on /trace is a different missing secret from a 401 on /runs;
        # naming the wrong one sends the operator to the wrong vault entry.
        self.assertIn("HARNESS_TRACE_SECRET", harness.auth_hint(TRACE_URL, 401))
        self.assertIn("HARNESS_RUNNER_SECRET", harness.auth_hint(RUNS_URL, 401))

    def test_a_401_carries_the_hint_in_the_error_TEXT(self):
        # Most call sites only `print(f"...: {e}")`, so a hint that lives on an
        # attribute nobody reads is a hint nobody sees.
        err = urllib.error.HTTPError(RUNS_URL, 401, "Unauthorized", hdrs=None, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(harness.HttpError) as caught:
                harness._http("POST", RUNS_URL, {})
        self.assertIn("HARNESS_RUNNER_SECRET", str(caught.exception))
        self.assertEqual(caught.exception.status, 401)

    def test_a_non_auth_error_carries_no_hint(self):
        err = urllib.error.HTTPError(RUNS_URL, 500, "boom", hdrs=None, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(harness.HttpError) as caught:
                harness._http("POST", RUNS_URL, {})
        self.assertEqual(caught.exception.hint, "")


class TraceAuthDiagnosticTests(unittest.TestCase):
    def setUp(self):
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness.os.environ.pop("HARNESS_RUNNER_SECRET", None)
        harness._announced_trace_auth = True  # silence the announce line
        harness._announced_runner_auth = True

    def tearDown(self):
        harness.os.environ.pop("HARNESS_TRACE_SECRET", None)
        harness._announced_trace_auth = False
        harness._announced_runner_auth = False

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
