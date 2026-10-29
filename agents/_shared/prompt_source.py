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
``SYSTEM_PROMPT_POINTER``  DE-4: an SSM path (``/orgiq/prompts/<agent>``) whose
                           ``/live`` and ``/candidate`` parameters name the
                           promoted Bedrock version. See "Pointers" below.
``PROMPT_REFRESH_S``       cache TTL in seconds (default 60)
``PROMPT_SOURCE_DISABLED`` set to "1" to force the baked literal (kill switch)
``APP_ENV``                ``production`` refuses DRAFT: a studio edit must be
                           published and promoted before the fleet serves it.

Pointers (DE-4, docs/deployment-enhancements/DE-4-prompt-promotion.md)
----------------------------------------------------------------------
Reading DRAFT meant a ``PUT …/draft`` reached production within 60 s with no
gate. The pointer is the alias Bedrock Prompt Management does not offer:

    /orgiq/prompts/<agent>/live       {"promptId": "…", "version": "7"}
    /orgiq/prompts/<agent>/candidate  {"promptId": "…", "version": "8", "weight": 10}

With ``SYSTEM_PROMPT_POINTER`` set the resolver reads both parameters (one
``GetParameters`` call, cached ``PROMPT_REFRESH_S``), never lists prompts
(the pointer carries the id), and per invocation serves the candidate with
probability ``weight/100``, otherwise live. Numbered versions are immutable,
so their text is cached for the life of the process. The safety properties
above still hold: a pointer that cannot be read or parsed falls back to the
baked literal, and an arm is chosen between invocations, never during one.
``SYSTEM_PROMPT_VERSION`` set to a number stays a hard pin (no candidate
split); ``PROMPT_SOURCE_DISABLED=1`` stays the kill switch.
"""

from __future__ import annotations

import hashlib
import json
import random
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

#: Arm labels stamped on traces as ``orgiq.prompt_arm``.
ARM_LIVE = "live"
ARM_CANDIDATE = "candidate"
ARM_PINNED = "pinned"

#: The candidate/live coin. Module-level so a test can seed it
#: (``prompt_source._rng = random.Random(7)``); never reseeded here.
_rng = random.Random()

# Short timeouts + no retries beyond one: a slow control plane must never add
# seconds to an agent invocation. Falling back to the baked prompt is better.
_BOTO_CFG = Config(
    connect_timeout=2,
    read_timeout=3,
    retries={"max_attempts": 2, "mode": "standard"},
)

_client = None
_client_lock = threading.Lock()
_ssm_client = None


def _bedrock_agent():
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = boto3.client("bedrock-agent", region_name=REGION, config=_BOTO_CFG)
    return _client


def _ssm():
    global _ssm_client
    if _ssm_client is None:
        with _client_lock:
            if _ssm_client is None:
                _ssm_client = boto3.client("ssm", region_name=REGION, config=_BOTO_CFG)
    return _ssm_client


def prompt_sha(text: str) -> str:
    """Stable short hash used as the prompt version marker on traces."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def is_production() -> bool:
    return os.environ.get("APP_ENV", "").strip().lower() == "production"


def pointer_path() -> str:
    """``SYSTEM_PROMPT_POINTER`` without a trailing slash, or ""."""
    return os.environ.get("SYSTEM_PROMPT_POINTER", "").strip().rstrip("/")


def pinned_version() -> str:
    """A numbered ``SYSTEM_PROMPT_VERSION``, or "" (unset / DRAFT are not pins)."""
    version = os.environ.get("SYSTEM_PROMPT_VERSION", "").strip()
    return version if version and version.upper() != "DRAFT" else ""


@dataclass(frozen=True)
class ResolvedPrompt:
    text: str
    #: "bedrock" when the library supplied it, "baked" when the literal did.
    source: str
    #: Bedrock version label ("DRAFT" / "1" / ...) or "" when baked.
    version: str
    sha: str
    #: Bedrock prompt id when known (pointer reads carry it), else "".
    prompt_id: str = ""
    #: Which pointer arm served this text: "live", "candidate", "pinned" or "".
    arm: str = ""

    @property
    def is_live(self) -> bool:
        return self.source == "bedrock"

    @property
    def version_number(self) -> str:
        """The numbered Bedrock version ("7"), or "" for DRAFT / baked.

        Traces carry this beside the content sha so a judge score can be joined
        to a published version without re-hashing (DE-4).
        """
        return self.version if self.version.isdigit() else ""


@dataclass(frozen=True)
class Pointer:
    """One ``/live`` or ``/candidate`` parameter, parsed."""

    prompt_id: str
    version: str
    #: Candidate traffic share in percent (0 for live).
    weight: int = 0


def parse_pointer(raw: str | None, *, candidate: bool = False) -> Pointer | None:
    """Parse a pointer parameter value; ``None`` for anything malformed.

    Strict on purpose: a pointer is the one thing standing between a studio
    edit and production, so a half-formed one is treated as absent (→ baked),
    never guessed at.
    """
    if not raw or not isinstance(raw, str):
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(doc, dict):
        return None
    prompt_id = doc.get("promptId")
    version = doc.get("version")
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        return None
    if isinstance(version, int) and not isinstance(version, bool):
        version = str(version)
    if not isinstance(version, str) or not version.strip():
        return None
    version = version.strip()
    if version.upper() == "DRAFT":
        version = "DRAFT"
    elif not version.isdigit():
        return None
    weight = 0
    if candidate:
        raw_weight = doc.get("weight", 0)
        if isinstance(raw_weight, bool) or not isinstance(raw_weight, (int, float)):
            return None
        weight = int(raw_weight)
        if weight < 0 or weight > 100:
            return None
    return Pointer(prompt_id=prompt_id.strip(), version=version, weight=weight)


@dataclass(frozen=True)
class PointerSet:
    live: Pointer | None
    candidate: Pointer | None

    def pick(self, rng: random.Random | None = None) -> tuple[Pointer | None, str]:
        """Choose an arm for ONE invocation: (pointer, arm label).

        The candidate wins with probability ``weight/100``; a missing live
        pointer never promotes the candidate to 100 % by accident — then only
        a candidate with weight 100 is served, else nothing (→ baked).
        """
        rng = rng or _rng
        cand = self.candidate
        if cand is not None and cand.weight > 0:
            if cand.weight >= 100 or rng.random() * 100 < cand.weight:
                return cand, ARM_CANDIDATE
        if self.live is not None:
            return self.live, ARM_LIVE
        return None, ""


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


class _PointerCache:
    """The parsed pointer set per path, TTL-refreshed; plus the text of every
    numbered (immutable) version fetched, for the life of the process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pointers: dict[str, tuple[PointerSet | None, float]] = {}
        self._texts: dict[tuple[str, str], ResolvedPrompt] = {}

    def get_pointers(self, path: str) -> tuple[bool, PointerSet | None]:
        """(hit, pointer_set). A cached ``None`` is a remembered read failure."""
        with self._lock:
            hit = self._pointers.get(path)
            if not hit:
                return False, None
            pointers, fetched_at = hit
            if time.monotonic() - fetched_at > REFRESH_S:
                return False, None
            return True, pointers

    def put_pointers(self, path: str, pointers: PointerSet | None) -> None:
        with self._lock:
            self._pointers[path] = (pointers, time.monotonic())

    def get_text(self, prompt_id: str, version: str) -> ResolvedPrompt | None:
        with self._lock:
            return self._texts.get((prompt_id, version))

    def put_text(self, prompt_id: str, version: str, resolved: ResolvedPrompt) -> None:
        with self._lock:
            if len(self._texts) > 64:
                self._texts.clear()
            self._texts[(prompt_id, version)] = resolved


_pointer_cache = _PointerCache()


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


def _get_prompt_text(prompt_id: str, version: str) -> tuple[str, str] | None:
    """GetPrompt for one id (+ numbered version); (text, version) or None."""
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


def _read_pointers(path: str) -> PointerSet:
    """One GetParameters for ``<path>/live`` and ``<path>/candidate``.

    A missing parameter is simply absent (``InvalidParameters``); any other
    failure raises, and the caller falls back to the baked literal.
    """
    live_name, cand_name = f"{path}/live", f"{path}/candidate"
    resp = _ssm().get_parameters(Names=[live_name, cand_name])
    values = {p.get("Name"): p.get("Value") for p in resp.get("Parameters", []) if p.get("Name")}
    live = parse_pointer(values.get(live_name))
    if live_name in values and live is None:
        log.warning("prompt_source: %s is malformed — treating as absent", live_name)
    candidate = parse_pointer(values.get(cand_name), candidate=True)
    if cand_name in values and candidate is None:
        log.warning("prompt_source: %s is malformed — treating as absent", cand_name)
    return PointerSet(live=live, candidate=candidate)


def _pointers(path: str) -> PointerSet | None:
    """Cached pointer set; ``None`` when the read failed (cached too, so an SSM
    outage costs one call per refresh interval, not one per invocation)."""
    hit, pointers = _pointer_cache.get_pointers(path)
    if hit:
        return pointers
    try:
        pointers = _read_pointers(path)
    except ClientError as exc:  # noqa: BLE001
        code = exc.response.get("Error", {}).get("Code", "?")
        log.warning("prompt_source: pointer %s unreadable (%s) — using baked prompt", path, code)
        pointers = None
    except Exception as exc:  # noqa: BLE001
        log.warning("prompt_source: pointer %s error (%s) — using baked prompt", path, exc)
        pointers = None
    _pointer_cache.put_pointers(path, pointers)
    return pointers


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

    path = pointer_path()
    if path:
        return _resolve_from_pointer(path, baked_resolved)

    prompt_name = name or default_prompt_name(agent_name)
    if not prompt_name:
        return baked_resolved

    if is_production() and not pinned_version():
        # DE-4: the DRAFT working copy is never production's source of truth.
        # Without a pointer or a numbered pin the fleet keeps its baked prompt
        # and says so, instead of serving an ungated studio edit.
        log.warning(
            "prompt_source: %s would read DRAFT under APP_ENV=production — refused; set "
            "SYSTEM_PROMPT_POINTER (promoted version) or SYSTEM_PROMPT_VERSION=<n>. Using baked prompt",
            prompt_name,
        )
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


def _resolve_from_pointer(path: str, baked_resolved: ResolvedPrompt) -> ResolvedPrompt:
    """The DE-4 path: pointer → (id, version) → cached text. Never lists prompts."""
    pointers = _pointers(path)
    if pointers is None:
        return baked_resolved

    pin = pinned_version()
    if pin:
        # A hard pin keeps the pointer's id and ignores its versions and weight.
        base = pointers.live or pointers.candidate
        if base is None:
            log.info("prompt_source: %s has no pointer to pin version %s onto — using baked prompt", path, pin)
            return baked_resolved
        chosen, arm = Pointer(prompt_id=base.prompt_id, version=pin), ARM_PINNED
    else:
        chosen, arm = pointers.pick()
        if chosen is None:
            log.info("prompt_source: %s has no live or candidate pointer — using baked prompt", path)
            return baked_resolved

    if chosen.version == "DRAFT" and is_production():
        log.warning(
            "prompt_source: %s/%s points at DRAFT under APP_ENV=production — refused; using baked prompt",
            path, arm,
        )
        return baked_resolved

    draft_key = f"{chosen.prompt_id}@DRAFT"
    cached = (_cache.get(draft_key) if chosen.version == "DRAFT"
              else _pointer_cache.get_text(chosen.prompt_id, chosen.version))
    if cached is not None:
        return cached if cached.arm == arm else ResolvedPrompt(
            text=cached.text, source=cached.source, version=cached.version, sha=cached.sha,
            prompt_id=cached.prompt_id, arm=arm,
        )

    try:
        found = _get_prompt_text(chosen.prompt_id, chosen.version)
    except ClientError as exc:  # noqa: BLE001
        code = exc.response.get("Error", {}).get("Code", "?")
        log.warning("prompt_source: GetPrompt %s@%s failed (%s) — using baked prompt",
                    chosen.prompt_id, chosen.version, code)
        found = None
    except Exception as exc:  # noqa: BLE001
        log.warning("prompt_source: GetPrompt %s@%s error (%s) — using baked prompt",
                    chosen.prompt_id, chosen.version, exc)
        found = None
    if found is None:
        # DRAFT is mutable, so a failed DRAFT read is not remembered past the
        # pointer TTL; a numbered version that cannot be read is remembered as
        # baked so an outage is not amplified per invocation.
        fallback = ResolvedPrompt(
            text=baked_resolved.text, source="baked", version="", sha=baked_resolved.sha,
            prompt_id=chosen.prompt_id, arm=arm,
        )
        if chosen.version != "DRAFT":
            _pointer_cache.put_text(chosen.prompt_id, chosen.version, fallback)
        else:
            _cache.put(draft_key, fallback)
        return fallback

    text, version = found
    resolved = ResolvedPrompt(
        text=text, source="bedrock", version=str(version), sha=prompt_sha(text),
        prompt_id=chosen.prompt_id, arm=arm,
    )
    leftover = unexpanded_variables(text)
    if leftover:
        log.warning(
            "prompt_source: %s@%s still contains unexpanded %s — system prompts are not "
            "parameterised on this path", chosen.prompt_id, version, ", ".join(leftover),
        )
    if chosen.version != "DRAFT":
        _pointer_cache.put_text(chosen.prompt_id, chosen.version, resolved)
    else:
        _cache.put(draft_key, resolved)
    log.info(
        "prompt_source: resolved %s/%s → %s@%s (sha=%s)",
        path, arm, chosen.prompt_id, version, resolved.sha,
    )
    return resolved


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
        # The AG-UI adapter wrapping ``_agent``, built on first streaming use
        # and discarded whenever the agent is rebuilt — an adapter holds a
        # reference to the Agent it wraps, so keeping a stale one would serve
        # the OLD system prompt to every streaming caller while the sync path
        # had already moved to the new one.
        self._ag_ui = None
        # DE-4: with a candidate pointer, consecutive invocations alternate
        # between two texts. Keeping the last few (agent, adapter) pairs by sha
        # means an arm switch is a dictionary lookup, not a rebuild per call.
        self._by_sha: dict[str, tuple[object, object | None]] = {}

    _KEEP = 4

    def get(self):
        """Return (agent, ResolvedPrompt) with the freshest prompt available."""
        resolved = resolve_system_prompt(
            self._baked, agent_name=self._agent_name, name=self._name
        )
        with self._lock:
            if self._agent is None or self._sha != resolved.sha:
                previous = self._sha
                if previous is not None and self._agent is not None:
                    self._by_sha[previous] = (self._agent, self._ag_ui)
                kept = self._by_sha.pop(resolved.sha, None)
                if kept is not None:
                    self._agent, self._ag_ui = kept
                else:
                    self._agent = self._build(resolved.text)
                    self._ag_ui = None
                while len(self._by_sha) > self._KEEP:
                    self._by_sha.pop(next(iter(self._by_sha)))
                self._sha = resolved.sha
                self._resolved = resolved
                if previous is not None:
                    log.info(
                        "prompt_source: system prompt changed (%s → %s, source=%s arm=%s) — agent %s",
                        previous, resolved.sha, resolved.source, resolved.arm or "-",
                        "reused" if kept is not None else "rebuilt",
                    )
            return self._agent, resolved

    def get_ag_ui(self, *, name: str):
        """Return (ag_ui_adapter, ResolvedPrompt) for streaming invocations.

        The adapter is cached beside the agent and invalidated with it, so a
        managed-prompt edit reaches the streaming path on the same refresh cycle
        as the synchronous one.

        ``ag_ui_strands`` is imported lazily and on purpose: this module is
        imported by the agent unit tests, which run in an environment that has
        botocore but not the AG-UI SDK, and a top-level import would make every
        one of them fail collection.
        """
        agent, resolved = self.get()
        with self._lock:
            if self._ag_ui is None:
                from ag_ui_strands import StrandsAgent, StrandsAgentConfig

                self._ag_ui = StrandsAgent(
                    agent=agent,
                    name=name,
                    config=StrandsAgentConfig(
                        emit_messages_snapshot=False,
                        replay_history_into_strands=True,
                    ),
                )
            return self._ag_ui, resolved


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

    @property
    def prompt_version_number(self) -> str:
        """The numbered Bedrock version serving the next run, or "" (DE-4)."""
        return self.resolved.version_number

    @property
    def prompt_arm(self) -> str:
        """"live" / "candidate" / "pinned" when a pointer chose the text (DE-4)."""
        return self.resolved.arm

    # ── agent behavior ─────────────────────────────────────────────────────
    def ag_ui(self, *, name: str):
        """The AG-UI adapter for this agent, tracking the live system prompt.

        Used by ``_shared/agui_stream.stream_agui`` so every agent emits the
        same token-by-token AG-UI event stream the supervisor does, instead of
        returning one JSON envelope the transport then has to guess at.
        """
        adapter, _ = self._prompted.get_ag_ui(name=name)
        return adapter

    def __call__(self, *args, **kwargs):
        agent, _ = self._prompted.get()
        return agent(*args, **kwargs)

    def __getattr__(self, item):
        # Only reached for attributes not defined on LiveAgent itself.
        agent, _ = self._prompted.get()
        return getattr(agent, item)


def reset_cache() -> None:
    """Test hook — drop all cached resolutions (names, pointers and texts)."""
    global _cache, _pointer_cache
    _cache = _Cache()
    _pointer_cache = _PointerCache()


def trace_attributes(resolved: ResolvedPrompt | None) -> dict[str, str]:
    """The DE-4 span attributes for a resolved prompt, beside the sha.

    ``orgiq.prompt_version_number`` is the Bedrock version ("7"); ``orgiq.prompt_arm``
    is which pointer arm served it. Both are omitted when unknown, so the
    name-lookup and baked paths add nothing.
    """
    if resolved is None:
        return {}
    attrs: dict[str, str] = {}
    if resolved.version_number:
        attrs["orgiq.prompt_version_number"] = resolved.version_number
    if resolved.arm:
        attrs["orgiq.prompt_arm"] = resolved.arm
    return attrs
