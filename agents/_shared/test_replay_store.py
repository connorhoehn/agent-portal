"""The shared replay store: a nonce accepted on one replica is refused on
another, the in-process bounds still apply first, and a configured store that
errors refuses the invocation.

Run:  cd agents/_shared && python -m unittest test_replay_store
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import invoke_auth as ia  # noqa: E402
from _shared import replay_store as rs  # noqa: E402

SECRET = "invoke-secret-for-tests-0123456789"


class _ConditionalFailed(Exception):
    def __init__(self):
        super().__init__("conditional")
        self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class FakeTable:
    """One DynamoDB table shared by every 'replica' that holds it."""

    def __init__(self, clock):
        self.items: dict[str, dict] = {}
        self.clock = clock
        self.calls = []
        self.fail_with: Exception | None = None

    def put_item(self, TableName, Item, ConditionExpression, ExpressionAttributeValues):
        self.calls.append({"TableName": TableName, "Item": Item, "Condition": ConditionExpression})
        if self.fail_with is not None:
            raise self.fail_with
        key = Item["nonce_hash"]["S"]
        now = int(ExpressionAttributeValues[":now"]["N"])
        old = self.items.get(key)
        if old is not None and int(old["expires_at"]["N"]) >= now:
            raise _ConditionalFailed()
        self.items[key] = Item


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def _replica(table, clock):
    return rs.LayeredReplayCache(ia.ReplayCache(), rs.DynamoReplayStore("replay", table, clock=clock))


class SharedStoreTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.table = FakeTable(self.clock)

    def test_a_nonce_used_on_one_replica_is_refused_on_another(self):
        a, b = _replica(self.table, self.clock), _replica(self.table, self.clock)
        self.assertFalse(a.seen_or_add("nonce-0000000000000001", caller="k:orgiq:u1"))
        self.assertTrue(b.seen_or_add("nonce-0000000000000001", caller="k:orgiq:u1"))
        self.assertTrue(a.seen_or_add("nonce-0000000000000001", caller="k:orgiq:u1"))

    def test_the_item_carries_a_hash_the_caller_the_run_and_the_window(self):
        _replica(self.table, self.clock).seen_or_add("nonce-0000000000000002", caller="k:orgiq:u1", run="run-1")
        item = self.table.calls[0]["Item"]
        self.assertNotIn("nonce-0000000000000002", json.dumps(item))
        self.assertEqual(item["caller"]["S"], "k:orgiq:u1")
        self.assertEqual(item["run"]["S"], "run-1")
        self.assertGreaterEqual(int(item["expires_at"]["N"]) - int(self.clock.t), ia.TTL_SEC + ia.SKEW_SEC)

    def test_an_expired_item_does_not_count(self):
        a, b = _replica(self.table, self.clock), _replica(self.table, self.clock)
        a.seen_or_add("nonce-0000000000000003")
        self.clock.t += ia.TTL_SEC + ia.SKEW_SEC + 5
        self.assertFalse(b.seen_or_add("nonce-0000000000000003"))

    def test_a_store_error_refuses_rather_than_falling_back(self):
        self.table.fail_with = RuntimeError("throttled")
        with self.assertRaises(ia.ReplayCacheFull):
            _replica(self.table, self.clock).seen_or_add("nonce-0000000000000004")

    def test_the_local_bounds_still_refuse_first(self):
        replica = rs.LayeredReplayCache(ia.ReplayCache(max_per_caller=1), rs.DynamoReplayStore("replay", self.table, clock=self.clock))
        replica.seen_or_add("nonce-0000000000000005", caller="c")
        with self.assertRaises(ia.ReplayCacheFull):
            replica.seen_or_add("nonce-0000000000000006", caller="c")
        self.assertEqual(len(self.table.calls), 1)

    def test_a_local_replay_never_reaches_the_table(self):
        replica = _replica(self.table, self.clock)
        replica.seen_or_add("nonce-0000000000000007")
        self.assertTrue(replica.seen_or_add("nonce-0000000000000007"))
        self.assertEqual(len(self.table.calls), 1)


class FromEnvTests(unittest.TestCase):
    def test_no_table_keeps_the_in_process_cache(self):
        self.assertIsNone(rs.replay_cache_from_env({}))

    def test_a_table_layers_the_cache_with_the_endpoint_and_region(self):
        seen = {}

        def factory(service, **kwargs):
            seen.update(service=service, **kwargs)
            return FakeTable(Clock())

        cache = rs.replay_cache_from_env({
            rs.TABLE_ENV: "agent-replay", rs.ENDPOINT_ENV: "http://127.0.0.1:8000", "AWS_REGION": "us-west-2",
        }, client_factory=factory)
        self.assertIsInstance(cache, rs.LayeredReplayCache)
        self.assertEqual(seen, {"service": "dynamodb", "region_name": "us-west-2", "endpoint_url": "http://127.0.0.1:8000"})

    def test_a_client_that_cannot_be_built_refuses_every_signed_invoke(self):
        def factory(*_a, **_k):
            raise RuntimeError("no credentials")

        cache = rs.replay_cache_from_env({rs.TABLE_ENV: "agent-replay"}, client_factory=factory)
        with self.assertRaises(ia.ReplayCacheFull):
            cache.seen_or_add("nonce-0000000000000008")


class VerifierTests(unittest.TestCase):
    """Through the verifier: a replay to a second replica is the least-privileged caller."""

    def setUp(self):
        self.clock = Clock(time.time())
        self.table = FakeTable(self.clock)
        self.addCleanup(ia.set_replay_cache, ia.ReplayCache())
        env = mock.patch.dict("os.environ", {ia.SECRET_ENV: SECRET}, clear=False)
        env.start()
        self.addCleanup(env.stop)

    def _payload(self):
        auth = {"sub": "u-1", "role": "member", "tenant": "orgiq"}
        payload = {"auth": auth, "sessionId": "conv-1", "prompt": "hi"}
        payload.update(ia.sign_identity(auth, "conv-1", prompt="hi", service_id=ia.SERVICE_ID))
        return payload

    def test_replica_two_refuses_what_replica_one_accepted(self):
        payload = self._payload()
        with mock.patch.object(ia, "PROCESS_STARTED_AT", 0):
            ia.set_replay_cache(_replica(self.table, self.clock))
            self.assertIsNotNone(ia.verified_auth(dict(payload)))
            ia.set_replay_cache(_replica(self.table, self.clock))
            self.assertIsNone(ia.verified_auth(dict(payload)))

    def test_a_store_outage_is_the_least_privileged_caller(self):
        self.table.fail_with = RuntimeError("unreachable")
        with mock.patch.object(ia, "PROCESS_STARTED_AT", 0):
            ia.set_replay_cache(_replica(self.table, self.clock))
            self.assertIsNone(ia.verified_auth(self._payload()))

    def test_install_from_env_swaps_the_cache(self):
        with mock.patch.object(rs, "replay_cache_from_env", return_value=_replica(self.table, self.clock)):
            self.assertTrue(ia.install_replay_store_from_env({}))
        with mock.patch.object(rs, "replay_cache_from_env", return_value=None):
            self.assertFalse(ia.install_replay_store_from_env({}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
