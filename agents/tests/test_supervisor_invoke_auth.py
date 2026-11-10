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

    sig = sign_service_request(
        invoke_auth.METHOD, invoke_auth.TARGET, invoke_auth.canonical_body(auth, conversation),
        secret=secret, service_id=invoke_auth.SERVICE_ID, audience=invoke_auth.AUDIENCE,
    )
    return {"input_text": "q", "auth": auth, "sessionId": conversation, "authSig": sig, **over}


class CanonicalForm(unittest.TestCase):
    def test_matches_the_middleware_literal(self):
        """middleware/src/lib/__tests__/agent-invoke-auth.test.ts asserts the same string."""
        from _shared.invoke_auth import canonical_body

        self.assertEqual(
            canonical_body({"tenant": "orgiq", "sub": "u-lead", "role": "org-leader", "ignored": 42}, "conv-1"),
            '{"auth":{"role":"org-leader","sub":"u-lead","tenant":"orgiq"},"conversationId":"conv-1"}',
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

    def test_a_block_moved_to_another_conversation_is_refused(self):
        payload = signed({"sub": "u-1", "role": "org-leader", "tenant": "orgiq"}, "conv-1")
        payload["sessionId"] = "conv-2"
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
