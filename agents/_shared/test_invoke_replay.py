"""Invoke-auth replay protection: every signed invoke carries a nonce and the
verifier accepts each nonce once inside the signature window.

Run:  cd agents/_shared && python -m unittest test_invoke_replay
"""

from __future__ import annotations

import json
import time
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import invoke_auth as ia  # noqa: E402

SECRET = "invoke-secret-for-tests-0123456789"


class ReplayCacheTests(unittest.TestCase):
    def test_a_nonce_is_accepted_once_then_refused(self):
        cache = ia.ReplayCache(ttl_sec=10)
        self.assertFalse(cache.seen_or_add("n1", now=0))
        self.assertTrue(cache.seen_or_add("n1", now=5))
        self.assertFalse(cache.seen_or_add("n2", now=5))

    def test_a_nonce_expires_with_the_window(self):
        cache = ia.ReplayCache(ttl_sec=10)
        cache.seen_or_add("n1", now=0)
        self.assertFalse(cache.seen_or_add("n1", now=10.5))
        self.assertEqual(len(cache), 1)

    def test_a_full_cache_refuses_rather_than_evicting_a_live_nonce(self):
        cache = ia.ReplayCache(ttl_sec=100, max_entries=3)
        for i in range(3):
            self.assertFalse(cache.seen_or_add(f"n{i}", now=i, caller=f"c{i}"))
        with self.assertRaises(ia.ReplayCacheFull):
            cache.seen_or_add("n3", now=3, caller="c3")
        self.assertEqual(len(cache), 3)
        # The oldest is still remembered: replaying it is still caught.
        self.assertTrue(cache.seen_or_add("n0", now=4))
        # Once entries expire, new nonces are accepted again.
        self.assertFalse(cache.seen_or_add("n3", now=100.5, caller="c3"))

    def test_one_caller_cannot_fill_the_cache(self):
        cache = ia.ReplayCache(ttl_sec=100, max_entries=100, max_per_caller=2)
        cache.seen_or_add("a1", now=0, caller="flood")
        cache.seen_or_add("a2", now=0, caller="flood")
        with self.assertRaises(ia.ReplayCacheFull):
            cache.seen_or_add("a3", now=0, caller="flood")
        self.assertFalse(cache.seen_or_add("b1", now=0, caller="someone-else"))
        # The per-caller count falls as that caller's entries expire.
        self.assertFalse(cache.seen_or_add("a3", now=101, caller="flood"))

    def test_the_default_window_covers_the_signature_ttl_and_skew(self):
        cache = ia.ReplayCache()
        cache.seen_or_add("n", now=0)
        self.assertTrue(cache.seen_or_add("n", now=ia.TTL_SEC + ia.SKEW_SEC - 1))


class DevModeVeto(unittest.TestCase):
    def test_any_spelling_of_production_vetoes_the_flag(self):
        for k in ("NODE_ENV", "APP_ENV"):
            for v in ("production", "Production", " PRODUCTION ", "prod", "Prod"):
                self.assertFalse(ia.insecure_dev_mode({"INSECURE_DEV_MODE": "true", k: v}), (k, v))
        self.assertTrue(ia.insecure_dev_mode({"INSECURE_DEV_MODE": "true", "NODE_ENV": "development"}))


class SignAndVerify(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": SECRET, "AGENT_INVOKE_SECRET_ID": "",
                                             "INSECURE_DEV_MODE": "", "APP_ENV": "production"})
        env.start()
        self.addCleanup(env.stop)
        ia.set_replay_cache(ia.ReplayCache())

    def _handed(self, prompt="q"):
        auth = {"tenant": "assessment", "sub": "u-1"}
        fields = ia.sign_identity(auth, "conv-1", prompt=prompt)
        return {"input_text": prompt, "auth": auth, "sessionId": "conv-1", **fields}

    def test_the_supervisor_signs_a_fresh_nonce_each_time(self):
        a, b = self._handed(), self._handed()
        self.assertGreaterEqual(len(a["authNonce"]), ia.MIN_NONCE_LEN)
        self.assertNotEqual(a["authNonce"], b["authNonce"])
        self.assertNotEqual(a["authSig"], b["authSig"])

    def test_a_handed_down_payload_verifies_once(self):
        wire = json.dumps(self._handed())
        self.assertIsNotNone(ia.verified_auth(json.loads(wire)))
        self.assertIsNone(ia.verified_auth(json.loads(wire)))

    def test_two_requests_with_the_same_prompt_both_verify(self):
        self.assertIsNotNone(ia.verified_auth(self._handed()))
        self.assertIsNotNone(ia.verified_auth(self._handed()))

    def test_a_shared_store_can_replace_the_cache(self):
        calls = []

        class Shared:
            def seen_or_add(self, nonce, caller=""):
                calls.append((nonce, caller))
                return False

        ia.set_replay_cache(Shared())
        payload = self._handed()
        self.assertIsNotNone(ia.verified_auth(payload))
        self.assertEqual(calls, [(payload["authNonce"], "orgiq-supervisor:assessment:u-1")])

    def test_a_full_cache_refuses_the_invocation(self):
        ia.set_replay_cache(ia.ReplayCache(max_entries=1))
        self.assertIsNotNone(ia.verified_auth(self._handed()))
        with self.assertLogs(ia.log, level="ERROR") as logs:
            self.assertIsNone(ia.verified_auth(self._handed()))
        self.assertIn("unexpired nonces", "\n".join(logs.output))

    def test_a_signature_issued_before_the_process_started_is_refused(self):
        # A restart empties the cache, so anything signed before the process
        # started (less the grace) may already have been used.
        with mock.patch.object(ia, "PROCESS_STARTED_AT", time.time() + 120):
            self.assertIsNone(ia.verified_auth(self._handed()))
        # Inside the grace (a cold start), it verifies.
        with mock.patch.object(ia, "PROCESS_STARTED_AT", time.time() + 5):
            self.assertIsNotNone(ia.verified_auth(self._handed()))

    def test_the_start_grace_is_bounded(self):
        self.assertEqual(ia.start_grace_sec({}), ia.DEFAULT_START_GRACE_SEC)
        self.assertEqual(ia.start_grace_sec({"AGENT_INVOKE_START_GRACE_SEC": "5"}), 5)
        self.assertEqual(ia.start_grace_sec({"AGENT_INVOKE_START_GRACE_SEC": "-3"}), 0)
        self.assertEqual(ia.start_grace_sec({"AGENT_INVOKE_START_GRACE_SEC": "99999"}), ia.TTL_SEC)
        self.assertEqual(ia.start_grace_sec({"AGENT_INVOKE_START_GRACE_SEC": "soon"}), ia.DEFAULT_START_GRACE_SEC)
        self.assertTrue(ia.issued_before_start("garbage", started_at=0, grace=0))
        self.assertTrue(ia.issued_before_start("v1.s.99.mac", started_at=100, grace=0))
        self.assertFalse(ia.issued_before_start("v1.s.99.mac", started_at=100, grace=1))

    def test_no_secret_signs_nothing(self):
        with mock.patch.dict("os.environ", {"AGENT_INVOKE_SECRET": ""}):
            self.assertEqual(ia.sign_identity({"tenant": "orgiq"}, "c"), {})

    def test_the_nonce_is_an_identity_key(self):
        self.assertIn("authNonce", ia.IDENTITY_KEYS)
        self.assertNotIn("authNonce", ia.request_fields({"authNonce": "x", "mode": "m"}))


if __name__ == "__main__":
    unittest.main()
