"""Resolve an agent's system prompt from Bedrock Prompt Management at runtime.

Why this exists
---------------
The portal ships a Prompt Studio that edits managed prompts in Bedrock, and
the library contains an ``orgiq-<agent>-system-prompt`` entry for every agent.
But the agents historically compiled ``SYSTEM_PROMPT`` into their container
image as a Python literal and never read those entries — so editing a prompt
in the studio changed *nothing* about the deployed agent until someone
rebuilt the image and redeployed the runtime. The UI implied a control that
did not exist.

This module makes the Bedrock library the source of truth:

    SYSTEM_PROMPT (baked literal)  →  fallback only
    orgiq-<agent>-system-prompt    →  what the agent actually runs

Safety properties (deliberate, in priority order):

1. **Never fail closed.** Any error — missing prompt, denied permission,
   throttle, malformed variant — falls back to the baked literal and logs.
   A prompt-management outage must not take the agent fleet down.
2. **Never hot-swap mid-request.** Resolution happens between invocations;
   a single run always uses one prompt text.
3. **Cheap.** One GetPrompt per refresh interval (default 60s), cached in
   process. Cold start costs one extra control-plane call.

Env contract
------------
``SYSTEM_PROMPT_NAME``     override the looked-up name (default derived from
                           ``AGENT_NAME``: ``orgiq-<agent>-system-prompt``)
``SYSTEM_PROMPT_VERSION``  pin a numbered version; default DRAFT (the studio's
                           editable working copy, so edits apply immediately)
``PROMPT_REFRESH_S``       cache TTL in seconds (default 60)
``PROMPT_SOURCE_DISABLED`` set to "1" to force the baked literal (kill switch)
"""

from __future__ import annotations

import hashlib
import re
import logging
import os
import threading
import time
from dataclasses import dataclass

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-1")
REFRESH_S = int(os.environ.get("PROMPT_REFRESH_S", "60"))
DISABLED = os.environ.get("PROMPT_SOURCE_DISABLED", "") == "1"

# Short timeouts + no retries beyond one: a slow control plane must never add
# seconds to an agent invocation. Falling back to the baked prompt is better.
_BOTO_CFG = Config(
    connect_timeout=2,
    read_timeout=3,
    retries={"max_attempts": 2, "mode": "standard"},
)

_client = None
_client_lock = threading.Lock()


def _bedrock_agent():
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = boto3.client("bedrock-agent", region_name=REGION, config=_BOTO_CFG)
    return _client


def prompt_sha(text: str) -> str:
    """Stable short hash used as the prompt version marker on traces."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


@dataclass(frozen=True)
class ResolvedPrompt:
    text: str
    #: "bedrock" when the library supplied it, "baked" when the literal did.
    source: str
    #: Bedrock version label ("DRAFT" / "1" / ...) or "" when baked.
    version: str
    sha: str

    @property
    def is_live(self) -> bool:
        return self.source == "bedrock"


class _Cache:
    """One entry per prompt name. Thread-safe, TTL-refreshed."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[ResolvedPrompt, float]] = {}

    def get(self, name: str) -> ResolvedPrompt | None:
        with self._lock:
            hit = self._entries.get(name)
            if not hit:
                return None
            resolved, fetched_at = hit
            if time.monotonic() - fetched_at > REFRESH_S:
                return None
            return resolved

    def put(self, name: str, resolved: ResolvedPrompt) -> None:
        with self._lock:
            self._entries[name] = (resolved, time.monotonic())


_cache = _Cache()


def default_prompt_name(agent_name: str | None = None) -> str:
    """`search` → `orgiq-search-system-prompt` (matches the seeded library)."""
    explicit = os.environ.get("SYSTEM_PROMPT_NAME")
    if explicit:
        return explicit
    agent = agent_name or os.environ.get("AGENT_NAME", "")
    agent = agent.replace("_", "-")
    return f"orgiq-{agent}-system-prompt" if agent else ""


def _find_prompt_id(name: str) -> str | None:
    """ListPrompts is paginated and name-filtered server-side where possible."""
    paginator = _bedrock_agent().get_paginator("list_prompts")
    for page in paginator.paginate():
        for summary in page.get("promptSummaries", []):
            if summary.get("name") == name:
                return summary.get("id")
    return None


def _fetch_text(name: str) -> tuple[str, str] | None:
    """Return (text, version) for the configured prompt, or None."""
    prompt_id = _find_prompt_id(name)
    if not prompt_id:
        return None

    version = os.environ.get("SYSTEM_PROMPT_VERSION", "").strip()
    kwargs = {"promptIdentifier": prompt_id}
    if version and version.upper() != "DRAFT":
        kwargs["promptVersion"] = version

    detail = _bedrock_agent().get_prompt(**kwargs)
    variants = detail.get("variants") or []
    default_variant = detail.get("defaultVariant")
    variant = next((v for v in variants if v.get("name") == default_variant), None) or (
        variants[0] if variants else None
    )
    if not variant:
        return None

    text = ((variant.get("templateConfiguration") or {}).get("text") or {}).get("text")
    if not text or not text.strip():
        return None
    return text, (detail.get("version") or version or "DRAFT")


_PLACEHOLDER = re.compile(r"\{\{\s*[^}\s]+\s*\}\}")


def unexpanded_variables(text: str) -> list[str]:
    """Placeholders still sitting in a resolved prompt.

    A system prompt is meant to be complete text. If one still contains
    ``{{tenant}}`` by the time it reaches the model, nothing downstream will
    ever fill it — the fleet ships the braces verbatim and the instruction
    quietly means something other than what its author wrote. There is no
    substitution step on this path by design (see the module header: an agent's
    identity is not parameterised), so the honest handling is to NOT guess a
    value and instead make the mistake loud: it is logged here and carried on
    the resolved prompt so a trace can show it.

    Parameterised assets belong in the library and are rendered through the
    contract (middleware lib/prompt-contract.ts), which types every variable
    and fences the untrusted ones.
    """
    return sorted({m.group(0) for m in _PLACEHOLDER.finditer(text)})


def resolve_system_prompt(
    baked: str,
    *,
    agent_name: str | None = None,
    name: str | None = None,
) -> ResolvedPrompt:
    """Resolve the live system prompt, falling back to ``baked`` on any error.

    Call this per invocation — it is cache-cheap and lets a prompt edit take
    effect within ``PROMPT_REFRESH_S`` without redeploying the runtime.
    """
    baked_resolved = ResolvedPrompt(text=baked, source="baked", version="", sha=prompt_sha(baked))

    if DISABLED:
        return baked_resolved

    prompt_name = name or default_prompt_name(agent_name)
    if not prompt_name:
        return baked_resolved

    cached = _cache.get(prompt_name)
    if cached is not None:
        return cached

    try:
        found = _fetch_text(prompt_name)
        if found is None:
            log.info("prompt_source: %s not found in Bedrock — using baked prompt", prompt_name)
            _cache.put(prompt_name, baked_resolved)
            return baked_resolved
        text, version = found
        resolved = ResolvedPrompt(
            text=text, source="bedrock", version=version, sha=prompt_sha(text)
        )
        leftover = unexpanded_variables(text)
        if leftover:
            # Loud, not fatal: the prompt still works better than the baked
            # fallback would, but somebody has shipped a template where a
            # finished prompt belongs.
            log.warning(
                "prompt_source: %s still contains unexpanded %s — system prompts are not "
                "parameterised on this path; move the variable part into a library asset "
                "with a contract",
                prompt_name, ", ".join(leftover),
            )
        _cache.put(prompt_name, resolved)
        log.info(
            "prompt_source: resolved %s from Bedrock (version=%s sha=%s)",
            prompt_name, version, resolved.sha,
        )
        return resolved
    except ClientError as exc:  # noqa: BLE001 — any AWS failure must fall back
        code = exc.response.get("Error", {}).get("Code", "?")
        log.warning("prompt_source: %s lookup failed (%s) — using baked prompt", prompt_name, code)
        _cache.put(prompt_name, baked_resolved)
        return baked_resolved
    except Exception as exc:  # noqa: BLE001
        log.warning("prompt_source: %s lookup error (%s) — using baked prompt", prompt_name, exc)
        _cache.put(prompt_name, baked_resolved)
        return baked_resolved


class PromptedAgent:
    """Holds a Strands Agent whose system prompt tracks the Bedrock library.

    The agent object is rebuilt only when the resolved prompt text actually
    changes (sha compare), so steady-state invocations pay nothing. Rebuilding
    between requests — never during one — keeps a single run coherent.

    Usage in an agent module::

        _prompted = PromptedAgent(
            baked=SYSTEM_PROMPT,
            agent_name="search",
            build=lambda system_prompt: Agent(
                model=_model, tools=[...], system_prompt=system_prompt,
            ),
        )
        agent, resolved = _prompted.get()   # inside the entrypoint
    """

    def __init__(self, *, baked: str, build, agent_name: str | None = None, name: str | None = None):
        self._baked = baked
        self._build = build
        self._agent_name = agent_name
        self._name = name
        self._lock = threading.Lock()
        self._agent = None
        self._sha: str | None = None
        self._resolved: ResolvedPrompt | None = None

    def get(self):
        """Return (agent, ResolvedPrompt) with the freshest prompt available."""
        resolved = resolve_system_prompt(
            self._baked, agent_name=self._agent_name, name=self._name
        )
        with self._lock:
            if self._agent is None or self._sha != resolved.sha:
                previous = self._sha
                self._agent = self._build(resolved.text)
                self._sha = resolved.sha
                self._resolved = resolved
                if previous is not None:
                    log.info(
                        "prompt_source: system prompt changed (%s → %s, source=%s) — agent rebuilt",
                        previous, resolved.sha, resolved.source,
                    )
            return self._agent, resolved


class LiveAgent:
    """Drop-in replacement for a module-level ``_agent`` whose system prompt
    tracks the Bedrock library.

    Call it exactly like a Strands ``Agent``; attribute access proxies through.
    ``prompt_sha`` / ``prompt_source`` expose what the *next* (or current) run
    uses, which is what the trace bundle should record — so observability shows
    which prompt version actually served a request instead of a build-time
    constant.

        _agent = LiveAgent(
            baked=SYSTEM_PROMPT,
            agent_name="search",
            build=lambda system_prompt: Agent(
                model=_model, tools=[...], system_prompt=system_prompt,
            ),
        )
    """

    def __init__(self, *, baked: str, build, agent_name: str | None = None, name: str | None = None):
        self._prompted = PromptedAgent(
            baked=baked, build=build, agent_name=agent_name, name=name
        )

    # ── introspection used by tracing ──────────────────────────────────────
    @property
    def resolved(self) -> ResolvedPrompt:
        _, resolved = self._prompted.get()
        return resolved

    @property
    def prompt_sha(self) -> str:
        return self.resolved.sha

    @property
    def prompt_source(self) -> str:
        return self.resolved.source

    # ── agent behavior ─────────────────────────────────────────────────────
    def __call__(self, *args, **kwargs):
        agent, _ = self._prompted.get()
        return agent(*args, **kwargs)

    def __getattr__(self, item):
        # Only reached for attributes not defined on LiveAgent itself.
        agent, _ = self._prompted.get()
        return getattr(agent, item)


def reset_cache() -> None:
    """Test hook — drop all cached resolutions."""
    global _cache
    _cache = _Cache()
