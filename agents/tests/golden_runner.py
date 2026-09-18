"""Golden-set eval harness for the 8 OrgIQ Strands agents.

Each agent has a golden set at ``agents/tests/golden/<agent-dir>.json`` — a
handful of representative prompts plus grading criteria (see
``docs/agent-eval-goal.md`` for the schema and the reasoning). This module
grades a golden set in one of two modes:

``structural`` (default, free, offline, no AWS)
    Loads the agent's ``main.py`` through ``agent_harness.load_agent`` —
    stubbed ``strands``/``bedrock_agentcore``, no real client ever
    constructed — and checks that every tool name a case's
    ``expected_tools`` references still exists on the module. This catches a
    golden set that drifted from a renamed or removed tool. It does NOT
    grade what a real model says; there is no model in this mode.

``live`` (operator workflow, real Bedrock $, real AWS credentials)
    Shells out to ``agentcore invoke --agent <runtime_name> --prompt
    "<prompt>"`` against a deployed runtime (or a local ``agentcore dev``
    server reachable under that name) and grades the response text against
    each case's ``must_include`` / ``must_not_include`` substrings,
    case-insensitive. This is the mode that actually tells you whether an
    agent gives a good answer.

Run from this directory (``.venv-synth`` has everything this needs — no
``strands`` import required in either mode):

    cd agents/tests && ../../.venv-synth/bin/python golden_runner.py
    ../../.venv-synth/bin/python golden_runner.py advisor search
    ../../.venv-synth/bin/python golden_runner.py advisor --mode live --threshold 0.8
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
AGENTS_DIR = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_harness import load_agent  # noqa: E402
from agui_harness import install_ag_ui_stubs  # noqa: E402 — supervisor imports ag_ui_strands at module level


@dataclass
class CaseResult:
    case_id: str
    passed: bool
    detail: str


def all_agent_dirs() -> list[str]:
    """Agent dir names with a golden set, e.g. ['advisor', 'search', ...]."""
    return sorted(p.stem for p in GOLDEN_DIR.glob("*.json"))


def load_golden(agent_dir: str) -> dict:
    path = GOLDEN_DIR / f"{agent_dir}.json"
    if not path.exists():
        raise FileNotFoundError(f"no golden set for '{agent_dir}': {path}")
    return json.loads(path.read_text())


# ── structural mode ─────────────────────────────────────────────────────────


def run_structural(agent_dir: str) -> list[CaseResult]:
    golden = load_golden(agent_dir)
    install_ag_ui_stubs()
    module = load_agent(agent_dir)
    results = []
    for case in golden["cases"]:
        missing = [t for t in case.get("expected_tools", []) if not hasattr(module, t)]
        if missing:
            results.append(
                CaseResult(case["id"], False, f"missing tool(s) on module: {', '.join(missing)}")
            )
        else:
            results.append(CaseResult(case["id"], True, "referenced tool(s) present"))
    return results


# ── live mode ────────────────────────────────────────────────────────────────


def _invoke_live(runtime_name: str, prompt: str, timeout: int) -> str:
    """Shells to `agentcore invoke` — CLAUDE.md's documented way to exercise
    a real deployed Agent (that guidance rules out `agentcore deploy` for
    cloud deploys so CDK stays the source of truth; invoke is unaffected).
    """
    proc = subprocess.run(
        ["agentcore", "invoke", "--agent", runtime_name, "--prompt", prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"agentcore invoke failed (exit {proc.returncode}): {proc.stderr.strip()[:500]}"
        )
    return proc.stdout


def _grade_text(text: str, case: dict) -> tuple[bool, str]:
    lower = text.lower()
    missing = [s for s in case.get("must_include", []) if s.lower() not in lower]
    present = [s for s in case.get("must_not_include", []) if s.lower() in lower]
    if missing or present:
        parts = []
        if missing:
            parts.append(f"missing required text: {missing}")
        if present:
            parts.append(f"forbidden text present: {present}")
        return False, "; ".join(parts)
    return True, "substring checks passed"


def run_live(agent_dir: str, timeout: int) -> list[CaseResult]:
    golden = load_golden(agent_dir)
    runtime_name = golden.get("runtime_name", f"orgiq-{agent_dir}")
    results = []
    for case in golden["cases"]:
        try:
            text = _invoke_live(runtime_name, case["prompt"], timeout)
        except Exception as exc:  # noqa: BLE001 — surface any invoke failure as a graded failure
            results.append(CaseResult(case["id"], False, f"invoke error: {exc}"))
            continue
        passed, detail = _grade_text(text, case)
        results.append(CaseResult(case["id"], passed, detail))
    return results


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("agents", nargs="*", help="agent dir names (default: every dir with a golden set)")
    parser.add_argument("--mode", choices=["structural", "live"], default="structural")
    parser.add_argument("--threshold", type=float, default=0.8, help="live mode: min pass rate before exit 1")
    parser.add_argument("--timeout", type=int, default=120, help="live mode: agentcore invoke timeout, seconds")
    args = parser.parse_args(argv)

    agent_dirs = args.agents or all_agent_dirs()
    if not agent_dirs:
        print("no golden sets found under agents/tests/golden/", file=sys.stderr)
        return 1

    overall_ok = True
    for agent_dir in agent_dirs:
        print(f"\n== {agent_dir} ({args.mode}) ==")
        try:
            if args.mode == "structural":
                results = run_structural(agent_dir)
            else:
                results = run_live(agent_dir, args.timeout)
        except FileNotFoundError as exc:
            print(f"  ✗ {exc}")
            overall_ok = False
            continue

        n_pass = sum(1 for r in results if r.passed)
        for r in results:
            mark = "✓" if r.passed else "✗"
            print(f"  {mark} {r.case_id} — {r.detail}")
        rate = (n_pass / len(results)) if results else 0.0
        print(f"  {n_pass}/{len(results)} passed ({rate:.0%})")

        if args.mode == "structural":
            if n_pass != len(results):
                overall_ok = False
        else:
            if rate < args.threshold:
                overall_ok = False

    print()
    if overall_ok:
        print("ALL GOLDEN CASES PASS")
        return 0
    print("GOLDEN CASES FAILING — see ✗ lines above")
    return 1


if __name__ == "__main__":
    sys.exit(main())
