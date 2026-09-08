"""Unit tests for the assessment-drafter's deterministic guardrails.

Pure stdlib + pytest — no strands/bedrock_agentcore/boto3 needed. Run from
this directory:

    python3.12 -m pytest -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from drafting_logic import (  # noqa: E402
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


def test_clean_story_has_no_violations():
    scrubbed, violations = scrub_forbidden_promises(GOOD_STORY)
    assert violations == []
    assert scrubbed == GOOD_STORY
    assert "Level 3" in scrubbed  # the hedged "confirm Level 3" phrasing survives


def test_level_promise_is_scrubbed():
    scrubbed, violations = scrub_forbidden_promises(BAD_STORY_LEVEL_PROMISE)
    assert violations
    assert "moves the team to Level 3" not in scrubbed
    assert "[NEEDS INPUT" in scrubbed


def test_effort_estimate_is_scrubbed():
    scrubbed, violations = scrub_forbidden_promises(BAD_STORY_EFFORT)
    assert violations
    assert "story point" not in scrubbed.lower()
    assert "hours" not in scrubbed.lower()
    assert "quick win" not in scrubbed.lower()


def test_valid_fact_survives_verbatim_check():
    source = "Approval Gate Owner: the TPM approves scope lock before build starts."
    fact = {
        "category": "process",
        "scope": "shared",
        "fact_type": "observed",
        "text": "The TPM approves scope lock.",
        "source_span": "the TPM approves scope lock",
    }
    assert validate_context_fact(fact, source) == fact


def test_fabricated_source_span_is_dropped():
    source = "Approval Gate Owner: the TPM approves scope lock before build starts."
    fact = {
        "category": "process",
        "scope": "shared",
        "fact_type": "observed",
        "text": "The VP approves scope lock.",
        "source_span": "the VP approves scope lock",  # not present in source
    }
    assert validate_context_fact(fact, source) is None


def test_invalid_vocabulary_is_dropped():
    source = "We use Confluence for documentation."
    bad_category = {
        "category": "not-a-real-category",
        "scope": "shared",
        "fact_type": "observed",
        "text": "We use Confluence.",
        "source_span": "We use Confluence",
    }
    assert validate_context_fact(bad_category, source) is None


def test_validate_context_facts_filters_mixed_list():
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
    assert len(result) == 1
    assert result[0]["text"] == "The team uses Confluence."
