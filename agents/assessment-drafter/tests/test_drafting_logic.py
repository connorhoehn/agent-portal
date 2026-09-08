"""Unit tests for the assessment-drafter's deterministic guardrails.

Pure stdlib — no strands/bedrock_agentcore/boto3 needed, and nothing here
touches the network or Bedrock. Run from the agent directory, the same
command every other suite in this repo uses:

    cd agents/assessment-drafter && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'

(This file was pytest-only until 2026-09; pytest is not installed in the
synth venv and cannot be, so the suite never ran. See tests/__init__.py.)

The drafter's honesty contract, and what is pinned about it:

*   **Never promise a level.** "This moves the team to Level 3" is a promise
    the assessment cannot keep — verification is evidence-driven, and no
    story guarantees an outcome. The hedged form the source product
    explicitly allows ("what we would need to confirm Level 3") must survive
    untouched, or the guardrail eats the very sentence it wants written.
*   **Never estimate human effort.** Sizing is the team's call.
*   **Never fabricate a source.** A fact's ``source_span`` has to be a real
    substring of the document, or the fact is dropped — the same discipline
    the scorer applies to evidence excerpts.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from drafting_logic import (  # noqa: E402
    find_forbidden_phrases,
    scrub_forbidden_promises,
    validate_context_fact,
    validate_context_facts,
)

GOOD_STORY = """\
| Field | Value |
| --- | --- |
| Project key | [NEEDS INPUT] [ID: S_Q1] |
| Dimension | 6 |

## Summary
This story is about attaching an artifact we can check. This is what we
would need to confirm Level 3 for this dimension.

## Acceptance Criteria
- A recent pipeline run export is attached, per the CI pipeline policy.
"""

BAD_STORY_LEVEL_PROMISE = """\
## Summary
Completing this story moves the team to Level 3 automatically.
"""

BAD_STORY_EFFORT = """\
## Summary
This is a 5 story point quick win that should take about 3 hours.
"""

SOURCE_DOC = "Approval Gate Owner: the TPM approves scope lock before build starts."


def _fact(**overrides):
    fact = {
        "category": "process",
        "scope": "shared",
        "fact_type": "observed",
        "text": "The TPM approves scope lock.",
        "source_span": "the TPM approves scope lock",
    }
    fact.update(overrides)
    return fact


class NeverPromiseALevel(unittest.TestCase):
    def test_clean_story_has_no_violations(self):
        scrubbed, violations = scrub_forbidden_promises(GOOD_STORY)
        self.assertEqual(violations, [])
        self.assertEqual(scrubbed, GOOD_STORY)
        self.assertIn("Level 3", scrubbed)  # the hedged "confirm Level 3" phrasing survives

    def test_level_promise_is_scrubbed(self):
        scrubbed, violations = scrub_forbidden_promises(BAD_STORY_LEVEL_PROMISE)
        self.assertTrue(violations)
        self.assertNotIn("moves the team to Level 3", scrubbed)
        self.assertIn("[NEEDS INPUT", scrubbed)

    def test_every_promise_verb_is_caught(self):
        for sentence in (
            "This story moves the team to Level 3.",
            "Completing it advances the team to Level 4.",
            "Attaching the export guarantees Level 3.",
            "This ensures Level 2 for the dimension.",
            "The work achieves Level 5 for observability.",
            "Doing this will reach Level 4.",
            "This gets the team to Level 3.",
            "Merging the pipeline unlocks Level 4.",
            "This results in Level 3 for continuous delivery.",
        ):
            with self.subTest(sentence=sentence):
                scrubbed, violations = scrub_forbidden_promises(sentence)
                self.assertTrue(violations, msg=f"missed a level promise: {sentence}")
                self.assertNotIn("Level", scrubbed.replace("[NEEDS INPUT: remove level promise]", ""))

    def test_hedged_level_language_is_left_alone(self):
        """The allowed phrasings — redacting these breaks the story template."""
        for sentence in (
            "This is what we would need to confirm Level 3 for this dimension.",
            "| Level this story works toward | 3 |",
            "The team's claimed level is 4 and verification reached Level 2.",
            "Evidence requested to support Level 4.",
        ):
            with self.subTest(sentence=sentence):
                scrubbed, violations = scrub_forbidden_promises(sentence)
                self.assertEqual(violations, [], msg=f"false positive on: {sentence}")
                self.assertEqual(scrubbed, sentence)

    def test_promise_across_a_sentence_boundary_is_not_matched(self):
        """The bound is one sentence — a period ends the reach, deliberately."""
        text = "This advances the practice. Level 4 requires observed evidence over time."
        scrubbed, violations = scrub_forbidden_promises(text)
        self.assertEqual(violations, [])
        self.assertEqual(scrubbed, text)


class NeverEstimateEffort(unittest.TestCase):
    def test_effort_estimate_is_scrubbed(self):
        scrubbed, violations = scrub_forbidden_promises(BAD_STORY_EFFORT)
        self.assertTrue(violations)
        self.assertNotIn("story point", scrubbed.lower())
        self.assertNotIn("hours", scrubbed.lower())
        self.assertNotIn("quick win", scrubbed.lower())

    def test_every_effort_spelling_is_caught(self):
        for sentence in (
            "Sizing: 5 story points.",
            "This is 3 pts of work.",
            "Roughly 8 hours of effort.",
            "Should take 2 days.",
            "Plan for 1 week.",
            "This is a quick win.",
            "Low-hanging fruit for the team.",
            "Target sprint: the next one.",
            "This is about two weeks of work.",
            "Expect three sprints to land it.",
            "A few days of effort at most.",
            "A couple of hours should do it.",
            "Several weeks, realistically.",
        ):
            with self.subTest(sentence=sentence):
                self.assertTrue(
                    find_forbidden_phrases(sentence),
                    msg=f"missed an effort estimate: {sentence}",
                )

    def test_ordinary_prose_is_not_mistaken_for_an_estimate(self):
        """Bare articles are not counts — redacting these corrupts the draft."""
        for sentence in (
            "The team follows a day-to-day triage process.",
            "An hourly job publishes the dashboard.",
            "Attach the export for a recent pipeline run.",
            "The retention policy covers the release history.",
            "Dimension 5 covers automated testing.",
        ):
            with self.subTest(sentence=sentence):
                self.assertEqual(
                    find_forbidden_phrases(sentence), [],
                    msg=f"false positive on: {sentence}",
                )

    def test_violations_are_reported_verbatim_for_the_reviewer(self):
        """A reviewer has to see *what* was redacted, not just that something was."""
        _, violations = scrub_forbidden_promises("This 5 story point task moves the team to Level 3.")
        self.assertIn("moves the team to Level 3", violations)
        self.assertIn("5 story point", violations)

    def test_scrub_leaves_a_visible_marker_rather_than_deleting(self):
        scrubbed, _ = scrub_forbidden_promises("Completing this achieves Level 4 in 2 weeks.")
        self.assertIn("[NEEDS INPUT: remove level promise]", scrubbed)
        self.assertIn("[NEEDS INPUT: remove effort estimate]", scrubbed)

    def test_empty_and_non_string_drafts_are_returned_unchanged(self):
        for draft in ("", None, 42, [], {"markdown": "..."}):
            with self.subTest(draft=draft):
                scrubbed, violations = scrub_forbidden_promises(draft)
                self.assertEqual(scrubbed, draft)
                self.assertEqual(violations, [])
                self.assertEqual(find_forbidden_phrases(draft), [])

    def test_scrubbing_is_idempotent(self):
        once, _ = scrub_forbidden_promises(BAD_STORY_EFFORT)
        twice, violations = scrub_forbidden_promises(once)
        self.assertEqual(twice, once)
        self.assertEqual(violations, [])


class NeverFabricateASource(unittest.TestCase):
    def test_valid_fact_survives_verbatim_check(self):
        fact = _fact()
        self.assertEqual(validate_context_fact(fact, SOURCE_DOC), fact)

    def test_fabricated_source_span_is_dropped(self):
        fact = _fact(
            text="The VP approves scope lock.",
            source_span="the VP approves scope lock",  # not present in source
        )
        self.assertIsNone(validate_context_fact(fact, SOURCE_DOC))

    def test_invalid_vocabulary_is_dropped(self):
        source = "We use Confluence for documentation."
        bad_category = {
            "category": "not-a-real-category",
            "scope": "shared",
            "fact_type": "observed",
            "text": "We use Confluence.",
            "source_span": "We use Confluence",
        }
        self.assertIsNone(validate_context_fact(bad_category, source))

    def test_each_controlled_vocabulary_field_is_enforced(self):
        for field, bad in (
            ("category", "insight"), ("category", None), ("category", 3),
            ("scope", "global"), ("scope", ""), ("scope", ["shared"]),
            ("fact_type", "opinion"), ("fact_type", None), ("fact_type", "observation"),
        ):
            with self.subTest(field=field, value=bad):
                self.assertIsNone(validate_context_fact(_fact(**{field: bad}), SOURCE_DOC))

    def test_known_vocabulary_is_normalised_rather_than_dropped(self):
        """"Process" is the same word as "process" — case is not fabrication."""
        result = validate_context_fact(
            _fact(category="Process", scope=" Shared ", fact_type="OBSERVED"), SOURCE_DOC,
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["category"], "process")
        self.assertEqual(result["scope"], "shared")
        self.assertEqual(result["fact_type"], "observed")

    def test_a_fact_with_no_text_is_dropped(self):
        for bad in ("", "   ", None, 7, ["a fact"]):
            with self.subTest(text=bad):
                self.assertIsNone(validate_context_fact(_fact(text=bad), SOURCE_DOC))

    def test_a_fact_with_no_usable_source_span_is_dropped(self):
        for bad in ("", None, 7, ["the TPM approves scope lock"]):
            with self.subTest(source_span=bad):
                self.assertIsNone(validate_context_fact(_fact(source_span=bad), SOURCE_DOC))

    def test_a_non_dict_fact_is_dropped(self):
        for bad in (None, "a fact", 7, ["category", "process"]):
            with self.subTest(fact=bad):
                self.assertIsNone(validate_context_fact(bad, SOURCE_DOC))

    def test_no_source_text_means_nothing_can_verify(self):
        """With no document, every span is unverifiable — drop them all."""
        for source in (None, "", 7, ["doc"]):
            with self.subTest(source=source):
                self.assertIsNone(validate_context_fact(_fact(), source))
                self.assertEqual(validate_context_facts([_fact()], source), [])

    def test_the_returned_fact_carries_only_the_five_declared_keys(self):
        """An extra key the model invented must not ride along downstream."""
        result = validate_context_fact(
            _fact(confidence="high", person="Jane Smith", dimension_id="9"), SOURCE_DOC,
        )
        self.assertEqual(
            sorted(result), ["category", "fact_type", "scope", "source_span", "text"],
        )

    def test_validate_context_facts_filters_mixed_list(self):
        source = "We use Confluence for documentation and JIRA for tracking."
        facts = [
            {
                "category": "tooling",
                "scope": "shared",
                "fact_type": "observed",
                "text": "The team uses Confluence.",
                "source_span": "We use Confluence",
            },
            {
                "category": "tooling",
                "scope": "shared",
                "fact_type": "observed",
                "text": "Fabricated.",
                "source_span": "We use ServiceNow",  # not in source
            },
        ]
        result = validate_context_facts(facts, source)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"], "The team uses Confluence.")

    def test_validate_context_facts_never_invents_a_fact(self):
        """The filter only ever returns a subset — never a rewritten set."""
        for facts in (None, [], "not a list", [None, 3, "x"]):
            with self.subTest(facts=facts):
                self.assertEqual(validate_context_facts(facts, SOURCE_DOC), [])

    def test_facts_keep_their_input_order(self):
        source = "alpha beta gamma delta"
        facts = [_fact(text="A", source_span="alpha"), _fact(text="G", source_span="gamma")]
        self.assertEqual([f["text"] for f in validate_context_facts(facts, source)], ["A", "G"])


if __name__ == "__main__":
    unittest.main()
