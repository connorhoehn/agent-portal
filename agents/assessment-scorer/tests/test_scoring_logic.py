"""Unit tests for the assessment-scorer's deterministic scoring gate.

Pure stdlib — no strands/bedrock_agentcore/boto3 needed, since the guardrails
under test live in scoring_logic.py, not main.py. Nothing here touches the
network or Bedrock. Run from the agent directory, the same command every
other suite in this repo uses:

    cd agents/assessment-scorer && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'

(This file was pytest-only until 2026-09; pytest is not installed in the
synth venv and cannot be, so the suite never ran. See tests/__init__.py.)

What this pins, in two groups:

*   the scoring stance itself — the self-rating cap, the Observed-evidence
    requirement for level 4, verbatim excerpts, PII scrubbing;
*   **envelope honesty** — this agent never persists, so its only product is
    a JSON envelope, and the middleware's ``applyScores``
    (middleware/src/providers/assessment.ts) refuses a malformed one. Every
    shape that gate rejects is asserted to be refused *here*, at the source,
    plus two rules only this side can enforce because only this side sees the
    evidence array: a level resting on no resolvable evidence can never be
    reported above "low" confidence, and a citation to an evidence id that
    does not exist is reported rather than silently ignored.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring_logic import (  # noqa: E402
    DIMENSION_TITLES,
    classify_evidence_impl,
    coerce_rubric_level,
    normalize_confidence,
    score_dimension_impl,
    valid_follow_up_questions,
)


def _evidence(id_, source_type, text):
    return {"id": id_, "source_type": source_type, "text": text}


def _score(**overrides):
    """A well-formed proposal, so each test can vary exactly one thing."""
    kwargs = {
        "dimension_id": "1",
        "evidence_ids": ["e1"],
        "evidence_items": [_evidence("e1", "document", "We run unit tests on every pull request.")],
        "proposed_level": 3,
        "confidence": "moderate",
        "rationale": "The runbook describes tests on every pull request.",
    }
    kwargs.update(overrides)
    return score_dimension_impl(**kwargs)


class ScoringStance(unittest.TestCase):
    """The rules carried over verbatim from the source product."""

    def test_fabricated_quote_is_dropped_and_confidence_lowered(self):
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
        self.assertEqual(result["evidence_excerpts"], [])
        # high -> moderate: one band down because the excerpt didn't verify.
        self.assertEqual(result["confidence"], "moderate")

    def test_verbatim_excerpt_survives(self):
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
        self.assertEqual(result["evidence_excerpts"], ["We run unit tests on every pull request"])
        self.assertEqual(result["confidence"], "high")

    def test_medium_normalises_to_moderate(self):
        for raw, expected in (
            ("medium", "moderate"),
            ("Medium", "moderate"),
            ("MODERATE", "moderate"),
            ("high", "high"),
            ("nonsense", "low"),
            (None, "low"),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(normalize_confidence(raw), expected)

    def test_dimension_outside_relevant_ids_is_refused(self):
        result = score_dimension_impl(
            dimension_id="5",
            evidence_ids=[],
            evidence_items=[],
            proposed_level=2,
            confidence="low",
            rationale="n/a",
            relevant_dimension_ids=["1", "2"],
        )
        self.assertIs(result["refused"], True)
        self.assertIn("5", result["refusal_reason"])
        self.assertNotIn("current_level", result)

    def test_self_rating_only_caps_at_3(self):
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
        self.assertEqual(result["current_level"], 3)
        self.assertIs(result["cap_applied"], True)

    def test_level_4_with_observed_evidence_is_not_capped(self):
        items = [_evidence(
            "e1", "artifact",
            "Pipeline run history shows nightly canary deploys with automated rollback.",
        )]
        result = score_dimension_impl(
            dimension_id="2",
            evidence_ids=["e1"],
            evidence_items=items,
            proposed_level=4,
            confidence="high",
            rationale="Pipeline history demonstrates the practice.",
        )
        self.assertEqual(result["current_level"], 4)
        self.assertIs(result["cap_applied"], False)
        self.assertEqual(result["evidence_class"], "observed")

    def test_pii_scrub_replaces_speaker_labels_in_rationale(self):
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
            rationale=(
                "Jane Smith said the team deploys every day, and Bob Lee described "
                "automatic rollback."
            ),
        )
        self.assertNotIn("Jane Smith", result["rationale"])
        self.assertNotIn("Bob Lee", result["rationale"])
        self.assertIn("a team member", result["rationale"])

    def test_classify_evidence_survey_and_dimension_hint(self):
        text = (
            "Self-rating: We are Established at continuous integration and run CI "
            "on every commit."
        )
        result = classify_evidence_impl(text)
        self.assertEqual(result["evidence_type"], "survey")
        self.assertIn("1", result["relevant_dimension_ids"])
        self.assertEqual(result["length_chars"], len(text))

    def test_classify_evidence_on_empty_text_claims_nothing(self):
        """No text is no signal: no dimensions, lowest weight, "other"."""
        result = classify_evidence_impl("")
        self.assertEqual(result["evidence_type"], "other")
        self.assertEqual(result["weight"], "low")
        self.assertEqual(result["relevant_dimension_ids"], [])
        self.assertEqual(result["informs"], [])
        self.assertEqual(result["length_chars"], 0)


class RefusesAnEnvelopeThatCannotBeApplied(unittest.TestCase):
    """Everything middleware ``applyScores`` rejects is refused at the source.

    Each case names the downstream rejection it mirrors. The point is not
    redundancy — it is that the agent should never *produce* one of these, so
    a bad envelope shows up as an explicit refusal in the agent's own trace
    rather than as a rejected entry in a run nobody is watching.
    """

    def assertRefused(self, result, *, contains=None):
        self.assertIs(result["refused"], True, msg=f"expected a refusal, got {result}")
        # A refusal carries no level: there must be nothing downstream can
        # mistake for a score.
        self.assertNotIn("current_level", result)
        self.assertNotIn("confidence", result)
        self.assertTrue(result["refusal_reason"].strip())
        if contains is not None:
            self.assertIn(contains, result["refusal_reason"])

    def test_unknown_dimension_id_is_refused(self):
        # applyScores: 'unknown dimension id "..." — must be "1".."17"'
        for bad in ("0", "18", "99", "DIM-01", "", "one"):
            with self.subTest(dimension_id=bad):
                self.assertRefused(_score(dimension_id=bad, relevant_dimension_ids=None))

    def test_every_real_dimension_id_is_accepted(self):
        for dim in DIMENSION_TITLES:
            with self.subTest(dimension_id=dim):
                self.assertIs(_score(dimension_id=dim)["refused"], False)

    def test_level_outside_the_rubric_is_refused_not_clamped(self):
        # applyScores: 'suggested_level N exceeds the rubric max (5)'.
        # Clamping would turn a nonsense proposal into a plausible level.
        for bad in (6, 9, 99, -1):
            with self.subTest(proposed_level=bad):
                self.assertRefused(_score(proposed_level=bad), contains="proposed_level")

    def test_fractional_level_is_refused_not_truncated(self):
        # applyScores: 'suggested_level 3.7 must be an integer' — "almost
        # certainly means an agent passed a confidence by mistake". int(3.7)
        # would have silently emitted a confident-looking Level 3.
        self.assertRefused(_score(proposed_level=3.7), contains="proposed_level")
        self.assertRefused(_score(proposed_level="0.85"), contains="proposed_level")

    def test_unparseable_level_is_refused_not_defaulted_to_zero(self):
        # Defaulting to 0 invents "Below Baseline" — a real, damaging verdict —
        # out of a field the model failed to fill.
        for bad in (None, "high", "three", [], {}, True):
            with self.subTest(proposed_level=bad):
                self.assertRefused(_score(proposed_level=bad), contains="proposed_level")

    def test_integral_level_spellings_are_read_not_refused(self):
        for raw in (4, 4.0, "4", " 4 ", "4.0"):
            with self.subTest(proposed_level=raw):
                result = _score(
                    proposed_level=raw,
                    evidence_items=[_evidence("e1", "artifact", "Dashboards show DORA metrics.")],
                )
                self.assertIs(result["refused"], False)
                self.assertEqual(result["current_level"], 4)

    def test_self_claimed_level_outside_the_rubric_is_refused(self):
        # applyScores: 'self_claimed_level 99 must be an integer 0..5' — an
        # unbounded claim rendered "Claimed Level 99" with a gap of 97.
        for bad in (99, -1, 6, 2.5, "advanced", True):
            with self.subTest(self_claimed_level=bad):
                self.assertRefused(_score(self_claimed_level=bad), contains="self_claimed_level")

    def test_absent_self_claim_stays_absent(self):
        """None means "no self-rating appears in the evidence" — not zero."""
        self.assertIsNone(_score(self_claimed_level=None)["self_claimed_level"])

    def test_blank_rationale_is_refused(self):
        # applyScores: 'rationale is required — a score with no stated reason
        # has no audit trail'. This is the headline failure mode: a level with
        # nothing behind it is a score the agent did not derive.
        for bad in ("", "   ", "\n\t", None, 42, ["reasons"]):
            with self.subTest(rationale=bad):
                self.assertRefused(_score(rationale=bad), contains="rationale")

    def test_malformed_follow_up_questions_are_dropped_not_emitted(self):
        # applyScores: 'follow_up_questions[i] must be a non-empty string'.
        # Downstream a non-string used to raise inside the idempotency key and
        # 500 the run-completion callback, wedging the run at `running`.
        result = _score(follow_up_questions=[
            "Which pipeline exports run history?",
            {"text": "an object, not a question"},
            "",
            "   ",
            None,
            7,
            "Who owns the release checklist?",
        ])
        self.assertEqual(
            result["follow_up_questions"],
            ["Which pipeline exports run history?", "Who owns the release checklist?"],
        )
        for question in result["follow_up_questions"]:
            self.assertIsInstance(question, str)

    def test_follow_up_questions_that_are_not_a_list_yield_none(self):
        for bad in ("a single string", {"q": "?"}, 3):
            with self.subTest(follow_up_questions=bad):
                self.assertEqual(_score(follow_up_questions=bad)["follow_up_questions"], [])

    def test_the_envelope_never_claims_na(self):
        """N/A is never self-granting — this agent must not decide it.

        docs/assessment-tenant.md: an exception comes from the archetype
        registry and needs human approval. Downstream, ``is_na`` in a payload
        is only a *claim* and opens a pending exception; the scorer should not
        be making that claim at all, so ``is_na`` must never appear in what it
        emits — not even as ``false``.
        """
        result = _score()
        self.assertNotIn("is_na", result)
        self.assertNotIn("na_claimed", result)

    def test_confidence_is_always_one_of_the_three_bands(self):
        # applyScores: 'invalid confidence "..." — must be low|moderate|high'.
        for raw in ("medium", "MEDIUM", "very high", "0.8", None, 3, [], "moderate "):
            with self.subTest(confidence=raw):
                self.assertIn(_score(confidence=raw)["confidence"], ("low", "moderate", "high"))


class EvidenceItCannotSee(unittest.TestCase):
    """A level is only as honest as the evidence actually behind it."""

    def test_no_evidence_at_all_cannot_be_high_confidence(self):
        """The plausible-score failure mode, in its purest form.

        Nothing cited, nothing to cite: the model asked for Level 3 at high
        confidence and there is not one evidence item behind it. Level 3 is
        still allowed (0-3 are supportable without Observed evidence), but it
        may not be *presented* as well-established.
        """
        result = score_dimension_impl(
            dimension_id="9",
            evidence_ids=[],
            evidence_items=[],
            proposed_level=3,
            confidence="high",
            rationale="The team appears to have a governance process.",
        )
        self.assertIs(result["refused"], False)
        self.assertEqual(result["current_level"], 3)
        self.assertEqual(result["confidence"], "low")
        self.assertEqual(result["evidence_class"], "attested")

    def test_evidence_supplied_but_none_cited_is_still_low(self):
        """Evidence in the run is not evidence for *this* dimension."""
        items = [_evidence("e1", "artifact", "Pipeline history for the deploy job.")]
        result = score_dimension_impl(
            dimension_id="9",
            evidence_ids=[],
            evidence_items=items,
            proposed_level=2,
            confidence="high",
            rationale="Governance is presumably handled by the same team.",
        )
        self.assertEqual(result["confidence"], "low")
        self.assertEqual(result["unverified_evidence_ids"], [])

    def test_citing_an_evidence_id_that_does_not_exist_is_reported(self):
        """A citation to nothing makes an unsupported level look supported."""
        items = [_evidence("e1", "document", "We review every pull request.")]
        result = score_dimension_impl(
            dimension_id="8",
            evidence_ids=["e1", "e7", "EV-9999"],
            evidence_items=items,
            proposed_level=3,
            confidence="high",
            rationale="Code review is documented and cited from two more sources.",
        )
        self.assertEqual(result["unverified_evidence_ids"], ["e7", "EV-9999"])
        # One band down, same as a quote that isn't in the text.
        self.assertEqual(result["confidence"], "moderate")

    def test_every_citation_dangling_falls_all_the_way_to_low(self):
        items = [_evidence("e1", "document", "We review every pull request.")]
        result = score_dimension_impl(
            dimension_id="8",
            evidence_ids=["nope"],
            evidence_items=items,
            proposed_level=3,
            confidence="high",
            rationale="Cited evidence that is not in the run.",
        )
        self.assertEqual(result["unverified_evidence_ids"], ["nope"])
        self.assertEqual(result["confidence"], "low")

    def test_clean_citations_report_no_unverified_ids(self):
        self.assertEqual(_score()["unverified_evidence_ids"], [])

    def test_level_4_needs_observed_evidence_from_every_weaker_class(self):
        """L4 requires Observed — Attested and Documented both cap at 3."""
        for source_type, expected_class in (
            ("survey", "attested"),
            ("transcript", "attested"),
            ("document", "documented"),
        ):
            with self.subTest(source_type=source_type):
                items = [_evidence("e1", source_type, "We deploy continuously and measure it.")]
                result = score_dimension_impl(
                    dimension_id="2",
                    evidence_ids=["e1"],
                    evidence_items=items,
                    proposed_level=5,
                    confidence="high",
                    rationale="The team describes a mature, measured deployment practice.",
                )
                self.assertEqual(result["current_level"], 3)
                self.assertIs(result["cap_applied"], True)
                self.assertEqual(result["evidence_class"], expected_class)

    def test_strongest_class_wins_when_classes_are_mixed(self):
        items = [
            _evidence("e1", "survey", "We think we are great at CI."),
            _evidence("e2", "artifact", "Build history: 412 green builds in 30 days."),
        ]
        result = score_dimension_impl(
            dimension_id="1",
            evidence_ids=["e1", "e2"],
            evidence_items=items,
            proposed_level=4,
            confidence="moderate",
            rationale="Build history corroborates the team's own account.",
        )
        self.assertEqual(result["evidence_class"], "observed")
        self.assertEqual(result["current_level"], 4)
        self.assertIs(result["cap_applied"], False)

    def test_unknown_source_type_is_treated_as_attested_not_observed(self):
        """An unrecognised source_type must never buy a level-4 claim."""
        items = [_evidence("e1", "hearsay", "Someone said the deploys are automated.")]
        result = score_dimension_impl(
            dimension_id="2",
            evidence_ids=["e1"],
            evidence_items=items,
            proposed_level=4,
            confidence="high",
            rationale="An unclassified source describes automated deploys.",
        )
        self.assertEqual(result["evidence_class"], "attested")
        self.assertEqual(result["current_level"], 3)
        self.assertIs(result["cap_applied"], True)


class Helpers(unittest.TestCase):
    def test_coerce_rubric_level(self):
        for raw, expected in (
            (0, 0), (5, 5), (3, 3), ("3", 3), (3.0, 3), ("3.0", 3), (" 2 ", 2),
            (6, None), (-1, None), (3.7, None), ("0.5", None), (True, None),
            (False, None), (None, None), ("", None), ("three", None), ([], None),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(coerce_rubric_level(raw), expected)

    def test_valid_follow_up_questions(self):
        self.assertEqual(valid_follow_up_questions(["a", "", None, "b", 1]), ["a", "b"])
        self.assertEqual(valid_follow_up_questions(None), [])
        self.assertEqual(valid_follow_up_questions("not a list"), [])


if __name__ == "__main__":
    unittest.main()
