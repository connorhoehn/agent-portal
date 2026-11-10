"""Signed caller identity on an agent invoke (middleware → supervisor).

The middleware puts the signed-in caller in the invoke payload's ``auth`` block
(``{sub, role, tenant, actor?}``) and the supervisor picks its guardrail and
tools from it. The block used to be trusted as sent, so anyone able to call
``InvokeAgentRuntime`` directly could claim any role. Now the middleware signs
it with the existing service envelope (``service-http-v1``, the same HMAC the
agents' callbacks use — callbacks.py) and the supervisor verifies it here:

    payload["auth"]      the identity
    payload["sessionId"] the conversation id the identity is bound to
    payload["authSig"]   v1.orgiq-middleware.<ts>.<mac> over both

The signature also binds what is asked, so a captured block cannot be replayed
with another prompt inside its window: the canonical body is
``{"auth": {...string fields...}, "conversationId": ..., "historySha256": ...,
"inputSha256": ..., "nonce": ..., "promptSha256": ..., "runId": ...}`` with
sorted keys and no spaces, built identically by
``middleware/src/lib/agent-invoke-auth.ts``.

Every signed invoke carries a fresh random ``authNonce`` (bound into the
signature), and the verifier remembers each nonce it accepted until the
signature window has passed (``ReplayCache``): an identical request sent a
second time is refused. The cache never drops a nonce whose signature could
still verify: when it is full (overall, or for one caller) new signed
invocations are refused until entries expire, instead of evicting. Because
the cache starts empty, a fresh process also refuses any signature issued
before it started (less ``start_grace_sec()``: the clock skew plus the cold
start a first invoke waits through), so a restart does not reopen the window
for requests captured before it. The cache is in-process, which matches an
AgentCore runtime session (one process serves a session). A runtime that runs several
replicas behind one endpoint needs a shared store for the cache (a DynamoDB
table with a conditional put on the nonce and a TTL attribute, or Redis
``SET NX EX``); ``set_replay_cache`` takes any object with the same
``seen_or_add`` method.
The prompt is the one the agent will read (``input_text``, ``prompt`` and
``message`` must agree), the input is the ``input`` JSON text as sent, the
history is its ``[role, content]`` pairs, and the run id is ``runId``. The secret is
``AGENT_INVOKE_SECRET`` (``_ID`` names it in Secrets Manager on a deployed
runtime, secret_resolver.py).

Without a secret the block is trusted only under ``INSECURE_DEV_MODE=true`` and
outside production (local runs keep working); otherwise an unverified block
counts as no block — the least-privileged caller.

Every agent that reads the caller's tenant, role or sub reads it here and only
here (the supervisor, the read agents' retrieval tenant in kb_resolver, the
assessment agents' tenant floor in tenant_guard), never from the payload's top
level or the caller's structured ``input`` (``request_fields``). The
supervisor re-signs its verified caller for the sub-agents it invokes, as
``orgiq-supervisor``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

try:  # package import (agents._shared) or flat import (image: /app/_shared on sys.path)
    from .callbacks import sign_service_request, verify_service_request
    from .secret_resolver import SecretResolutionError, resolve_secret
except ImportError:  # pragma: no cover — flat layout
    from callbacks import sign_service_request, verify_service_request
    from secret_resolver import SecretResolutionError, resolve_secret

log = logging.getLogger(__name__)

SECRET_ENV = "AGENT_INVOKE_SECRET"
AUDIENCE = "orgiq-agent/invoke-auth"
SERVICE_ID = "orgiq-middleware"
#: The supervisor re-signs the verified caller for the sub-agents it invokes.
SUPERVISOR_SERVICE_ID = "orgiq-supervisor"
ALLOWED_SERVICES = (SERVICE_ID, SUPERVISOR_SERVICE_ID)
METHOD = "POST"
TARGET = "/invocations"
#: A streamed run can sit in the runtime's queue before the handler reads it.
TTL_SEC = 300


@dataclass(frozen=True)
class InvokeIdentity:
    auth: dict
    conversation_id: str
    #: True when the signature checked out; False for the dev-mode trust path.
    signed: bool


#: The verifier's future-skew tolerance (callbacks.verify_service_request).
SKEW_SEC = 10
#: Nonce length bounds the verifier accepts (the signers send 24 url-safe chars).
MIN_NONCE_LEN = 16
MAX_NONCE_LEN = 128
#: How long before this process started a signature may have been issued and
#: still be accepted: the clock skew plus the cold start the first invoke of a
#: new runtime session waits through. Tunable (``AGENT_INVOKE_START_GRACE_SEC``),
#: clamped to [0, TTL_SEC].
DEFAULT_START_GRACE_SEC = SKEW_SEC + 20
#: Wall-clock time this process started (module import).
PROCESS_STARTED_AT = time.time()


def start_grace_sec(env=None) -> int:
    env = os.environ if env is None else env
    raw = (env.get("AGENT_INVOKE_START_GRACE_SEC") or "").strip()
    try:
        value = int(raw) if raw else DEFAULT_START_GRACE_SEC
    except ValueError:
        value = DEFAULT_START_GRACE_SEC
    return max(0, min(TTL_SEC, value))


def issued_before_start(sig: str, *, started_at: float | None = None, grace: int | None = None) -> bool:
    """True when the envelope's timestamp is earlier than this process's start
    less the grace: a cache that started empty cannot know whether it was used."""
    parts = (sig or "").split(".")
    if len(parts) != 4 or not parts[2].isdigit():
        return True
    floor = (PROCESS_STARTED_AT if started_at is None else started_at) - (start_grace_sec() if grace is None else grace)
    return int(parts[2]) < floor


class ReplayCacheFull(Exception):
    """The cache cannot record another nonce without dropping one that is
    still inside its signature window; the invocation is refused instead."""


class ReplayCache:
    """Nonces accepted inside the signature window, each kept until a
    signature carrying it could no longer verify (``TTL_SEC + SKEW_SEC``).

    In-process and thread-safe. Bounded by time, never by eviction: an entry
    leaves only when it expires. Past ``max_entries`` overall, or
    ``max_per_caller`` for one caller, ``seen_or_add`` raises
    ``ReplayCacheFull`` and records nothing (fail closed). Both are sized well
    above one runtime's request rate over the window.
    """

    def __init__(self, ttl_sec: float = TTL_SEC + SKEW_SEC, max_entries: int = 100_000,
                 max_per_caller: int = 2_000):
        self._ttl = ttl_sec
        self._max = max_entries
        self._max_per_caller = max_per_caller
        # Insertion order is expiry order: every entry gets the same ttl on a
        # monotonic clock.
        self._seen: "OrderedDict[str, tuple[float, str]]" = OrderedDict()
        self._per_caller: dict[str, int] = {}
        self._lock = threading.Lock()

    def seen_or_add(self, nonce: str, now: float | None = None, caller: str = "") -> bool:
        """True when ``nonce`` was already accepted and has not expired;
        otherwise records it and returns False. Raises ``ReplayCacheFull``
        when recording it would pass a bound."""
        t = time.monotonic() if now is None else now
        with self._lock:
            while self._seen:
                _, (expiry, old_caller) = next(iter(self._seen.items()))
                if expiry > t:
                    break
                self._seen.popitem(last=False)
                left = self._per_caller.get(old_caller, 0) - 1
                if left > 0:
                    self._per_caller[old_caller] = left
                else:
                    self._per_caller.pop(old_caller, None)
            if nonce in self._seen:
                return True
            if len(self._seen) >= self._max:
                raise ReplayCacheFull(f"the replay cache holds {len(self._seen)} unexpired nonces (limit {self._max})")
            if self._per_caller.get(caller, 0) >= self._max_per_caller:
                raise ReplayCacheFull(f"one caller holds {self._max_per_caller} unexpired nonces (the per-caller limit)")
            self._seen[nonce] = (t + self._ttl, caller)
            self._per_caller[caller] = self._per_caller.get(caller, 0) + 1
            return False

    def __len__(self) -> int:
        return len(self._seen)


_replay_cache = ReplayCache()

# The agents read the verified caller more than once per invocation (the
# handler, the retrieval filter, the tenant floor) from the same payload
# object. A nonce is consumed by the first read; later reads of the same
# object reuse that answer. Keyed by object identity and holding the object,
# so a fresh payload (a replay parsed from a new request) never matches.
_verified_payloads: "OrderedDict[int, tuple[dict, tuple, InvokeIdentity]]" = OrderedDict()
_verified_lock = threading.Lock()
_VERIFIED_MAX = 1024


def set_replay_cache(cache) -> None:
    """Swap the replay store: a shared one for a multi-replica runtime, or a
    fresh one in tests. It needs ``seen_or_add(nonce, caller=...) -> bool``
    and raises ``ReplayCacheFull`` rather than dropping an unexpired nonce."""
    global _replay_cache
    _replay_cache = cache
    with _verified_lock:
        _verified_payloads.clear()


def new_nonce() -> str:
    return secrets.token_urlsafe(18)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def canonical_body(
    auth: dict, conversation_id: str, *, prompt: str = "", input_raw: str = "",
    history: list | None = None, run_id: str = "", nonce: str = "",
) -> str:
    fields = {k: v for k, v in sorted(auth.items()) if isinstance(k, str) and isinstance(v, str)}
    history_sha = ""
    if history:
        pairs = [[h.get("role"), h.get("content")] if isinstance(h, dict) else [None, None] for h in history]
        history_sha = _sha256(json.dumps(pairs, separators=(",", ":"), ensure_ascii=False))
    return json.dumps(
        {
            "auth": fields,
            "conversationId": conversation_id or "",
            "historySha256": history_sha,
            "inputSha256": _sha256(input_raw) if input_raw else "",
            "nonce": nonce or "",
            "promptSha256": _sha256(prompt or ""),
            "runId": run_id or "",
        },
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )


def request_binding(payload: dict) -> dict | None:
    """What this payload asks, as ``canonical_body`` keyword arguments, or
    ``None`` when it cannot be bound (the three prompt keys disagree, or a
    field has the wrong type): such a payload never verifies."""
    prompts = [payload[k] for k in ("input_text", "prompt", "message") if payload.get(k) is not None]
    if any(not isinstance(p, str) for p in prompts) or len(set(prompts)) > 1:
        return None
    raw_input = payload.get("input")
    if raw_input is not None and not isinstance(raw_input, str):
        return None
    history = payload.get("history")
    if history is not None and not isinstance(history, list):
        return None
    run_id = payload.get("runId")
    if run_id is not None and not isinstance(run_id, str):
        return None
    nonce = payload.get("authNonce")
    if nonce is not None and not isinstance(nonce, str):
        return None
    return {"prompt": prompts[0] if prompts else "", "input_raw": raw_input or "",
            "history": history or None, "run_id": run_id or "", "nonce": nonce or ""}


def canonical_for(payload: dict) -> str | None:
    """The canonical body for a whole payload (its auth block, conversation
    and request), or ``None`` when it cannot be bound."""
    binding = request_binding(payload)
    auth = payload.get("auth")
    if binding is None or not isinstance(auth, dict):
        return None
    conversation_id = payload.get("sessionId") if isinstance(payload.get("sessionId"), str) else ""
    return canonical_body(auth, conversation_id, **binding)


def insecure_dev_mode(env=None) -> bool:
    """INSECURE_DEV_MODE=true and not production (service-runtime's rule, plus APP_ENV)."""
    env = os.environ if env is None else env
    flag = (env.get("INSECURE_DEV_MODE") or "").strip().lower() == "true"
    # Any case, padded, or the short `prod` (middleware lib/insecure-dev-mode.ts).
    production = any((env.get(k) or "").strip().lower() in ("production", "prod") for k in ("NODE_ENV", "APP_ENV"))
    return flag and not production


def verified_identity(payload: dict) -> InvokeIdentity | None:
    """The payload's identity when it may be trusted, else ``None``.

    A signed payload is accepted once: its nonce is recorded, and another
    payload with the same nonce inside the window is refused as a replay.
    Reading the same payload object again returns the first answer."""
    if not isinstance(payload, dict):
        return None
    key = id(payload)
    stamp = (payload.get("authSig"), canonical_for(payload))
    with _verified_lock:
        hit = _verified_payloads.get(key)
        if hit is not None and hit[0] is payload and hit[1] == stamp:
            return hit[2]
    ident = _verify(payload)
    if ident is not None and ident.signed:
        with _verified_lock:
            _verified_payloads[key] = (payload, stamp, ident)
            _verified_payloads.move_to_end(key)
            while len(_verified_payloads) > _VERIFIED_MAX:
                _verified_payloads.popitem(last=False)
    return ident


def _verify(payload: dict) -> InvokeIdentity | None:
    auth = payload.get("auth")
    if not isinstance(auth, dict):
        return None
    conversation_id = payload.get("sessionId") if isinstance(payload.get("sessionId"), str) else ""
    try:
        secret = resolve_secret(SECRET_ENV)
    except SecretResolutionError as exc:
        log.error("invoke-auth: %s", exc)
        return None
    if not secret:
        if insecure_dev_mode():
            return InvokeIdentity(auth=auth, conversation_id=conversation_id, signed=False)
        log.warning("invoke-auth: %s is unset outside dev mode; the auth block is not trusted", SECRET_ENV)
        return None
    sig = payload.get("authSig")
    body = canonical_for(payload)
    if body is None:
        log.warning("invoke-auth: the request cannot be bound to the signature; treating the caller as least privileged")
        return None
    ok, why = verify_service_request(
        sig if isinstance(sig, str) else "", METHOD, TARGET, body,
        secret=secret, allowed_services=list(ALLOWED_SERVICES), audience=AUDIENCE, ttl_sec=TTL_SEC,
    )
    if not ok:
        log.warning("invoke-auth: auth block refused (%s); treating the caller as least privileged", why)
        return None
    nonce = payload.get("authNonce")
    if not isinstance(nonce, str) or not (MIN_NONCE_LEN <= len(nonce) <= MAX_NONCE_LEN):
        log.warning("invoke-auth: the signed block carries no usable nonce; treating the caller as least privileged")
        return None
    if issued_before_start(sig):
        # The cache started empty with this process, so it cannot tell whether
        # this nonce was used before a restart.
        log.warning("invoke-auth: the signature was issued before this process started; treating the caller as least privileged")
        return None
    tenant = auth.get("tenant") if isinstance(auth.get("tenant"), str) else ""
    sub = auth.get("sub") if isinstance(auth.get("sub"), str) else ""
    try:
        replayed = _replay_cache.seen_or_add(nonce, caller=f"{why}:{tenant}:{sub}")
    except ReplayCacheFull as exc:
        log.error("invoke-auth: refusing the signed invocation: %s. Nothing is evicted; it clears as entries expire", exc)
        return None
    if replayed:
        log.warning("invoke-auth: nonce already used inside the signature window; treating the caller as least privileged")
        return None
    return InvokeIdentity(auth=auth, conversation_id=conversation_id, signed=True)


def verified_auth(payload) -> dict | None:
    """The verified ``auth`` block, or ``None``. The only place an agent reads
    tenant, role or sub from: never the payload's top level, never ``input``."""
    ident = verified_identity(payload) if isinstance(payload, dict) else None
    return ident.auth if ident else None


def sign_identity(
    auth: dict, conversation_id: str, *, prompt: str = "", run_id: str = "",
    service_id: str = SUPERVISOR_SERVICE_ID,
) -> dict:
    """``{"authSig", "authNonce"}`` for a block this agent hands down (the
    supervisor to a sub-agent), bound to the prompt it sends and a fresh
    nonce, or ``{}`` when no secret is configured (dev mode: the sub-agent
    then trusts the block only under its own dev flag). Spread it into the
    payload."""
    try:
        secret = resolve_secret(SECRET_ENV)
    except SecretResolutionError as exc:
        log.error("invoke-auth: %s", exc)
        return {}
    if not secret:
        return {}
    nonce = new_nonce()
    sig = sign_service_request(
        METHOD, TARGET, canonical_body(auth, conversation_id, prompt=prompt, run_id=run_id, nonce=nonce),
        secret=secret, service_id=service_id, audience=AUDIENCE,
    )
    return {"authSig": sig, "authNonce": nonce}


#: Top-level keys only the middleware's body builder (or the supervisor) sets:
#: identity and the trace join. Mirrors INVOKE_IDENTITY_KEYS in
#: middleware/src/lib/agent-invoke-auth.ts.
IDENTITY_KEYS = frozenset({
    "auth", "authSig", "authNonce", "tenant", "sub", "role", "actor",
    "userId", "user_id", "sessionId", "session_id", "runtimeSessionId",
    "runId", "run_id", "invocationId", "parentInvocationId", "parent_invocation_id",
    "threadId", "thread_id",
})


def request_fields(payload) -> dict:
    """The caller's structured fields (``mode``, ``document``, ...).

    The middleware nests them under ``input`` (a JSON object, or the JSON text
    of one); a payload without ``input`` (a direct or test invoke) uses its own
    top level. Identity keys are removed either way, so a structured field can
    never stand in for the verified caller.
    """
    if not isinstance(payload, dict):
        return {}
    raw = payload.get("input")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = None
        if not isinstance(raw, dict):
            return {}
    source = raw if isinstance(raw, dict) else payload
    return {k: v for k, v in source.items() if k not in IDENTITY_KEYS and k != "input"}
