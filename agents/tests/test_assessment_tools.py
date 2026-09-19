"""Tests for the two assessment agents' tool surfaces and entrypoints.

The suites next to each agent (``agents/assessment-*/tests/``) cover the
deterministic logic modules directly. This one covers the layer above them —
the ``@tool`` functions and the AgentCore entrypoint in ``main.py`` — which
had no tests at all, because importing an agent module needs the SDK stubs
that live in ``agent_harness``.

Three things are worth pinning here that the logic-module suites cannot see:

1.  **These agents never persist.** Per CLAUDE.md, an assessment agent
    returns an envelope and the middleware's deterministic ``applyScores``
    is the persistence gate. So neither module may hold a database handle or
    issue SQL — asserted against the module objects and their source.
2.  **The deterministic gate is actually wired in.** A tool that returned
    the model's proposal untouched would pass every logic-module test and
    still ship an ungated score.
3.  **The entrypoint's backstops run on the model's *output*,** not just on
    what the model chose to route through a tool. A model that never calls
    ``check_story_draft``/``validate_facts`` must still not get a level
    promise or a fabricated fact past ``handle``.

No AWS, no network: every SDK is stubbed, ``boto3.client`` is neutered during
import, and ``post_trace`` is patched out. Run from this directory:

    cd agents/tests && ../../.venv-synth/bin/python -m unittest test_assessment_tools
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import load_agent  # noqa: E402

scorer = load_agent("assessment-scorer")
drafter = load_agent("assessment-drafter")

from _shared import prompt_source as ps  # noqa: E402 — agents/ is on sys.path now

ASSESSMENT_AUTH = {"auth": {"sub": "u1", "role": "assessor", "tenant": "assessment"}}


@contextlib.contextmanager
def _baked_prompt_only():
    """Pin the agent to its baked SYSTEM_PROMPT for the duration.

    ``boto3.client`` is only neutered during the module *import*; the first
    call into a ``LiveAgent`` resolves the managed prompt, which builds a real
    bedrock-agent client and dials AWS. That is a network call (and, with
    credentials on the box, a real API request) from a unit test. Same lever
    ``agui_harness`` pulls for the supervisor suite.
    """
    previous = ps.DISABLED
    ps.DISABLED = True
    try:
        yield
    finally:
        ps.DISABLED = previous


def _stub_agent(module):
    """The stub Strands Agent behind the module's LiveAgent.

    ``LiveAgent`` proxies reads but not writes, so scripting a response means
    reaching the built agent itself.
    """
    with _baked_prompt_only():
        agent, _ = module._agent._prompted.get()
    return agent


class _EntrypointBase(unittest.TestCase):
    """Silences trace emission and gives each test a scripted model."""

    module = None

    def setUp(self):
        previous = ps.DISABLED
        ps.DISABLED = True
        self.addCleanup(setattr, ps, "DISABLED", previous)
        patcher = mock.patch.object(self.module, "post_trace", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.agent = _stub_agent(self.module)
        self.addCleanup(setattr, self.agent, "respond", None)
        self.agent.calls.clear()

    def says(self, text):
        self.agent.respond = lambda prompt, **kwargs: text

    def invoke(self, payload):
        return asyncio.run(self.module.handle(payload))


# ── Neither agent persists anything ───────────────────────────────────────


class NeverPersists(unittest.TestCase):
    """The load-bearing property of both agents (CLAUDE.md, assessment tenant).

    They produce an envelope; ``middleware/src/providers/assessment.ts``'s
    ``applyScores`` validates and applies it. An agent that wrote a score
    itself would bypass the N/A-approval rule, the history ledger and the
    self-rating cap all at once.
    """

    def test_no_database_or_storage_handle_on_either_module(self):
        for name, module in (("scorer", scorer), ("drafter", drafter)):
            for handle in ("_rds", "_dynamo", "_s3", "_bedrock_agent_runtime", "_opensearch"):
                with self.subTest(agent=name, handle=handle):
                    self.assertFalse(
                        hasattr(module, handle),
                        msg=f"{name} must not hold a {handle} client — it never persists",
                    )

    def test_no_write_verbs_in_either_module_source(self):
        for name, path in (
            ("scorer", Path(scorer.__file__)),
            ("drafter", Path(drafter.__file__)),
        ):
            source = path.read_text()
            for verb in ("execute_statement", "put_item", "INSERT ", "UPDATE ", "put_object"):
                with self.subTest(agent=name, verb=verb):
                    self.assertNotIn(verb, source)

    def test_only_the_two_read_only_tools_are_registered(self):
        self.assertEqual(
            [t.__name__ for t in _stub_agent(scorer).tools],
            ["classify_evidence", "score_dimension"],
        )
        self.assertEqual(
            [t.__name__ for t in _stub_agent(drafter).tools],
            ["check_story_draft", "validate_facts"],
        )

    def test_both_agents_run_an_aws_native_model(self):
        """Nova by default; never an Anthropic id (the devbox is the exception)."""
        for name, module in (("scorer", scorer), ("drafter", drafter)):
            with self.subTest(agent=name):
                model_id = module._model.kwargs["model_id"]
                self.assertEqual(model_id, "amazon.nova-pro-v1:0")
                self.assertNotIn("anthropic", model_id)


# ── Scorer: the tool surface ──────────────────────────────────────────────


class ScorerToolSurface(unittest.TestCase):
    EVIDENCE = [{
        "id": "e1", "source_type": "survey",
        "text": "Self-rating: we are Advanced at continuous delivery.",
    }]

    def score(self, **overrides):
        kwargs = {
            "dimension_id": "2",
            "evidence_ids": ["e1"],
            "evidence_items": self.EVIDENCE,
            "proposed_level": 3,
            "confidence": "moderate",
            "rationale": "The team's survey answer describes deployment automation.",
        }
        kwargs.update(overrides)
        return json.loads(scorer.score_dimension(**kwargs))

    def test_tools_return_json_text_not_python_objects(self):
        """Strands hands a tool's return value to the model as text."""
        for raw in (
            scorer.classify_evidence("We run CI on every commit."),
            scorer.score_dimension(
                "1", ["e1"], self.EVIDENCE, 2, "low", "Some rationale.",
            ),
        ):
            self.assertIsInstance(raw, str)
            self.assertIsInstance(json.loads(raw), dict)

    def test_score_dimension_applies_the_self_rating_cap(self):
        """The gate is wired in, not just implemented next door."""
        result = self.score(proposed_level=5, confidence="high", self_claimed_level=5)
        self.assertEqual(result["current_level"], 3)
        self.assertIs(result["cap_applied"], True)

    def test_score_dimension_refuses_a_malformed_envelope(self):
        for label, overrides in (
            ("unknown dimension", {"dimension_id": "42"}),
            ("level out of rubric", {"proposed_level": 7}),
            ("fractional level", {"proposed_level": 2.5}),
            ("claim out of rubric", {"self_claimed_level": 99}),
            ("blank rationale", {"rationale": "  "}),
        ):
            with self.subTest(case=label):
                result = self.score(**overrides)
                self.assertIs(result["refused"], True)
                self.assertNotIn("current_level", result)

    def test_scored_envelope_is_json_serialisable_and_shaped(self):
        result = self.score(follow_up_questions=["Which pipeline exports run history?"])
        self.assertEqual(
            sorted(result),
            sorted([
                "dimension_id", "refused", "current_level", "confidence", "evidence_class",
                "cap_applied", "rationale", "evidence_excerpts", "follow_up_questions",
                "self_claimed_level", "unverified_evidence_ids",
            ]),
        )
        # Nothing in the envelope claims N/A — that is a lead's decision.
        self.assertNotIn("is_na", result)

    def test_non_ascii_text_survives_the_json_round_trip(self):
        """ensure_ascii=False everywhere — a rationale must not come back as \\uXXXX."""
        rationale = "L'équipe déploie chaque jour — cadence confirmée."
        result = self.score(rationale=rationale)
        self.assertEqual(result["rationale"], rationale)
        raw = scorer.score_dimension(
            "2", ["e1"], self.EVIDENCE, 3, "low", rationale,
        )
        self.assertIn("déploie", raw)
        self.assertNotIn("\\u", raw)


class ScorerEntrypoint(_EntrypointBase):
    module = scorer

    def test_an_orgiq_session_is_refused_without_calling_the_model(self):
        result = self.invoke({"auth": {"tenant": "orgiq"}, "evidence": [{"id": "e1"}]})
        self.assertEqual(result["error"], "forbidden")
        self.assertEqual(self.agent.calls, [], msg="a refused tenant must not spend a token")

    def test_no_evidence_is_an_error_not_an_empty_scorecard(self):
        """Scoring 17 dimensions from nothing is the fabrication case."""
        for payload in ({**ASSESSMENT_AUTH}, {**ASSESSMENT_AUTH, "evidence": []}):
            with self.subTest(payload=payload):
                result = self.invoke(payload)
                self.assertIn("missing evidence", result["error"])
                self.assertEqual(self.agent.calls, [])

    def test_a_scoring_run_returns_the_model_envelope_and_a_trace_id(self):
        self.says('{"classification": [], "scores": [], "reasoning_log": []}')
        result = self.invoke({
            **ASSESSMENT_AUTH,
            "team_id": "TEAM-002",
            "evidence": [{"id": "e1", "source_type": "document", "text": "We run CI."}],
        })
        self.assertEqual(result["agent"], "assessment-scorer")
        self.assertEqual(json.loads(result["response"])["scores"], [])
        self.assertTrue(result["invocationId"])
        self.assertEqual(len(self.agent.calls), 1)

    def test_the_evidence_reaches_the_model_intact(self):
        self.says("{}")
        self.invoke({
            **ASSESSMENT_AUTH,
            "team_id": "TEAM-002",
            "relevant_dimension_ids": ["1", "2"],
            "evidence": [{"id": "e1", "source_type": "document", "text": "We run CI."}],
        })
        sent = json.loads(self.agent.calls[0][0])
        self.assertEqual(sent["team_id"], "TEAM-002")
        self.assertEqual(sent["relevant_dimension_ids"], ["1", "2"])
        self.assertEqual(sent["evidence"][0]["id"], "e1")


# ── Drafter: the tool surface ─────────────────────────────────────────────


class DrafterToolSurface(unittest.TestCase):
    SOURCE = "Approval Gate Owner: the TPM approves scope lock before build starts."

    def test_check_story_draft_reports_ok_and_a_scrubbed_draft(self):
        clean = json.loads(drafter.check_story_draft(
            "This is what we would need to confirm Level 3.",
        ))
        self.assertIs(clean["ok"], True)
        self.assertEqual(clean["violations"], [])

        dirty = json.loads(drafter.check_story_draft(
            "Completing this moves the team to Level 3 in 2 days.",
        ))
        self.assertIs(dirty["ok"], False)
        self.assertEqual(len(dirty["violations"]), 2)
        self.assertNotIn("moves the team to Level 3", dirty["scrubbed_markdown"])
        self.assertNotIn("2 days", dirty["scrubbed_markdown"])

    def test_validate_facts_returns_only_what_verified(self):
        facts = [
            {"category": "process", "scope": "shared", "fact_type": "observed",
             "text": "The TPM approves scope lock.", "source_span": "the TPM approves scope lock"},
            {"category": "process", "scope": "shared", "fact_type": "observed",
             "text": "The VP signs off.", "source_span": "the VP signs off"},
        ]
        kept = json.loads(drafter.validate_facts(facts, self.SOURCE))
        self.assertEqual([f["text"] for f in kept], ["The TPM approves scope lock."])

    def test_validate_facts_survives_a_malformed_fact_instead_of_raising(self):
        """An unhashable enum value used to raise TypeError out of the tool."""
        facts = [{"category": ["process"], "scope": "shared", "fact_type": "observed",
                  "text": "x", "source_span": "the TPM approves scope lock"}]
        self.assertEqual(json.loads(drafter.validate_facts(facts, self.SOURCE)), [])

    def test_tools_return_json_text(self):
        self.assertIsInstance(json.loads(drafter.check_story_draft("hi")), dict)
        self.assertIsInstance(json.loads(drafter.validate_facts([], "doc")), list)


class DrafterPayloadValidation(unittest.TestCase):
    GOOD_REC = {"kind": "close_the_claim", "dimension_id": "6", "title": "t", "rationale": "r"}

    def test_mode_must_be_one_of_the_two(self):
        for mode in (None, "", "story-mode", "diagram", 3, "context "):
            with self.subTest(mode=mode):
                error = drafter._validate_payload({"mode": mode})
                self.assertIn("mode must be", error or "")

    def test_story_mode_requires_a_recommendation(self):
        for rec in (None, {}, {"kind": "advance_practice"}, {"dimension_id": "6"},
                    "close_the_claim", [{"kind": "advance_practice", "dimension_id": "6"}]):
            with self.subTest(recommendation=rec):
                self.assertIsNotNone(
                    drafter._validate_payload({"mode": "story", "recommendation": rec}),
                )
        self.assertIsNone(
            drafter._validate_payload({"mode": "story", "recommendation": self.GOOD_REC}),
        )

    def test_context_mode_requires_document_text(self):
        for doc in (None, {}, {"text": ""}, {"text": None}, {"text": 7}, "a document"):
            with self.subTest(document=doc):
                self.assertIsNotNone(
                    drafter._validate_payload({"mode": "context", "document": doc}),
                )
        self.assertIsNone(
            drafter._validate_payload({"mode": "context", "document": {"text": "words"}}),
        )


class DrafterEntrypoint(_EntrypointBase):
    module = drafter
    GOOD_REC = {"kind": "advance_practice", "dimension_id": "6", "title": "t", "rationale": "r"}
    SOURCE = "Approval Gate Owner: the TPM approves scope lock before build starts."

    def story(self, **extra):
        return {**ASSESSMENT_AUTH, "mode": "story", "recommendation": self.GOOD_REC, **extra}

    def context(self, **extra):
        return {**ASSESSMENT_AUTH, "mode": "context", "document": {"text": self.SOURCE}, **extra}

    def test_an_orgiq_session_is_refused_without_calling_the_model(self):
        result = self.invoke({**self.story(), "auth": {"tenant": "orgiq"}})
        self.assertEqual(result["error"], "forbidden")
        self.assertEqual(self.agent.calls, [])

    def test_a_malformed_payload_is_refused_without_calling_the_model(self):
        result = self.invoke({**ASSESSMENT_AUTH, "mode": "story"})
        self.assertIn("story mode requires", result["error"])
        self.assertEqual(self.agent.calls, [])

    def test_a_level_promise_the_model_emitted_is_scrubbed_from_the_response(self):
        """The backstop runs on output — the model need not have called the tool."""
        self.says("## Summary\nCompleting this moves the team to Level 4 in three weeks.\n")
        response = self.invoke(self.story())["response"]
        self.assertNotIn("moves the team to Level 4", response)
        self.assertNotIn("three weeks", response)
        self.assertIn("[NEEDS INPUT", response)

    def test_a_clean_story_is_returned_byte_for_byte(self):
        draft = "## Summary\nThis is what we would need to confirm Level 3.\n"
        self.says(draft)
        self.assertEqual(self.invoke(self.story())["response"], draft)

    def test_a_fabricated_fact_the_model_emitted_is_dropped_from_the_response(self):
        self.says(json.dumps({"facts": [
            {"category": "process", "scope": "shared", "fact_type": "observed",
             "text": "The TPM approves scope lock.", "source_span": "the TPM approves scope lock"},
            {"category": "process", "scope": "shared", "fact_type": "observed",
             "text": "The CFO must approve every release.",
             "source_span": "the CFO must approve every release"},
        ]}))
        facts = json.loads(self.invoke(self.context())["response"])["facts"]
        self.assertEqual([f["text"] for f in facts], ["The TPM approves scope lock."])

    def test_context_mode_fails_closed_when_validation_cannot_run(self):
        """Unvalidated facts are the one outcome worse than no facts.

        The re-validation used to sit inside `except (..., TypeError, ...)`
        with the JSON parse, so anything raising out of it left the model's
        own list in the response — fabricated source_spans and all.
        """
        self.says(json.dumps({"facts": [
            {"category": "process", "scope": "shared", "fact_type": "observed",
             "text": "Invented.", "source_span": "nowhere in the document"},
        ]}))
        with mock.patch.object(
            drafter, "validate_context_facts", side_effect=RuntimeError("boom"),
        ):
            facts = json.loads(self.invoke(self.context())["response"])["facts"]
        self.assertEqual(facts, [])

    def test_a_non_json_context_response_is_left_alone_not_crashed_on(self):
        self.says("I could not find any governance facts in this document.")
        result = self.invoke(self.context())
        self.assertEqual(result["response"], "I could not find any governance facts in this document.")
        self.assertTrue(result["invocationId"])


if __name__ == "__main__":
    unittest.main()


class DocumentCommandEntrypoints(unittest.TestCase):
    def test_document_mode_executes_and_validates_actual_model_response(self):
        source = "The team runs checks."
        response = json.dumps({"summary": "A review draft", "content": "# Checks", "format": "markdown", "source_spans": [source]})
        with mock.patch.object(drafter, "_agent", return_value=response), mock.patch.object(drafter, "post_trace"):
            result = asyncio.run(drafter.handle({"auth": {"tenant": "assessment"},
                "mode": "draft-confluence-page", "document": {"text": source}}))
        self.assertNotIn("error", result)
        parsed = json.loads(result["response"])
        self.assertEqual(parsed["content"], "# Checks")
        self.assertIs(parsed["published"], False)

    def test_invalid_document_output_returns_error_envelope(self):
        with mock.patch.object(drafter, "_agent", return_value="not JSON"), mock.patch.object(drafter, "post_trace"):
            result = asyncio.run(drafter.handle({"auth": {"tenant": "assessment"},
                "mode": "draw-diagram", "document": {"text": "A to B"}}))
        self.assertIn("Invalid document draft", result["error"])
