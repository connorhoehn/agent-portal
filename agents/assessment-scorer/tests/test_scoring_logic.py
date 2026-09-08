"""Unit tests for the assessment-scorer's deterministic scoring gate.

Pure stdlib + pytest — no strands/bedrock_agentcore/boto3 needed, since the
guardrails under test live in scoring_logic.py, not main.py. Run from this
directory:

    python3.12 -m pytest -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring_logic import (  # noqa: E402
    classify_evidence_impl,
    normalize_confidence,
    score_dimension_impl,
)


def _evidence(id_, source_type, text):
    return {"id": id_, "source_type": source_type, "text": text}


def test_fabricated_quote_is_dropped_and_confidence_lowered():
    items = [_evidence("e1", "document", "We run unit tests on every pull request.")]
    result = score_dimension_impl(
        dimension_id="1",
        evidence_ids=["e1"],
        evidence_items=items,
        proposed_level=3,
        confidence="high",
        rationale="The team runs tests on every PR.",
        evidence_excerpts=["We absolutely never break the build, ever"],  # not in the text
    )
    assert result["evidence_excerpts"] == []
    # high -> moderate: one band down because the excerpt didn't verify.
    assert result["confidence"] == "moderate"


def test_verbatim_excerpt_survives():
    text = "We run unit tests on every pull request but integration tests are manual."
    items = [_evidence("e1", "document", text)]
    result = score_dimension_impl(
        dimension_id="1",
        evidence_ids=["e1"],
        evidence_items=items,
        proposed_level=3,
        confidence="high",
        rationale="Matches the runbook.",
        evidence_excerpts=["We run unit tests on every pull request"],
    )
    assert result["evidence_excerpts"] == ["We run unit tests on every pull request"]
    assert result["confidence"] == "high"


def test_medium_normalises_to_moderate():
    assert normalize_confidence("medium") == "moderate"
    assert normalize_confidence("Medium") == "moderate"
    assert normalize_confidence("MODERATE") == "moderate"
    assert normalize_confidence("high") == "high"
    assert normalize_confidence("nonsense") == "low"
    assert normalize_confidence(None) == "low"


def test_dimension_outside_relevant_ids_is_refused():
    result = score_dimension_impl(
        dimension_id="5",
        evidence_ids=[],
        evidence_items=[],
        proposed_level=2,
        confidence="low",
        rationale="n/a",
        relevant_dimension_ids=["1", "2"],
    )
    assert result["refused"] is True
    assert "5" in result["refusal_reason"]
    assert "current_level" not in result


def test_self_rating_only_caps_at_3():
    # Only Attested-class evidence (a survey answer / self-rating claim) —
    # verification cannot reach level 4 no matter how confidently claimed.
    items = [_evidence("e1", "survey", "We are Advanced at deployment automation.")]
    result = score_dimension_impl(
        dimension_id="2",
        evidence_ids=["e1"],
        evidence_items=items,
        proposed_level=4,
        confidence="high",
        rationale="The team self-rated Advanced.",
        self_claimed_level=4,
    )
    assert result["current_level"] == 3
    assert result["cap_applied"] is True


def test_level_4_with_observed_evidence_is_not_capped():
    items = [_evidence("e1", "artifact", "Pipeline run history shows nightly canary deploys with automated rollback.")]
    result = score_dimension_impl(
        dimension_id="2",
        evidence_ids=["e1"],
        evidence_items=items,
        proposed_level=4,
        confidence="high",
        rationale="Pipeline history demonstrates the practice.",
    )
    assert result["current_level"] == 4
    assert result["cap_applied"] is False
    assert result["evidence_class"] == "observed"


def test_pii_scrub_replaces_speaker_labels_in_rationale():
    transcript = (
        "Jane Smith: We deploy every day.\n"
        "Bob Lee: And we roll back automatically if health checks fail.\n"
    )
    items = [_evidence("e1", "transcript", transcript)]
    result = score_dimension_impl(
        dimension_id="2",
        evidence_ids=["e1"],
        evidence_items=items,
        proposed_level=2,
        confidence="low",
        rationale="Jane Smith said the team deploys every day, and Bob Lee described automatic rollback.",
    )
    assert "Jane Smith" not in result["rationale"]
    assert "Bob Lee" not in result["rationale"]
    assert "a team member" in result["rationale"]


def test_classify_evidence_survey_and_dimension_hint():
    text = "Self-rating: We are Established at continuous integration and run CI on every commit."
    result = classify_evidence_impl(text)
    assert result["evidence_type"] == "survey"
    assert "1" in result["relevant_dimension_ids"]
    assert result["length_chars"] == len(text)
