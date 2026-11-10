"""The supervisor trusts the caller's identity only when the middleware signed it,
and never lets the model or the payload choose a sub-agent's session.

*   The ``auth`` block picks the guardrail and the tools. It is verified with the
    service envelope (``_shared/invoke_auth.py``); a forged or unsigned block
    is the least-privileged orgiq member.
*   A sub-agent's ``runtimeSessionId`` is derived from the verified
    conversation; the routing tools no longer take a ``session_id`` argument.
*   Prompts reach the logs as a length and a hash, never as text.

Run:  cd agents/tests && python -m unittest test_supervisor_invoke_auth
"""

from __future__ import annotations

import inspect
import json
import logging
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agui_harness import SupervisorTestCase  # noqa: E402

SECRET = "invoke-secret-for-tests-0123456789"


def signed(auth: dict, conversation: str, secret: str = SECRET, **over) -> dict:
    from _shared import invoke_auth
    from _shared.callbacks import sign_service_request

    payload = {"input_text": "q", "auth": auth, "sessionId": conversation,
               "authNonce": invoke_auth.new_nonce(), **over}
    payload["authSig"] = sign_service_request(
        invoke_auth.METHOD, invoke_auth.TARGET, invoke_auth.canonical_for(payload),
        secret=secret, service_id=invoke_auth.SERVICE_ID, audience=invoke_auth.AUDIENCE,
    )
    return payload


class CanonicalForm(unittest.TestCase):
    def test_matches_the_middleware_literal(self):
        """middleware/src/lib/__tests__/agent-invoke-auth.test.ts asserts the same string."""
        from _shared.invoke_auth import canonical_body

        self.assertEqual(
            canonical_body({"tenant": "orgiq", "sub": "u-lead", "role": "org-leader", "ignored": 42}, "conv-1",
                           prompt="what is the plan", input_raw='{"mode":"x"}',
                           history=[{"role": "user", "content": "hi"}], run_id="run-1",
                           nonce="n-0123456789abcdef"),
            '{"auth":{"role":"org-leader","sub":"u-lead","tenant":"orgiq"},"conversationId":"conv-1",'
            '"historySha256":"897be8e1f0370e7f41788b5b5337627e27486af82d28479ccfbe509c847683b9",'
            '"inputSha256":"afb9161ad4b37bf3f4f0159b060c8140072dcbcf103c3d7b0eea3926028cf587",'
            '"nonce":"n-0123456789abcdef",'
            '"promptSha256":"75dbbc2af0d38560f0046d20c179a261220761a09d3733baaf7d6acf87302319",'
            '"runId":"run-1"}',
        )


class SignedAuthBlock(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        env = mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": SECRET, "AGENT_INVOKE_SECRET_ID": "",
                                             "INSECURE_DEV_MODE": "", "APP_ENV": "production"})
        env.start()
        self.addCleanup(env.stop)

    def test_a_signed_block_is_trusted(self):
        payload = signed({"sub": "u-lead", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "org-leader"))

    def test_an_unsigned_block_is_least_privilege(self):
        self.assertEqual(
            self.sup._resolve_identity({"auth": {"role": "hr-admin", "tenant": "orgiq"}}), ("orgiq", "member"),
        )

    def test_a_tampered_role_is_least_privilege(self):
        payload = signed({"sub": "u-1", "role": "member", "tenant": "orgiq"}, "conv-1")
        payload["auth"] = {**payload["auth"], "role": "hr-admin"}
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "member"))

    def test_a_replayed_block_with_a_different_prompt_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "org-leader"))
        replay = {**payload, "input_text": "something else", "prompt": "something else", "message": "something else"}
        self.assertEqual(self.sup._resolve_identity(replay), ("orgiq", "member"))

    def test_a_replay_that_changes_only_one_prompt_key_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1", prompt="q", message="q")
        self.assertEqual(self.sup._resolve_identity({**payload, "input_text": "other"}), ("orgiq", "member"))

    def test_a_replay_with_other_input_history_or_run_is_refused(self):
        base = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1",
                      input='{"mode":"x"}', history=[{"role": "user", "content": "hi"}], runId="run-1")
        self.assertEqual(self.sup._resolve_identity(base), ("orgiq", "org-leader"))
        for change in ({"input": '{"mode":"y"}'}, {"history": [{"role": "user", "content": "other"}]}, {"runId": "run-2"}):
            with self.subTest(change=change):
                self.assertEqual(self.sup._resolve_identity({**base, **change}), ("orgiq", "member"))

    def test_a_block_moved_to_another_conversation_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        payload["sessionId"] = "conv-2"
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "member"))

    def test_an_identical_request_sent_twice_is_refused_the_second_time(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        wire = json.dumps(payload)
        self.assertEqual(self.sup._resolve_identity(json.loads(wire)), ("orgiq", "org-leader"))
        self.assertEqual(self.sup._resolve_identity(json.loads(wire)), ("orgiq", "member"))

    def test_the_same_payload_read_twice_in_one_invocation_still_verifies(self):
        from _shared.invoke_auth import verified_auth

        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "org-leader"))
        self.assertEqual(verified_auth(payload)["role"], "org-leader")

    def test_a_signed_block_without_a_nonce_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1", authNonce=None)
        payload.pop("authNonce")
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "member"))

    def test_a_changed_nonce_breaks_the_signature(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        payload["authNonce"] = "another-nonce-0123456789"
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "member"))

    def test_a_block_signed_with_another_secret_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1", secret="other-secret")
        self.assertEqual(self.sup._resolve_identity(payload), ("orgiq", "member"))

    def test_the_forged_role_never_reaches_an_agent(self):
        self.use_runtime("orgiq_search")
        _, result, _ = self.invoke({"input_text": "q", "auth": {"role": "hr-admin"}})
        self.assertEqual(result["role"], "member")
        self.assertNotIn(("orgiq", "hr-admin"), self.sup._AGENTS_BY_KEY)


class NoSecretOutsideDevMode(SupervisorTestCase):
    def test_production_without_a_secret_trusts_nothing(self):
        with mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "",
                                            "INSECURE_DEV_MODE": "true", "APP_ENV": "production"}):
            self.assertEqual(
                self.sup._resolve_identity({"auth": {"role": "org-leader"}}), ("orgiq", "member"),
            )

    def test_dev_mode_without_a_secret_keeps_local_runs_working(self):
        with mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": "",
                                            "INSECURE_DEV_MODE": "true", "APP_ENV": "", "NODE_ENV": ""}):
            self.assertEqual(
                self.sup._resolve_identity({"auth": {"role": "org-leader"}}), ("orgiq", "org-leader"),
            )


class SubAgentSession(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        env = mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": SECRET, "AGENT_INVOKE_SECRET_ID": "",
                                             "INSECURE_DEV_MODE": "", "APP_ENV": "production"})
        env.start()
        self.addCleanup(env.stop)
        self.control, self.runtime = self.use_runtime("orgiq_search")

    def _session_for(self, payload) -> str | None:
        self.runtime.calls.clear()
        self.sup._resolve_identity(payload)
        self.sup.search_organization("who knows auth")
        kwargs = self.runtime.calls[-1]
        return kwargs.get("runtimeSessionId")

    def test_the_routing_tools_take_no_session_argument(self):
        for name in ("search_organization", "get_expertise_scores", "get_strategic_advice",
                     "ingest_documents", "build_graph"):
            params = inspect.signature(getattr(self.sup, name)).parameters
            self.assertNotIn("session_id", params, name)

    def test_the_session_is_derived_from_the_verified_conversation(self):
        a = self._session_for(signed({"sub": "u-1", "role": "member", "tenant": "orgiq"}, "conv-1"))
        again = self._session_for(signed({"sub": "u-1", "role": "member", "tenant": "orgiq"}, "conv-1"))
        other = self._session_for(signed({"sub": "u-1", "role": "member", "tenant": "orgiq"}, "conv-2"))
        someone = self._session_for(signed({"sub": "u-2", "role": "member", "tenant": "orgiq"}, "conv-1"))
        self.assertTrue(a and len(a) >= 33)
        self.assertEqual(a, again)
        self.assertNotEqual(a, other)
        self.assertNotEqual(a, someone)

    def test_an_unverified_caller_gets_a_fresh_session_every_call(self):
        self.assertIsNone(self._session_for({"auth": {"role": "member"}, "sessionId": "conv-1"}))


class PromptsAreNotLogged(SupervisorTestCase):
    def test_sub_agent_calls_log_a_fingerprint_not_the_prompt(self):
        self.use_runtime("orgiq_search")
        secret_question = "what is Dana's salary band"
        logging.disable(logging.NOTSET)
        with self.assertLogs(self.sup.log, level="INFO") as logs:
            self.sup.search_organization(secret_question)
        text = "\n".join(logs.output)
        self.assertNotIn("salary", text)
        self.assertIn("len=", text)
        self.assertIn("sha256=", text)


class FingerprintsAreKeyed(unittest.TestCase):
    """A log fingerprint is an HMAC under a per-deployment key, so a short
    prompt cannot be confirmed from the logs by hashing guesses."""

    def setUp(self):
        from _shared import instrumentation
        self.inst = instrumentation
        self.addCleanup(setattr, instrumentation, "_FINGERPRINT_KEY", None)
        instrumentation._FINGERPRINT_KEY = None

    def test_not_a_bare_sha256_and_stable_per_deployment(self):
        import hashlib
        with mock.patch.dict("os.environ", {"HARNESS_TRACE_SECRET": "deployment-a", "HARNESS_TRACE_SECRET_ID": ""}):
            fp = self.inst.text_fingerprint("yes")
            self.assertNotIn(hashlib.sha256(b"yes").hexdigest()[:12], fp)
            self.assertEqual(fp, self.inst.text_fingerprint("yes"))
        self.inst._FINGERPRINT_KEY = None
        with mock.patch.dict("os.environ", {"HARNESS_TRACE_SECRET": "deployment-b", "HARNESS_TRACE_SECRET_ID": ""}):
            self.assertNotEqual(fp, self.inst.text_fingerprint("yes"))

    def test_without_a_secret_a_random_key_per_process(self):
        with mock.patch.dict("os.environ", {"HARNESS_TRACE_SECRET": "", "HARNESS_TRACE_SECRET_ID": ""}):
            fp = self.inst.text_fingerprint("yes")
            self.assertEqual(fp, self.inst.text_fingerprint("yes"))
            self.assertTrue(fp.startswith("len=3 sha256="))


class RequestFields(unittest.TestCase):
    """Structured fields come from the nested `input`, never identity keys."""

    def test_nested_input_is_read_and_identity_keys_are_dropped(self):
        from _shared.invoke_auth import request_fields

        payload = {"auth": {"tenant": "orgiq"}, "mode": "top-level-ignored",
                   "input": {"mode": "story", "tenant": "assessment", "auth": {"tenant": "x"}, "authSig": "v1"}}
        self.assertEqual(request_fields(payload), {"mode": "story"})
        self.assertEqual(request_fields({"input": json.dumps({"mode": "story"})}), {"mode": "story"})
        self.assertEqual(request_fields({"input": "not json"}), {})

    def test_a_payload_without_input_uses_its_top_level_minus_identity(self):
        from _shared.invoke_auth import request_fields

        self.assertEqual(request_fields({"mode": "story", "tenant": "assessment", "auth": {}, "sessionId": "s"}),
                         {"mode": "story"})
        self.assertEqual(request_fields(None), {})


if __name__ == "__main__":
    unittest.main()
