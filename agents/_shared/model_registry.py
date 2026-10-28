"""Resolve an agent's model from the central, versioned model registry (DE-3).

Why this exists
---------------
Every agent used to read ``MODEL_ID`` with its own literal default, and CDK set
one fleet-wide value, so the deployed supervisor ran Nova Pro while a local one
ran Nova Lite and changing a model meant a runtime redeploy. The registry is
one JSON document, ``/orgiq/models/registry`` in SSM Parameter Store, written
by CDK from the checked-in ``infra/config/model-registry.json``:

    {"schema": 1,
     "roles": {"search": {"primary": "...", "fallbacks": [...],
                          "temperature": 0.1, "maxTokens": 4096}},
     "allow": ["amazon.", "us.amazon.", ...]}

Resolution order (``resolve_model(role)``), never failing closed:

1. ``MODEL_REGISTRY_PARAM`` set → SSM (optionally pinned to the parameter
   version in ``MODEL_REGISTRY_VERSION``), cached ``MODEL_REGISTRY_REFRESH_S``
   (default 60 s) in process, short boto timeouts.
2. No parameter (local ``agentcore dev``, tests) → the checked-in file
   (``MODEL_REGISTRY_FILE`` or the repo's ``infra/config/model-registry.json``
   when present). SSM is never called offline.
3. Registry unreadable, role missing or an id rejected → ``MODEL_ID`` env.
4. Otherwise the literal default the agent passes in.

Every id is checked against the AWS-native prefixes in ``ALLOWED_PREFIXES``;
a registry cannot widen that list (its own ``allow`` can only narrow it). The
devbox's Claude inference profile lives outside the registry by design.

Fallback models are tried on capacity errors only (throttling, model not
ready, service unavailable) — never on validation or guardrail errors — and
the model is chosen between turns, never swapped mid-request.

``MODEL_REGISTRY_DISABLED=1`` skips the registry (env, then literal).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar

log = logging.getLogger(__name__)

#: The AWS-native rule, mechanically. A registry's ``allow`` list may narrow
#: this, never widen it.
ALLOWED_PREFIXES: tuple[str, ...] = ("amazon.", "us.amazon.", "eu.amazon.", "apac.amazon.")

_REPO_REGISTRY_FILE = (
    Path(__file__).resolve().parent.parent.parent / "infra" / "config" / "model-registry.json"
)

#: Bedrock / Strands error codes and class names that mean "capacity", so the
#: next model in the chain is worth trying. Validation, access and guardrail
#: errors are deliberately absent: a different model would not fix them.
CAPACITY_ERROR_CODES = frozenset({
    "ThrottlingException",
    "TooManyRequestsException",
    "ModelNotReadyException",
    "ServiceUnavailableException",
    "ModelThrottledException",  # Strands' wrapper for a Bedrock throttle
})


def _refresh_s() -> float:
    try:
        return float(os.environ.get("MODEL_REGISTRY_REFRESH_S", "60"))
    except ValueError:
        return 60.0


def is_allowed_model_id(model_id: Any, allow: Iterable[str] = ALLOWED_PREFIXES) -> bool:
    if not isinstance(model_id, str) or not model_id.strip():
        return False
    narrowed = [p for p in allow if isinstance(p, str) and p in ALLOWED_PREFIXES] or list(ALLOWED_PREFIXES)
    return any(model_id.startswith(p) for p in narrowed)


class RegistryError(ValueError):
    """The registry document is malformed or names a non-AWS-native model."""


def validate_registry(doc: Any) -> dict:
    """Return the document when every id is allowed; raise RegistryError otherwise.

    Same rule as the CDK synth check (infra/lib/model-registry.ts).
    """
    if not isinstance(doc, dict):
        raise RegistryError("registry must be a JSON object")
    if doc.get("schema") != 1:
        raise RegistryError(f"unsupported registry schema {doc.get('schema')!r}")
    allow = doc.get("allow", list(ALLOWED_PREFIXES))
    if not isinstance(allow, list) or not all(isinstance(p, str) for p in allow):
        raise RegistryError("allow must be a list of prefixes")
    widened = [p for p in allow if p not in ALLOWED_PREFIXES]
    if widened:
        raise RegistryError(f"allow widens the AWS-native rule: {widened}")
    roles = doc.get("roles")
    if not isinstance(roles, dict) or not roles:
        raise RegistryError("roles must be a non-empty object")
    for role, entry in roles.items():
        if not isinstance(entry, dict):
            raise RegistryError(f"role {role}: entry must be an object")
        ids = [entry.get("primary")] + list(entry.get("fallbacks") or [])
        for mid in ids:
            if not is_allowed_model_id(mid, allow):
                raise RegistryError(f"role {role}: model id {mid!r} is not AWS-native")
    return doc


@dataclass(frozen=True)
class ResolvedModel:
    role: str
    model_id: str
    fallbacks: tuple[str, ...] = ()
    temperature: float | None = None
    max_tokens: int | None = None
    #: "ssm", "file", "env" or "default"
    source: str = "default"
    #: SSM parameter version (as a string) when source == "ssm", else "".
    version: str = ""

    @property
    def chain(self) -> tuple[str, ...]:
        """Primary first, then fallbacks, de-duplicated."""
        seen: list[str] = []
        for mid in (self.model_id, *self.fallbacks):
            if mid not in seen:
                seen.append(mid)
        return tuple(seen)


# ── document cache ───────────────────────────────────────────────────────────

_ssm_client = None
_client_lock = threading.Lock()
_cache_lock = threading.Lock()
#: key → (doc | None, version, fetched_at)
_cache: dict[str, tuple[dict | None, str, float]] = {}


def _ssm():
    global _ssm_client
    if _ssm_client is None:
        with _client_lock:
            if _ssm_client is None:
                import boto3
                from botocore.config import Config

                _ssm_client = boto3.client(
                    "ssm",
                    region_name=os.environ.get("AWS_REGION", "us-east-1"),
                    config=Config(connect_timeout=2, read_timeout=3,
                                  retries={"max_attempts": 2, "mode": "standard"}),
                )
    return _ssm_client


def _load_from_ssm(param: str, pinned: str) -> tuple[dict | None, str]:
    name = f"{param}:{pinned}" if pinned else param
    try:
        resp = _ssm().get_parameter(Name=name)
        p = resp.get("Parameter") or {}
        doc = validate_registry(json.loads(p.get("Value") or "{}"))
        return doc, str(p.get("Version") or pinned or "")
    except Exception as exc:  # noqa: BLE001 — a registry outage must never stop the fleet
        code = getattr(exc, "response", {}).get("Error", {}).get("Code") if hasattr(exc, "response") else None
        log.warning("model_registry: %s unreadable (%s) — falling back to MODEL_ID", name, code or exc)
        return None, ""


def _registry_file() -> Path | None:
    explicit = os.environ.get("MODEL_REGISTRY_FILE", "").strip()
    if explicit:
        return Path(explicit)
    return _REPO_REGISTRY_FILE if _REPO_REGISTRY_FILE.exists() else None


def _load_from_file(path: Path) -> tuple[dict | None, str]:
    try:
        return validate_registry(json.loads(path.read_text(encoding="utf-8"))), ""
    except Exception as exc:  # noqa: BLE001
        log.warning("model_registry: %s unreadable (%s) — falling back to MODEL_ID", path, exc)
        return None, ""


def _document() -> tuple[dict | None, str, str]:
    """(doc, version, source) with the TTL cache applied."""
    if os.environ.get("MODEL_REGISTRY_DISABLED", "") == "1":
        return None, "", ""
    param = os.environ.get("MODEL_REGISTRY_PARAM", "").strip()
    pinned = os.environ.get("MODEL_REGISTRY_VERSION", "").strip()
    if param:
        key, source = f"ssm:{param}:{pinned}", "ssm"
    else:
        path = _registry_file()
        if path is None:
            return None, "", ""
        key, source = f"file:{path}", "file"

    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[2] < _refresh_s():
            return hit[0], hit[1], source

    doc, version = _load_from_ssm(param, pinned) if param else _load_from_file(path)  # type: ignore[arg-type]
    with _cache_lock:
        _cache[key] = (doc, version, now)
    return doc, version, source


def resolve_model(
    role: str,
    *,
    default_model_id: str = "amazon.nova-pro-v1:0",
    default_temperature: float | None = None,
    default_max_tokens: int | None = None,
) -> ResolvedModel:
    """The model ``role`` should use for its next turn. Cache-cheap; call per invocation."""
    doc, version, source = _document()
    entry = (doc or {}).get("roles", {}).get(role) if doc else None
    if isinstance(entry, dict):
        temp = entry.get("temperature", default_temperature)
        max_tokens = entry.get("maxTokens", default_max_tokens)
        return ResolvedModel(
            role=role,
            model_id=entry["primary"],
            fallbacks=tuple(entry.get("fallbacks") or ()),
            temperature=float(temp) if temp is not None else None,
            max_tokens=int(max_tokens) if max_tokens is not None else None,
            source=source,
            version=version,
        )
    if doc is not None:
        log.warning("model_registry: role %r not in registry — falling back to MODEL_ID", role)

    temp_env = os.environ.get("MODEL_TEMPERATURE")
    tokens_env = os.environ.get("MODEL_MAX_TOKENS")
    temperature = float(temp_env) if temp_env else default_temperature
    max_tokens = int(tokens_env) if tokens_env else default_max_tokens

    env_id = os.environ.get("MODEL_ID", "").strip()
    if env_id:
        if is_allowed_model_id(env_id):
            return ResolvedModel(role=role, model_id=env_id, temperature=temperature,
                                 max_tokens=max_tokens, source="env")
        log.error("model_registry: MODEL_ID %r is not AWS-native — using %s", env_id, default_model_id)
    return ResolvedModel(role=role, model_id=default_model_id, temperature=temperature,
                         max_tokens=max_tokens, source="default")


def reset_cache() -> None:
    """Test hook — drop cached registry documents."""
    with _cache_lock:
        _cache.clear()


# ── capacity fallback ────────────────────────────────────────────────────────


def is_capacity_error(exc: BaseException) -> bool:
    """True for throttling / model-not-ready / unavailable; False for anything else."""
    current: BaseException | None = exc
    for _ in range(4):  # walk a short __cause__ chain (Strands wraps botocore)
        if current is None:
            break
        if type(current).__name__ in CAPACITY_ERROR_CODES:
            return True
        response = getattr(current, "response", None)
        if isinstance(response, dict):
            code = (response.get("Error") or {}).get("Code")
            if code in CAPACITY_ERROR_CODES:
                return True
        current = current.__cause__ or current.__context__
    return False


T = TypeVar("T")


def invoke_with_fallback(call: Callable[[str], T], chain: Iterable[str]) -> tuple[T, str]:
    """Run ``call(model_id)`` down ``chain``; move on only on a capacity error.

    Returns ``(result, model_id_served)``. The last capacity error is re-raised
    when every model is out of capacity; any other error is raised at once.
    """
    ids = [m for m in chain if m]
    last: BaseException | None = None
    for i, mid in enumerate(ids):
        try:
            return call(mid), mid
        except Exception as exc:  # noqa: BLE001
            if not is_capacity_error(exc):
                raise
            last = exc
            if i + 1 < len(ids):
                log.warning("model_registry: %s out of capacity (%s) — trying %s",
                            mid, type(exc).__name__, ids[i + 1])
    if last is None:
        raise ValueError("invoke_with_fallback: empty model chain")
    raise last


def _stamp_current_span(model_id: str) -> None:
    """Record the id actually served (after any fallback) on the active span."""
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span is not None and span.is_recording():
            span.set_attribute("orgiq.model_id", model_id)
    except Exception:  # noqa: BLE001 — provenance must never break a turn
        pass


class RegistryAgent:
    """A ``LiveAgent`` per model id, chosen from the registry between turns.

    Drop-in for the module-level ``_agent`` (``LiveAgent``) in each agent:

        _agent = RegistryAgent(
            role="search",
            default_model_id="amazon.nova-pro-v1:0",
            baked=SYSTEM_PROMPT,
            agent_name="search",
            build=lambda system_prompt, model_id: Agent(
                model=BedrockModel(**_model_kwargs(model_id)), ...),
        )

    A call runs on the registry's primary and, on a capacity error, retries the
    turn on each fallback in turn (a fresh agent per model; the prompt still
    tracks Bedrock Prompt Management through ``LiveAgent``). The streaming
    adapter (``ag_ui``) serves the primary only.
    """

    def __init__(self, *, role: str, default_model_id: str, baked: str, build,
                 agent_name: str | None = None, name: str | None = None,
                 default_temperature: float | None = None,
                 default_max_tokens: int | None = None,
                 live_agent_factory=None):
        self._role = role
        self._defaults = dict(default_model_id=default_model_id,
                              default_temperature=default_temperature,
                              default_max_tokens=default_max_tokens)
        self._baked = baked
        self._build = build
        self._agent_name = agent_name
        self._name = name
        self._factory = live_agent_factory
        self._lock = threading.Lock()
        self._by_model: dict[tuple, Any] = {}
        self._served: str | None = None

    # ── registry view ──────────────────────────────────────────────────────
    def resolved_model(self) -> ResolvedModel:
        return resolve_model(self._role, **self._defaults)

    @property
    def model_id(self) -> str:
        """The id that served the last turn, else the current primary."""
        return self._served or self.resolved_model().model_id

    @property
    def registry_version(self) -> str:
        return self.resolved_model().version

    def _live(self, model_id: str):
        # Keyed by the id plus the registry's sampling settings, so a
        # temperature / maxTokens edit also rebuilds between turns.
        current = self.resolved_model()
        key = (model_id, current.temperature, current.max_tokens)
        with self._lock:
            live = self._by_model.get(key)
            if live is None:
                factory = self._factory
                if factory is None:
                    from _shared.prompt_source import LiveAgent as factory  # noqa: N813
                live = factory(
                    baked=self._baked,
                    agent_name=self._agent_name,
                    name=self._name,
                    build=lambda system_prompt, _mid=model_id: self._build(system_prompt, _mid),
                )
                self._by_model[key] = live
            return live

    def _primary(self):
        return self._live(self.resolved_model().model_id)

    # ── LiveAgent surface ──────────────────────────────────────────────────
    @property
    def _prompted(self):
        """The primary's ``PromptedAgent`` (tests script the built agent through it)."""
        return self._primary()._prompted

    @property
    def resolved(self):
        return self._primary().resolved

    @property
    def prompt_sha(self) -> str:
        return self._primary().prompt_sha

    @property
    def prompt_source(self) -> str:
        return self._primary().prompt_source

    def ag_ui(self, *, name: str):
        self._served = self.resolved_model().model_id
        return self._primary().ag_ui(name=name)

    def __call__(self, *args, **kwargs):
        chain = self.resolved_model().chain
        result, served = invoke_with_fallback(lambda mid: self._live(mid)(*args, **kwargs), chain)
        self._served = served
        _stamp_current_span(served)
        return result

    def __getattr__(self, item):
        if item.startswith("_"):
            raise AttributeError(item)
        return getattr(self._primary(), item)
