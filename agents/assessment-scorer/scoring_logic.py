"""Deterministic logic backing the assessment-scorer's two tools.

Kept dependency-free (stdlib only) and separate from ``main.py`` so it can be
unit tested without pulling in ``strands``/``bedrock_agentcore``/``boto3`` —
those are only needed to actually run the agent, not to verify the scoring
guardrails.

This module is the code-side half of the scoring stance carried over from
``agentic-assessment-accelerator``'s CLAUDE.md (§4 evidence integrity, §6
scoring calibration, §7 PII scrubbing). The agent's system prompt asks the
model to follow the same rules; this module is what actually enforces the
ones that can be enforced mechanically:

* score only dimensions the caller flagged as relevant
* confidence is exactly ``low`` / ``moderate`` / ``high`` (``medium`` is a
  legacy spelling that gets normalised, never emitted)
* a dimension supported only by self-reported (``attested``) evidence never
  verifies past level 3 — the "self-rating caps at 3" rule
* level 4+ requires at least one ``observed``-class evidence item
* every excerpt the model wants to quote must be a verbatim substring of one
  of the evidence texts it cited — a fabricated quote is dropped, not trusted
* rationale text has team-side participant names (heuristically, from
  transcript "Speaker:" labels) replaced with a role-neutral label before it
  leaves this function, per the source's PII-scrubbing rule
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# ── Dimension table (assessment-tenant.md) ─────────────────────────────────

DIMENSION_TITLES: dict[str, str] = {
    "1": "Continuous Integration (CI)",
    "2": "Continuous Delivery (CD)",
    "3": "Automation",
    "4": "Source Control & Traceability",
    "5": "Testing & QE – Automated Testing",
    "6": "Testing & QE – Security Testing",
    "7": "Testing & QE – Performance & Reliability Testing",
    "8": "Security Control SDLC & Code Review Practices",
    "9": "Engineering Governance",
    "10": "Monitoring, Observability & Runtime Security",
    "11": "Environment Management",
    "12": "Release Management & Operational Reliability",
    "13": "Platform Reusability & Patterns",
    "14": "Software Development Mindset & Automation Culture",
    "15": "Agile Planning & Backlog Management",
    "16": "Design Standards & Technical Decision Process",
    "17": "Engineering Metrics & Continuous Improvement",
}

# Coarse keyword heuristic used only for the first-pass classification —
# the agent's own reasoning may add dimensions the keywords miss, but this
# grounds relevant_dimension_ids in something reproducible.
_DIMENSION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "1": ("continuous integration", " ci ", "ci pipeline", "build pipeline", "merge gate", "pull request check"),
    "2": ("continuous delivery", " cd ", "deployment pipeline", "release automation", "deploy on"),
    "3": ("automation", "automated script", "automate"),
    "4": ("source control", "version control", "git ", "branching", "traceability", "commit history"),
    "5": ("unit test", "integration test", "test coverage", "automated testing", " qe "),
    "6": ("security testing", "penetration test", "sast", "dast", "vulnerability scan"),
    "7": ("performance test", "load test", "reliability test", "chaos test", "stress test"),
    "8": ("code review", "pull request review", "security control", "sdlc security"),
    "9": ("governance", "compliance", "audit", "engineering policy"),
    "10": ("monitoring", "observability", "dashboard", "alerting", "runtime security", "logging"),
    "11": ("environment management", "staging environment", "environment parity", "infrastructure as code"),
    "12": ("release management", "incident", "rollback", " sla ", "operational reliability", "on-call"),
    "13": ("platform reusability", "reusable component", "shared library", "design pattern", "template library"),
    "14": ("engineering culture", "automation culture", "development mindset"),
    "15": ("agile planning", "backlog", "sprint planning", "scrum", "kanban"),
    "16": ("design standard", "architecture decision", "adr", "technical decision", "design review"),
    "17": ("engineering metrics", " kpi ", "continuous improvement", "retrospective", "dora metric"),
}

# ── Evidence classes (CLAUDE.md §6) ────────────────────────────────────────

CLASS_ANCHOR: dict[str, float] = {"attested": 0.3, "documented": 0.5, "observed": 0.9}

# Evidence.source_type (assessment-tenant.md) -> evidence class.
_SOURCE_TYPE_CLASS: dict[str, str] = {
    "survey": "attested",
    "transcript": "attested",
    "document": "documented",
    "artifact": "observed",
}

_CONFIDENCE_BANDS = ("low", "moderate", "high")

_SPEAKER_LABEL_RE = re.compile(r"^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}):\s", re.MULTILINE)
_ROLE_WORDS = {
    "Interviewer", "Facilitator", "Note", "Summary", "Q", "A", "Team",
    "Moderator", "Speaker", "Narrator", "Host",
}


def normalize_confidence(raw: Any) -> str:
    """Normalise to exactly ``low`` / ``moderate`` / ``high``.

    ``"medium"`` (a legacy slip the source engine tolerates but never emits)
    normalises to ``"moderate"``. Anything else unrecognised — wrong type,
    unknown word — is treated as unsupported and defaults to the most
    conservative band, ``"low"``, rather than trusting an unvalidated value.
    """
    if not isinstance(raw, str):
        return "low"
    value = raw.strip().lower()
    if value == "medium":
        value = "moderate"
    return value if value in _CONFIDENCE_BANDS else "low"


def _lower_band(confidence: str) -> str:
    idx = _CONFIDENCE_BANDS.index(confidence) if confidence in _CONFIDENCE_BANDS else 0
    return _CONFIDENCE_BANDS[max(0, idx - 1)]


def evidence_class_for(source_type: Any) -> str:
    if isinstance(source_type, str) and source_type in _SOURCE_TYPE_CLASS:
        return _SOURCE_TYPE_CLASS[source_type]
    return "attested"


def extract_participant_names(texts: Iterable[str]) -> set[str]:
    """Heuristically pull "Speaker:" labels out of transcript-shaped text.

    Used only to scrub team-side participant names out of rationale text
    (CLAUDE.md §7) — never to identify anyone in a durable field.
    """
    names: set[str] = set()
    for text in texts:
        if not isinstance(text, str):
            continue
        for match in _SPEAKER_LABEL_RE.finditer(text):
            label = match.group(1).strip()
            if label and label not in _ROLE_WORDS:
                names.add(label)
    return names


def scrub_names(text: str, names: Iterable[str]) -> str:
    """Replace each name (whole-word match) with a role-neutral label."""
    if not isinstance(text, str) or not text:
        return text
    scrubbed = text
    for name in sorted({n for n in names if n}, key=len, reverse=True):
        scrubbed = re.sub(r"\b" + re.escape(name) + r"\b", "a team member", scrubbed)
    return scrubbed


def classify_evidence_impl(text: str) -> dict:
    """First-pass, deterministic classification of one evidence item's text."""
    text = text or ""
    length = len(text)
    lower = f" {text.lower()} "

    speaker_labels = {
        m.group(1).strip()
        for m in _SPEAKER_LABEL_RE.finditer(text)
        if m.group(1).strip() not in _ROLE_WORDS
    }

    if len(speaker_labels) >= 2:
        evidence_type = "stakeholder_interview" if length >= 1500 else "meeting"
    elif "self-rating" in lower or "self rating" in lower or re.search(r"\bsurvey\b", lower):
        evidence_type = "survey"
    elif re.search(r"^\s*q[:.]", text, re.IGNORECASE | re.MULTILINE) and re.search(
        r"^\s*a[:.]", text, re.IGNORECASE | re.MULTILINE
    ):
        evidence_type = "assessment_qa"
    elif length > 0:
        evidence_type = "document"
    else:
        evidence_type = "other"

    if length >= 3000:
        weight = "high"
    elif length >= 800:
        weight = "medium"
    else:
        weight = "low"

    relevant_dimension_ids = [
        dim_id
        for dim_id, keywords in _DIMENSION_KEYWORDS.items()
        if any(kw in lower for kw in keywords)
    ]
    # Keep numeric ordering ("1".."17", not lexicographic "1","10","11"...).
    relevant_dimension_ids.sort(key=int)

    informs = [DIMENSION_TITLES[d] for d in relevant_dimension_ids]

    return {
        "evidence_type": evidence_type,
        "weight": weight,
        "weight_reason": f"{evidence_type.replace('_', ' ')}, {length} characters.",
        "informs": informs,
        "relevant_dimension_ids": relevant_dimension_ids,
        "action_items": [],
        "summary": (
            f"Evidence classified as {evidence_type.replace('_', ' ')} "
            f"({length} characters); touches {len(relevant_dimension_ids)} dimension(s)."
        ),
        "length_chars": length,
    }


def score_dimension_impl(
    *,
    dimension_id: str,
    evidence_ids: list,
    evidence_items: list,
    proposed_level: int,
    confidence: Any,
    rationale: str,
    relevant_dimension_ids: list | None = None,
    evidence_excerpts: list | None = None,
    follow_up_questions: list | None = None,
    self_claimed_level: int | None = None,
) -> dict:
    """Validate + enforce one proposed dimension score.

    ``dimension_id`` and ``evidence_ids`` are the model's claim; this function
    is the deterministic gate the same way the source's ``assess apply-scores``
    verb is — except here it runs inside the agent, because this agent never
    persists at all (the middleware's own deterministic apply step is the
    actual persistence gate downstream of this).
    """
    dimension_id = str(dimension_id)
    evidence_excerpts = list(evidence_excerpts or [])
    follow_up_questions = list(follow_up_questions or [])
    evidence_items = evidence_items or []

    if relevant_dimension_ids is not None and dimension_id not in {str(d) for d in relevant_dimension_ids}:
        return {
            "dimension_id": dimension_id,
            "refused": True,
            "refusal_reason": (
                f"dimension {dimension_id} is not in relevant_dimension_ids "
                f"({sorted(relevant_dimension_ids, key=str)}) — refusing to score it"
            ),
        }

    by_id = {str(item.get("id")): item for item in evidence_items if isinstance(item, dict)}
    referenced = [by_id[str(eid)] for eid in (evidence_ids or []) if str(eid) in by_id]
    referenced_texts = [item.get("text", "") for item in referenced]

    classes_present = {evidence_class_for(item.get("source_type")) for item in referenced}
    if not classes_present:
        classes_present = {"attested"}
    strongest_class = max(classes_present, key=lambda c: CLASS_ANCHOR[c])

    try:
        level = int(proposed_level)
    except (TypeError, ValueError):
        level = 0

    cap_applied = False
    # Level 4+ requires Observed evidence — this is also the mechanical form
    # of "a self-rating-only dimension caps at 3": when every referenced item
    # is Attested (or there is no evidence at all), "observed" can never be
    # in classes_present, so the cap fires the same way.
    if level >= 4 and "observed" not in classes_present:
        level = 3
        cap_applied = True

    normalized_confidence = normalize_confidence(confidence)

    valid_excerpts: list[str] = []
    excerpt_dropped = False
    for excerpt in evidence_excerpts:
        if isinstance(excerpt, str) and excerpt and any(excerpt in text for text in referenced_texts if isinstance(text, str)):
            valid_excerpts.append(excerpt)
        else:
            excerpt_dropped = True
    if excerpt_dropped:
        normalized_confidence = _lower_band(normalized_confidence)

    participant_names = extract_participant_names(referenced_texts)
    scrubbed_rationale = scrub_names(rationale or "", participant_names)

    return {
        "dimension_id": dimension_id,
        "refused": False,
        "current_level": level,
        "confidence": normalized_confidence,
        "evidence_class": strongest_class,
        "cap_applied": cap_applied,
        "rationale": scrubbed_rationale,
        "evidence_excerpts": valid_excerpts,
        "follow_up_questions": follow_up_questions,
        "self_claimed_level": self_claimed_level,
    }
