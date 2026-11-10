"""A replay store shared by every replica of one agent runtime.

``invoke_auth.ReplayCache`` remembers accepted nonces in the process. A runtime
that serves one endpoint from several replicas would let a captured signed
invoke run once per replica inside its window. When a table is configured the
cache becomes two layers:

1.  the in-process ``ReplayCache`` first: its per-caller, per-run and overall
    bounds still refuse rather than evict, and a replay to the same replica
    never leaves the process;
2.  then a conditional put into a DynamoDB-compatible table (DynamoDB itself,
    or the project's local DynamoDB-compatible store through an endpoint):
    the item is keyed by a hash of the nonce, carries the caller key and the
    run, and expires with the signature window (``expires_at``, the table's
    TTL attribute). A put that finds a live item means the nonce was used on
    another replica: a replay.

Fail closed: when the table is configured and the put errors for any reason
other than "already there" (throttled, unreachable, missing table, no
permission), the invocation is refused (``ReplayStoreUnavailable``, a
``ReplayCacheFull``, which the verifier already treats as a refusal). Nothing
falls back to the process alone once a store is configured.

Configuration (read by ``replay_cache_from_env``):

    AGENT_INVOKE_REPLAY_TABLE               the table name; unset keeps the
                                            in-process cache alone
    AGENT_INVOKE_REPLAY_DYNAMODB_ENDPOINT   optional endpoint for a local
                                            DynamoDB-compatible store
    AWS_REGION                              the table's region

The table needs a string partition key ``nonce_hash`` and TTL on ``expires_at``.

Bounded: the client is built with the middleware's limits (2 s to connect,
5 s to read, at most two attempts), so a stalled or unreachable table refuses
the invoke within that bound instead of holding it open on the SDK's default
60 s reads and retries.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time

try:  # package import (agents._shared) or flat import
    from .invoke_auth import TTL_SEC, SKEW_SEC, ReplayCache, ReplayCacheFull
except ImportError:  # pragma: no cover — flat layout
    from invoke_auth import TTL_SEC, SKEW_SEC, ReplayCache, ReplayCacheFull

log = logging.getLogger(__name__)

TABLE_ENV = "AGENT_INVOKE_REPLAY_TABLE"
ENDPOINT_ENV = "AGENT_INVOKE_REPLAY_DYNAMODB_ENDPOINT"

#: The client's limits; the same as the middleware's replay client
#: (middleware/src/lib/service-nonce-store.ts): 2 s connect, 5 s read.
CONNECT_TIMEOUT_SEC = 2.0
READ_TIMEOUT_SEC = 5.0
#: Total attempts per put, the first included.
MAX_ATTEMPTS = 2


def client_config():
    """The botocore ``Config`` the replay client is built with."""
    from botocore.config import Config  # noqa: PLC0415 — only when a table is configured

    return Config(
        connect_timeout=CONNECT_TIMEOUT_SEC,
        read_timeout=READ_TIMEOUT_SEC,
        retries={"total_max_attempts": MAX_ATTEMPTS, "mode": "standard"},
    )


class ReplayStoreUnavailable(ReplayCacheFull):
    """The configured shared store could not record the nonce; refused."""


def _nonce_hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode("utf-8", errors="surrogatepass")).hexdigest()


def _is_conditional_failure(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    code = ((response or {}).get("Error") or {}).get("Code") if isinstance(response, dict) else None
    return code == "ConditionalCheckFailedException"


class DynamoReplayStore:
    """The shared layer: one conditional put per accepted nonce."""

    def __init__(self, table: str, client, ttl_sec: float = TTL_SEC + SKEW_SEC, clock=time.time):
        self._table = table
        self._client = client
        self._ttl = ttl_sec
        self._clock = clock

    def seen_or_add(self, nonce: str, now: float | None = None, caller: str = "", run: str = "") -> bool:
        # Wall clock, not monotonic: every replica compares against the same expiry.
        t = self._clock()
        item = {
            "nonce_hash": {"S": _nonce_hash(nonce)},
            "caller": {"S": caller[:256]},
            "expires_at": {"N": str(int(t + self._ttl) + 1)},
        }
        if run:
            item["run"] = {"S": run[:256]}
        try:
            self._client.put_item(
                TableName=self._table,
                Item=item,
                # TTL deletion is lazy: an item past its expiry no longer counts.
                ConditionExpression="attribute_not_exists(nonce_hash) OR expires_at < :now",
                ExpressionAttributeValues={":now": {"N": str(int(t))}},
            )
        except Exception as exc:  # noqa: BLE001 — every failure but "already there" refuses
            if _is_conditional_failure(exc):
                return True
            raise ReplayStoreUnavailable(f"the shared replay store refused the write ({type(exc).__name__})") from exc
        return False


class LayeredReplayCache:
    """The in-process cache, then the shared store. Same interface as ``ReplayCache``."""

    def __init__(self, local, shared):
        self.local = local
        self.shared = shared

    def seen_or_add(self, nonce: str, now: float | None = None, caller: str = "", run: str = "") -> bool:
        extra = {"run": run} if run else {}
        if self.local.seen_or_add(nonce, now=now, caller=caller, **extra):
            return True
        return self.shared.seen_or_add(nonce, caller=caller, **extra)

    def __len__(self) -> int:
        return len(self.local)


class _UnavailableStore:
    """A configured store whose client could not be built: every write refuses."""

    def __init__(self, why: str):
        self._why = why

    def seen_or_add(self, nonce: str, now: float | None = None, caller: str = "", run: str = "") -> bool:
        raise ReplayStoreUnavailable(self._why)


def replay_cache_from_env(env=None, client_factory=None):
    """The replay cache this process should use: layered over the configured
    table, or ``None`` when none is configured (keep the in-process cache)."""
    env = os.environ if env is None else env
    table = (env.get(TABLE_ENV) or "").strip()
    if not table:
        return None
    endpoint = (env.get(ENDPOINT_ENV) or "").strip() or None
    region = (env.get("AWS_REGION") or "").strip() or "us-east-1"
    try:
        if client_factory is None:
            import boto3  # noqa: PLC0415 — only when a table is configured

            client_factory = boto3.client
        client = client_factory("dynamodb", region_name=region, endpoint_url=endpoint, config=client_config())
        shared = DynamoReplayStore(table, client)
    except Exception as exc:  # noqa: BLE001
        log.error("invoke-auth: the replay table %s is configured but its client failed (%s); signed invokes are refused", table, type(exc).__name__)
        shared = _UnavailableStore(f"the replay store client could not be built ({type(exc).__name__})")
    else:
        log.info("invoke-auth: replay cache shared through table %s", table)
    return LayeredReplayCache(ReplayCache(), shared)
