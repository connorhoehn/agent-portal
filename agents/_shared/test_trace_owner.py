"""Every agent trace carries its verified caller as X-Ray annotations.

The middleware lists a non-admin's X-Ray traces with a filter on the
``user_id`` / ``tenant`` annotations (middleware/src/lib/trace-owner.ts), so a
trace the agents do not tag is invisible to everyone but the cross-tenant
admin. These pin:

*   the owner comes from the signed auth block, never the payload's own
    ``userId`` / ``tenant`` claims;
*   an unsigned dev run is the demo identity in the home tenant, and an
    unverified block outside dev mode tags nothing;
*   the root span and every span opened during the invocation carry the
    annotations, listed in ``aws.xray.annotations`` so X-Ray indexes them;
*   the annotation names equal the middleware's (TRACE_OWNER_ANNOTATIONS).

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_trace_owner
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import instrumentation as ins  # noqa: E402
from _shared import invoke_auth  # noqa: E402
from _shared import trace_owner as owner  # noqa: E402
from _shared.callbacks import sign_service_request  # noqa: E402

SECRET = "invoke-secret-for-tests-0123456789"
PROD = {"AGENT_INVOKE_SECRET": SECRET, "AGENT_INVOKE_SECRET_ID": "", "INSECURE_DEV_MODE": "", "APP_ENV": "production"}
DEV = {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "", "INSECURE_DEV_MODE": "true", "APP_ENV": "", "NODE_ENV": ""}
NO_SECRET_PROD = {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "", "INSECURE_DEV_MODE": "", "APP_ENV": "production"}


def signed(auth: dict, **over) -> dict:
    payload = {"input_text": "q", "auth": auth, "sessionId": "conv-1", "authNonce": invoke_auth.new_nonce(), **over}
    payload["authSig"] = sign_service_request(
        invoke_auth.METHOD, invoke_auth.TARGET, invoke_auth.canonical_for(payload),
        secret=SECRET, service_id=invoke_auth.SERVICE_ID, audience=invoke_auth.AUDIENCE,
    )
    return payload


class FakeSpan:
    def __init__(self, recording: bool = True):
        self.attributes: dict = {}
        self.recording = recording

    def is_recording(self) -> bool:
        return self.recording

    def set_attribute(self, key, value) -> None:
        self.attributes[key] = value


class OwnerFromTheSignedBlock(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict("os.environ", PROD)
        env.start()
        self.addCleanup(env.stop)
        # Signatures issued "before this process started" are refused; the
        # suite's process started moments ago.
        start = mock.patch.object(invoke_auth, "PROCESS_STARTED_AT", 0)
        start.start()
        self.addCleanup(start.stop)

    def test_a_signed_block_names_the_owner(self):
        payload = signed({"sub": "u-lead", "role": "org-leader", "tenant": "assessment"})
        self.assertEqual(owner.trace_owner(payload), ("u-lead", "assessment"))

    def test_the_payload_s_own_claims_never_tag_the_trace(self):
        payload = signed({"sub": "u-lead", "role": "member", "tenant": "orgiq"}, userId="u-admin", tenant="assessment")
        ctx = ins.TraceContext.from_request_payload(payload)
        self.assertEqual(ctx.owner, ("u-lead", "orgiq"))
        self.assertEqual(ctx.user_id, "u-admin")  # the claim stays a claim: it tags nothing

    def test_the_agent_s_own_later_read_is_not_a_replay(self):
        payload = signed({"sub": "u-lead", "role": "member", "tenant": "orgiq"})
        ins.TraceContext.from_request_payload(payload)
        self.assertIsNotNone(invoke_auth.verified_auth(payload))

    def test_an_unsigned_block_outside_dev_mode_tags_nothing(self):
        payload = {"input_text": "q", "auth": {"sub": "u-lead", "tenant": "orgiq"}, "sessionId": "c"}
        self.assertIsNone(owner.trace_owner(payload))
        with mock.patch.dict("os.environ", NO_SECRET_PROD):
            self.assertIsNone(owner.trace_owner(payload))

    def test_a_block_without_a_tenant_tags_nothing(self):
        self.assertIsNone(owner.trace_owner(signed({"sub": "u-lead", "role": "member"})))


class DevRuns(unittest.TestCase):
    def test_an_unsigned_dev_run_is_the_demo_identity_in_the_home_tenant(self):
        with mock.patch.dict("os.environ", DEV):
            self.assertEqual(
                owner.trace_owner({"input_text": "q", "auth": {"sub": "u-other", "tenant": "assessment"}}),
                ("demo-user", "orgiq"),
            )
            self.assertEqual(owner.trace_owner({"input_text": "q"}), ("demo-user", "orgiq"))
            self.assertEqual(ins.TraceContext.from_request_payload("not a dict").owner, ("demo-user", "orgiq"))


class Spans(unittest.TestCase):
    def test_owner_attributes_list_themselves_as_xray_annotations(self):
        self.assertEqual(owner.owner_attributes(("u-1", "orgiq")), {
            "user_id": "u-1", "tenant": "orgiq", "aws.xray.annotations": ["user_id", "tenant"],
        })
        self.assertEqual(owner.owner_attributes(None), {})

    def test_tag_span_never_raises_and_skips_a_non_recording_span(self):
        owner.tag_span(None, ("u", "t"))
        idle = FakeSpan(recording=False)
        owner.tag_span(idle, ("u", "t"))
        self.assertEqual(idle.attributes, {})

        class Broken:
            def set_attribute(self, *_):
                raise RuntimeError("boom")

        owner.tag_span(Broken(), ("u", "t"))

    def test_every_span_opened_during_an_invocation_is_tagged(self):
        ctx = ins.TraceContext(owner=("u-1", "orgiq"))
        token = ins.set_active_ctx(ctx)
        try:
            span = FakeSpan()
            ins.OwnerSpanProcessor().on_start(span)
        finally:
            ins.reset_active_ctx(token)
        self.assertEqual(span.attributes["user_id"], "u-1")
        self.assertEqual(span.attributes["tenant"], "orgiq")
        outside = FakeSpan()
        ins.OwnerSpanProcessor().on_start(outside)
        self.assertEqual(outside.attributes, {})

    def test_the_root_span_and_the_span_it_opens_under_carry_the_owner(self):
        """With stand-in OTel / OpenInference modules, so the test runs where
        neither is installed."""
        import contextlib
        import types

        parent = FakeSpan()
        opened: list = []

        class Tracer:
            @contextlib.contextmanager
            def start_as_current_span(self, name, attributes=None):
                span = FakeSpan()
                span.attributes.update(attributes or {})
                opened.append(span)
                yield span

        otel = types.ModuleType("opentelemetry")
        otel_trace = types.ModuleType("opentelemetry.trace")
        otel_trace.get_tracer = lambda *_a, **_k: Tracer()
        otel_trace.get_current_span = lambda: parent
        otel.trace = otel_trace
        oi = types.ModuleType("openinference")
        oi_ins = types.ModuleType("openinference.instrumentation")
        oi_ins.using_session = lambda **_k: contextlib.nullcontext()
        oi_ins.using_user = lambda **_k: contextlib.nullcontext()
        oi.instrumentation = oi_ins
        fakes = {"opentelemetry": otel, "opentelemetry.trace": otel_trace,
                 "openinference": oi, "openinference.instrumentation": oi_ins}
        with mock.patch.dict(sys.modules, fakes), mock.patch.object(ins, "_bootstrap_openinference", lambda: None):
            with ins.with_orgiq_root(ins.TraceContext(owner=("u-1", "assessment")), agent_id="a", agent_name="A"):
                pass
        (span,) = opened
        for tagged in (span, parent):
            self.assertEqual(tagged.attributes["user_id"], "u-1")
            self.assertEqual(tagged.attributes["tenant"], "assessment")
            self.assertEqual(tuple(tagged.attributes["aws.xray.annotations"]), ("user_id", "tenant"))

    def test_an_ownerless_root_span_carries_no_owner(self):
        self.assertEqual(owner.owner_attributes(ins.TraceContext().owner), {})


class SameNamesAsTheMiddleware(unittest.TestCase):
    def test_the_annotation_names_match_trace_owner_ts(self):
        ts = (Path(__file__).resolve().parents[2] / "middleware" / "src" / "lib" / "trace-owner.ts").read_text()
        match = re.search(r"TRACE_OWNER_ANNOTATIONS\s*=\s*\{\s*user:\s*'([^']+)',\s*tenant:\s*'([^']+)'", ts)
        self.assertIsNotNone(match, "TRACE_OWNER_ANNOTATIONS not found in trace-owner.ts")
        self.assertEqual((match.group(1), match.group(2)), (owner.USER_ANNOTATION, owner.TENANT_ANNOTATION))


if __name__ == "__main__":
    unittest.main()
