"""Deterministic guardrails backing the assessment-drafter agent.

Kept dependency-free (stdlib only) and separate from ``main.py`` so it can be
unit tested without pulling in ``strands``/``bedrock_agentcore``/``boto3``.

Two jobs, carried over from the source product's CLAUDE.md §9 (never promise
a level, never estimate human effort) and §4/§7 (no fabrication, verbatim
excerpts, PII scrubbing):

* ``scrub_forbidden_promises`` — a code-level backstop over the story
  drafter's output. The system prompt already instructs the model never to
  promise a level or estimate effort; this function additionally redacts any
  sentence that slips through, so the rule holds even if the model doesn't
  follow it.
* ``validate_context_fact`` — the same verbatim-excerpt discipline the
  scorer applies to evidence, applied here to a governance fact's
  ``source_span``: it must be a real substring of the source document, or the
  fact is dropped rather than trusted.
"""

from __future__ import annotations

import re
from typing import Any

# ── Story drafts: never promise a level, never estimate effort ────────────

# "moves/advances/brings/guarantees/ensures/achieves/confirms ... Level N" —
# deliberately narrower than "confirm Level N", which the source explicitly
# allows ("this is what we would need to confirm Level 3").
_LEVEL_PROMISE_RE = re.compile(
    r"\b(?:moves?|move[sd]?|advances?|elevates?|upgrades?|brings?|guarantees?|ensures?|achieves?|will\s+reach|gets?\s+(?:you|the\s+team)\s+to)\b"
    r"[^.\n]{0,60}?\bLevel\s*\d\b",
    re.IGNORECASE,
)

_EFFORT_ESTIMATE_RE = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:story\s*points?|sp|pts?)\b"
    r"|\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|days?|weeks?)\b"
    r"|\bquick\s*win\b"
    r"|\btarget\s*sprint\b",
    re.IGNORECASE,
)


def find_forbidden_phrases(text: str) -> list[str]:
    """Every level-promise or effort-estimate phrase found in ``text``."""
    if not isinstance(text, str) or not text:
        return []
    return [m.group(0) for m in _LEVEL_PROMISE_RE.finditer(text)] + [
        m.group(0) for m in _EFFORT_ESTIMATE_RE.finditer(text)
    ]


def scrub_forbidden_promises(text: str) -> tuple[str, list[str]]:
    """Redact any level-promise / effort-estimate phrase.

    Returns (scrubbed_text, violations) — violations is the list of raw
    matched phrases, for the caller to log or surface; the text itself has
    each one replaced with a marker rather than silently disappearing, so a
    reviewer can see where content needs to be rewritten by hand.
    """
    if not isinstance(text, str) or not text:
        return text, []

    violations = find_forbidden_phrases(text)
    if not violations:
        return text, []

    scrubbed = _LEVEL_PROMISE_RE.sub("[NEEDS INPUT: remove level promise]", text)
    scrubbed = _EFFORT_ESTIMATE_RE.sub("[NEEDS INPUT: remove effort estimate]", scrubbed)
    return scrubbed, violations


# ── Enterprise context facts: verbatim source_span ─────────────────────────

_VALID_CATEGORIES = {"standards", "process", "organization", "tooling"}
_VALID_SCOPES = {"shared", "team"}
_VALID_FACT_TYPES = {"observed", "gap", "recommendation"}


def validate_context_fact(fact: dict, source_text: str) -> dict | None:
    """Validate + normalise one extracted fact against the source document.

    Returns the fact unchanged (aside from vocabulary normalisation) if
    valid, or None if it must be dropped: unknown category/scope/fact_type,
    or a source_span that is not a verbatim substring of source_text (the
    same "no fabrication" discipline the scorer applies to evidence
    excerpts, applied here to extracted governance facts).
    """
    if not isinstance(fact, dict):
        return None

    category = fact.get("category")
    scope = fact.get("scope")
    fact_type = fact.get("fact_type")
    source_span = fact.get("source_span")
    text = fact.get("text")

    if category not in _VALID_CATEGORIES:
        return None
    if scope not in _VALID_SCOPES:
        return None
    if fact_type not in _VALID_FACT_TYPES:
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    if not isinstance(source_span, str) or not source_span or not isinstance(source_text, str):
        return None
    if source_span not in source_text:
        return None

    return {
        "category": category,
        "scope": scope,
        "fact_type": fact_type,
        "text": text,
        "source_span": source_span,
    }


def validate_context_facts(facts: list, source_text: str) -> list[dict]:
    """Filter a list of candidate facts down to the ones that verify."""
    out: list[dict] = []
    for fact in facts or []:
        validated = validate_context_fact(fact, source_text)
        if validated is not None:
            out.append(validated)
    return out
