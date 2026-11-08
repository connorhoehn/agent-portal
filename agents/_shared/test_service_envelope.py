"""Signed service envelope — the agent half of lane C4. stdlib unittest, no network.

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_service_envelope

1. CROSS-LANGUAGE CONTRACT. The fixed vectors in
   middleware/src/lib/__tests__/fixtures/service-envelope-vectors.json were
   signed by service-runtime's TS ``signServiceRequest`` (signedBy=ts) and by
   ``callbacks.sign_service_request`` (signedBy=py). Every row must verify here
   and re-sign byte for byte; the middleware suite
   ``service-envelope-contract.test.ts`` does the same from the TS side.
2. VERIFIER CONTRACT (the Python mirror): tampered body / method / target /
   audience refused, stale and future timestamps refused, unknown service
   refused.
3. HEADER CONTRACT: nothing when the secret is unset; envelope + nonce (+ the
   static header while the transition flag allows) when it is set; every
   callback signs the exact bytes it sends.
"""

from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import callbacks as cb  # noqa: E402
from _shared import instrumentation as instr  # noqa: E402

VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "middleware/src/lib/__tests__/fixtures/service-envelope-vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["vectors"]


def _verify(v: dict, **over) -> tuple[bool, str]:
    args = dict(
        method=v["method"], target=v["target"], body=v["body"],
        secret=v["secret"], allowed_services=[v["serviceId"]],
        audience=v["audience"], now=v["nowSec"],
    )
    args.update(over)
    return cb.verify_service_request(
        over.get("header", v["header"]),
        args.pop("method"), args.pop("target"), args.pop("body"),
        **{k: a for k, a in args.items() if k != "header"},
    )


class CrossLanguageVectorTests(unittest.TestCase):
    def test_both_signers_are_represented(self):
        self.assertEqual({v["signedBy"] for v in VECTORS}, {"ts", "py"})

    def test_every_vector_verifies(self):
        for v in VECTORS:
            with self.subTest(v["name"]):
                self.assertEqual(_verify(v), (True, v["serviceId"]))

    def test_every_vector_re_signs_byte_for_byte(self):
        for v in VECTORS:
            with self.subTest(v["name"]):
                self.assertEqual(
                    cb.sign_service_request(
                        v["method"], v["target"], v["body"], secret=v["secret"],
                        service_id=v["serviceId"], audience=v["audience"], now=v["nowSec"],
                    ),
                    v["header"],
                )


class VerifierContractTests(unittest.TestCase):
    V = next(v for v in VECTORS if v["method"] == "POST" and v["signedBy"] == "ts")

    def test_tampered_fields_are_refused(self):
        v = self.V
        for field, value in [
            ("body", v["body"] + " "),
            ("method", "PUT"),
            ("target", v["target"] + "?x=1"),
            ("audience", v["audience"].replace("#", "#x")),
            ("secret", "wrong"),
        ]:
            with self.subTest(field):
                self.assertEqual(_verify(v, **{field: value}), (False, "bad-signature"))

    def test_expired_and_future_timestamps_are_refused(self):
        v = self.V
        self.assertEqual(_verify(v, now=v["nowSec"] + 61), (False, "stale"))
        self.assertTrue(_verify(v, now=v["nowSec"] + 60)[0])
        self.assertEqual(_verify(v, now=v["nowSec"] - 11), (False, "future-skew"))

    def test_unknown_service_and_malformed_headers_are_refused(self):
        v = self.V
        self.assertEqual(_verify(v, allowed_services=["someone-else"]), (False, "unknown-service"))
        for bad in ["", "v1.a.b", "v2" + v["header"][2:], v["header"] + "x"]:
            with self.subTest(bad):
                self.assertFalse(_verify(v, header=bad)[0])


class _EnvCase(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in
                       [c.env_var for c in cb.ALL_CALLBACKS] + [cb.LEGACY_HEADERS_ENV]}
        cb.reset_announcements()

    def tearDown(self):
        for k, val in self._saved.items():
            os.environ.pop(k, None)
            if val is not None:
                os.environ[k] = val
        cb.reset_announcements()


class RequestHeaderTests(_EnvCase):
    URL = "http://mw:3001/api/observability/harness/trace?x=1"

    def test_nothing_when_the_secret_is_unset(self):
        self.assertEqual(cb.request_headers(cb.HARNESS_TRACE, "POST", self.URL, b"{}"), {})

    def test_envelope_nonce_and_legacy_header_when_accepted(self):
        os.environ["HARNESS_TRACE_SECRET"] = " s3cret\n"
        os.environ[cb.LEGACY_HEADERS_ENV] = "Accept"
        h = cb.request_headers(cb.HARNESS_TRACE, "POST", self.URL, b'{"a":1}')
        self.assertEqual(h["x-harness-auth"], "s3cret")
        nonce = h[cb.SERVICE_NONCE_HEADER]
        self.assertRegex(nonce, r"^[A-Za-z0-9_-]{16,128}$")
        ok, who = cb.verify_service_request(
            h[cb.SERVICE_AUTH_HEADER], "POST", "/api/observability/harness/trace?x=1", '{"a":1}',
            secret="s3cret", allowed_services=["orgiq-agent"],
            audience=f"orgiq-middleware/harness-trace#{nonce}",
        )
        self.assertEqual((ok, who), (True, "orgiq-agent"))

    def test_default_drops_the_static_header(self):
        os.environ["HARNESS_TRACE_SECRET"] = "s3cret"
        h = cb.request_headers(cb.HARNESS_TRACE, "POST", self.URL, b"{}")
        self.assertNotIn("x-harness-auth", h)
        self.assertIn(cb.SERVICE_AUTH_HEADER, h)

    def test_allow_also_sends_it_and_refuse_does_not(self):
        os.environ["HARNESS_TRACE_SECRET"] = "s3cret"
        for value, sent in (("allow", True), ("refuse", False), ("", False)):
            os.environ[cb.LEGACY_HEADERS_ENV] = value
            h = cb.request_headers(cb.HARNESS_TRACE, "POST", self.URL, b"{}")
            self.assertEqual("x-harness-auth" in h, sent, value)

    def test_nonces_are_fresh_per_request(self):
        os.environ["HARNESS_TRACE_SECRET"] = "s3cret"
        seen = {cb.request_headers(cb.HARNESS_TRACE, "GET", self.URL)[cb.SERVICE_NONCE_HEADER]
                for _ in range(20)}
        self.assertEqual(len(seen), 20)

    def test_audiences_match_the_middleware_specs(self):
        # Spelled out: a rename on either side 401s the fleet once legacy is refused.
        self.assertEqual(cb.APPROVALS_REQUEST.audience, "orgiq-middleware/approvals")
        self.assertEqual(cb.HARNESS_TRACE.audience, "orgiq-middleware/harness-trace")
        self.assertEqual(cb.ASSESSMENT_RUN_COMPLETE.audience,
                         "orgiq-middleware/assessment-run-complete")


def _ok_urlopen(body: bytes = b"{}"):
    resp = mock.MagicMock()
    resp.read.return_value = body
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    return mock.Mock(return_value=cm)


def _headers(req) -> dict:
    return {k.lower(): v for k, v in req.header_items()}


class CallbacksSignTheBytesTheySendTests(_EnvCase):
    def _assert_signed(self, req, secret: str, audience: str):
        h = _headers(req)
        target = req.selector
        ok, _ = cb.verify_service_request(
            h["x-service-auth"], req.get_method(), target, req.data.decode("utf-8"),
            secret=secret, allowed_services=["orgiq-agent"],
            audience=f"{audience}#{h['x-service-nonce']}",
        )
        self.assertTrue(ok)

    def test_trace_post(self):
        os.environ["HARNESS_TRACE_SECRET"] = "trace-secret"
        opener = _ok_urlopen()
        with mock.patch("urllib.request.urlopen", opener), redirect_stdout(io.StringIO()):
            instr.post_trace({"agentId": "orgiq-search", "prompt": "café"}, middleware_url="http://mw")
        self._assert_signed(opener.call_args[0][0], "trace-secret", "orgiq-middleware/harness-trace")

    def test_run_complete_post(self):
        os.environ["ASSESSMENT_RUN_COMPLETE_SECRET"] = "run-secret"
        opener = _ok_urlopen(b'{"id":"run-1"}')
        with mock.patch("urllib.request.urlopen", opener):
            cb.post_run_complete("run-1", status="failed", error="boom ✗", middleware_url="http://mw")
        self._assert_signed(opener.call_args[0][0], "run-secret",
                            "orgiq-middleware/assessment-run-complete")

    def test_unset_secret_sends_no_auth_header_at_all(self):
        opener = _ok_urlopen(b'{"id":"run-1"}')
        with mock.patch("urllib.request.urlopen", opener):
            cb.post_run_complete("run-1", status="completed", middleware_url="http://mw")
        h = _headers(opener.call_args[0][0])
        for name in ("x-service-auth", "x-service-nonce", "x-assessment-run-auth"):
            self.assertNotIn(name, h)


if __name__ == "__main__":
    unittest.main(verbosity=2)
