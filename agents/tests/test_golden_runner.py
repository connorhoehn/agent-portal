"""Tests for the golden-set eval harness (agents/tests/golden_runner.py).

Two things are worth pinning here. First, the grading logic (case-insensitive
``must_include``/``must_not_include`` substring checks) is small and easy to
get subtly wrong — a case-sensitivity slip would make every ``--mode live``
run report false failures. Second, and more load-bearing: every shipped
golden file under ``agents/tests/golden/`` must stay in sync with the tools
its agent actually exposes. A renamed tool should break this test today, not
rot silently until someone runs ``--mode live`` against real Bedrock and
wonders why every case for one agent fails identically.

No AWS, no `strands` import, no subprocess. Run from this directory:

    cd agents/tests && ../../.venv-synth/bin/python -m unittest test_golden_runner
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import golden_runner as gr  # noqa: E402


class GradeTextTests(unittest.TestCase):
    def test_passes_when_required_substrings_present(self):
        ok, detail = gr._grade_text(
            "Kubernetes experts on the platform team are Alice and Bob.",
            {"must_include": ["kubernetes", "alice"]},
        )
        self.assertTrue(ok, detail)

    def test_fails_when_required_substring_missing(self):
        ok, detail = gr._grade_text("nothing relevant here", {"must_include": ["kubernetes"]})
        self.assertFalse(ok)
        self.assertIn("missing required text", detail)

    def test_fails_when_forbidden_substring_present(self):
        ok, detail = gr._grade_text(
            "As an AI language model, I cannot know that.",
            {"must_not_include": ["as an ai language model"]},
        )
        self.assertFalse(ok)
        self.assertIn("forbidden text present", detail)

    def test_grading_is_case_insensitive(self):
        ok, _ = gr._grade_text(
            "AURORA was chosen over Neptune for the org graph.",
            {"must_include": ["aurora"], "must_not_include": ["apache age"]},
        )
        self.assertTrue(ok)

    def test_passes_with_no_criteria(self):
        ok, detail = gr._grade_text("anything at all", {})
        self.assertTrue(ok, detail)


class GoldenFileCoverageTests(unittest.TestCase):
    """Every agent that ships tools has a golden set, and every golden set is
    well-formed. This is the check the validator relies on — see
    docs/agent-eval-goal.md."""

    def _agent_dirs_with_tools(self) -> list[str]:
        # base/ is the shared Dockerfile, not a Strands agent; devbox/ runs
        # Claude Code and has no @tool functions of its own (see CLAUDE.md).
        return sorted(
            p.name
            for p in gr.AGENTS_DIR.iterdir()
            if p.is_dir() and (p / "main.py").exists() and p.name not in ("base", "devbox")
        )

    def test_every_tool_bearing_agent_has_a_golden_set(self):
        golden_dirs = set(gr.all_agent_dirs())
        missing = [d for d in self._agent_dirs_with_tools() if d not in golden_dirs]
        self.assertEqual(missing, [], f"agents missing a golden set: {missing}")

    def test_each_golden_file_has_at_least_three_well_formed_cases(self):
        for agent_dir in gr.all_agent_dirs():
            with self.subTest(agent=agent_dir):
                golden = gr.load_golden(agent_dir)
                cases = golden.get("cases", [])
                self.assertGreaterEqual(len(cases), 3, f"{agent_dir}: needs >= 3 golden cases")
                ids = [c["id"] for c in cases]
                self.assertEqual(len(ids), len(set(ids)), f"{agent_dir}: duplicate case ids: {ids}")
                for case in cases:
                    self.assertIn("prompt", case, f"{agent_dir}/{case.get('id')}: missing prompt")
                    self.assertTrue(
                        case.get("expected_tools") or case.get("must_include"),
                        f"{agent_dir}/{case['id']}: needs expected_tools and/or must_include",
                    )

    def test_structural_grading_passes_for_every_shipped_golden_set(self):
        for agent_dir in gr.all_agent_dirs():
            with self.subTest(agent=agent_dir):
                results = gr.run_structural(agent_dir)
                failed = [(r.case_id, r.detail) for r in results if not r.passed]
                self.assertEqual(failed, [], f"{agent_dir}: {failed}")


if __name__ == "__main__":
    unittest.main()
