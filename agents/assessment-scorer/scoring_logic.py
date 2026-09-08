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

Envelope discipline
-------------------
This agent never persists; the middleware's ``applyScores``
(``middleware/src/providers/assessment.ts``) is the real persistence gate and
it *refuses* a malformed entry outright. Everything that gate rejects is
refused here too, at the source, so the agent never emits an envelope that
cannot be applied:

* ``dimension_id`` outside "1".."17"
* ``proposed_level`` that is not an integer 0..5 (a fractional level is
  almost always a confidence score passed by mistake — it is refused, never
  truncated into a plausible-looking level)
* ``self_claimed_level`` outside 0..5 (an unbounded claim rendered
  "Claimed Level 99" downstream)
* a blank/missing ``rationale`` — a score with no stated reason has no audit
  trail, and emitting one is exactly the "plausible score it did not derive"
  failure this module exists to prevent
* ``follow_up_questions`` entries that are not non-empty strings (these used
  to 500 the run-completion callback downstream)

and two honesty rules that have no downstream equivalent because only this
side can see the evidence array:

* a dimension with **no resolvable evidence at all** can never be emitted
  above ``low`` confidence, no matter what the model asked for
* citing an ``evidence_id`` that is not in ``evidence_items`` costs one
  confidence band, the same as a fabricated excerpt, and the dangling ids are
  reported in ``unverified_evidence_ids`` rather than silently ignored
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

#: The rubric has six levels, 0..5 (docs/assessment-tenant.md). Mirrors
#: RUBRIC_MAX_LEVEL in middleware/src/providers/assessment.ts.
RUBRIC_MAX_LEVEL = 5

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


def coerce_rubric_level(value: Any) -> int | None:
    """``value`` as a rubric level 0..5, or None when it is not one.

    Accepts an ``int``, an integral ``float`` (``4.0``) and a string spelling
    of either (``"4"``, ``"4.0"``) — models routinely produce all three for a
    field typed ``int``, and normalising them is reading what was written, not
    inventing it. Everything else is None: a *fractional* level (``3.7``, the
    classic "confidence passed into the level field" slip), a bool, a bare
    word, or anything outside 0..5. None is a refusal signal, never a level.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        level = value
    elif isinstance(value, float):
        if not value.is_integer():
            return None
        level = int(value)
    elif isinstance(value, str):
        try:
            parsed = float(value.strip())
        except (TypeError, ValueError):
            return None
        if not parsed.is_integer():
            return None
        level = int(parsed)
    else:
        return None
    return level if 0 <= level <= RUBRIC_MAX_LEVEL else None


def valid_follow_up_questions(questions: Any) -> list[str]:
    """Keep only the non-empty strings.

    A follow-up question becomes a wire-shaped string on the scorecard;
    downstream, a non-string one used to raise inside the idempotency key
    (``normalizeQuestion(...).toLowerCase()``) and 500 the run-completion
    callback, leaving the run `running` forever. Dropping the malformed entry
    keeps the score — which may be perfectly well derived — applicable.
    """
    if not isinstance(questions, (list, tuple)):
        return []
    return [q for q in questions if isinstance(q, str) and q.strip()]


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
    evidence_items = evidence_items or []

    def _refuse(reason: str) -> dict:
        return {"dimension_id": dimension_id, "refused": True, "refusal_reason": reason}

    # ── Refusals: an envelope the persistence gate would reject is not worth
    # emitting, and a score the agent cannot justify is not worth emitting
    # either. Both are refused here rather than downstream.
    if dimension_id not in DIMENSION_TITLES:
        return _refuse(
            f'unknown dimension id "{dimension_id}" — the rubric has 17 dimensions, "1".."17"'
        )

    if relevant_dimension_ids is not None and dimension_id not in {str(d) for d in relevant_dimension_ids}:
        return _refuse(
            f"dimension {dimension_id} is not in relevant_dimension_ids "
            f"({sorted(relevant_dimension_ids, key=str)}) — refusing to score it"
        )

    level = coerce_rubric_level(proposed_level)
    if level is None:
        return _refuse(
            f"proposed_level {proposed_level!r} is not a whole rubric level 0..{RUBRIC_MAX_LEVEL} "
            "— refusing to guess which level was meant"
        )

    if self_claimed_level is not None:
        claimed = coerce_rubric_level(self_claimed_level)
        if claimed is None:
            return _refuse(
                f"self_claimed_level {self_claimed_level!r} is not a whole rubric level "
                f"0..{RUBRIC_MAX_LEVEL} — refusing to report a claim it cannot read"
            )
        self_claimed_level = claimed

    if not isinstance(rationale, str) or not rationale.strip():
        return _refuse(
            "rationale is required — a score with no stated reason has no audit trail"
        )

    follow_up_questions = valid_follow_up_questions(follow_up_questions)

    by_id = {str(item.get("id")): item for item in evidence_items if isinstance(item, dict)}
    cited_ids = [str(eid) for eid in (evidence_ids or [])]
    referenced = [by_id[eid] for eid in cited_ids if eid in by_id]
    referenced_texts = [item.get("text", "") for item in referenced]
    # Ids the model cited that are not in the evidence array it was handed.
    # Reported, not silently ignored — a citation to nothing is the cheapest
    # way to make an unsupported level look supported.
    unverified_evidence_ids = [eid for eid in cited_ids if eid not in by_id]

    classes_present = {evidence_class_for(item.get("source_type")) for item in referenced}
    if not classes_present:
        classes_present = {"attested"}
    strongest_class = max(classes_present, key=lambda c: CLASS_ANCHOR[c])

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
    # A citation to an id that isn't in the evidence array is the same class
    # of unverifiable claim as a quote that isn't in the text.
    if unverified_evidence_ids:
        normalized_confidence = _lower_band(normalized_confidence)
    # Nothing resolved at all: whatever the level, it rests on no evidence
    # this function can see, so it cannot be reported above "low".
    if not referenced:
        normalized_confidence = "low"

    participant_names = extract_participant_names(referenced_texts)
    scrubbed_rationale = scrub_names(rationale, participant_names)

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
        "unverified_evidence_ids": unverified_evidence_ids,
    }
