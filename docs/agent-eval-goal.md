# Goal: every OrgIQ agent has a golden set, and the harness that grades it

`scripts/validate-agent-eval.sh` is the judge. It never spends real Bedrock $
and never needs live AWS credentials — see "Two grading modes" below for why
that is a deliberate scope cut, not an oversight.

## Why

The fleet had eight agents and zero regression coverage for what they
actually *say* or *do* when asked. `agents/tests/` unit-tests the raw
`@tool` Python callables against stubbed AWS clients (see
`agents/tests/agent_harness.py`), and the online-eval stack
(`OrgIQ-AgentCoreTelemetry`'s `CfnEvaluator`s, `middleware/src/lib/judge.ts` +
`judge-config.ts` + `canary-judge.ts`) grades live production traffic after
the fact. Nothing in between caught a golden case going stale — a prompt
written for a tool that got renamed or dropped six months ago — before a
human noticed the fleet quietly answering worse. A golden set per agent,
checked into the repo next to the tools it exercises, closes that gap the
same way `agents/tests/test_*.py` closes it for the raw callables.

This is intentionally a different thing from `middleware/src/providers/
prompt-evals.ts` (per-asset corpus + assertions gating the prompt/asset
library's canary deploys) and from the two `CfnEvaluator`s in
`infra/lib/agentcore-telemetry-stack.ts` (LLM-as-judge over live CloudWatch
traces). Both of those already exist and are not duplicated here; this
harness is the one thing neither of them is — an offline, per-agent
regression suite a developer runs before pushing a tool or prompt change.

## Two grading modes, one judged

- **`--mode structural`** (what the validator runs): loads each agent's
  `main.py` through `agents/tests/agent_harness.py` (stubbed SDKs, no AWS, no
  network) and checks that every tool name a golden case's `expected_tools`
  references still exists on the module. Free, deterministic, catches drift
  between a golden file and a renamed/removed tool. It does **not** grade
  what a model says — there is no model in this mode.
- **`--mode live`** (operator workflow, not gated by the validator): shells
  out to `agentcore invoke --agent <runtime_name> --prompt "<prompt>"`
  against a deployed runtime (point `runtime_name` at a local `agentcore dev`
  server name to run it there instead) and grades the real response against
  each case's `must_include` / `must_not_include` substrings,
  case-insensitive. This is the mode that actually tells you whether an
  agent gives a good answer — and it costs real Bedrock $ per case and needs
  live credentials, the same caveat CLAUDE.md gives `schema/synth/
  verify_adr.py` / `verify_docs.py`: run it deliberately, not on every save.

## Golden case schema

`agents/tests/golden/<agent-dir>.json` (agent dir names match `agents/*`,
e.g. `advisor`, `graph-builder`, `assessment-scorer`):

```json
{
  "agent": "advisor",
  "runtime_name": "orgiq-advisor",
  "cases": [
    {
      "id": "kebab-case-unique-id",
      "prompt": "the user-facing prompt",
      "expected_tools": ["query_graph"],
      "must_include": ["team"],
      "must_not_include": ["as an ai language model"],
      "notes": "why this case matters"
    }
  ]
}
```

`expected_tools` drives `--mode structural`; `must_include` /
`must_not_include` drive `--mode live`. A case should carry at least one of
the two — most should carry both, since a structural-only case never gets
semantic coverage.

## Definition of done (what the validator checks)

1. Every agent directory under `agents/` that has its own `main.py` and is
   not `agents/base` (shared Dockerfile, no agent of its own) or
   `agents/devbox` (runs Claude Code, not a Strands agent — see CLAUDE.md)
   has a matching `agents/tests/golden/<dir>.json`.
2. Every golden file has at least 3 cases, unique ids, and each case has a
   `prompt` plus at least one of `expected_tools` / `must_include`.
3. `agents/tests/test_golden_runner.py` passes in `.venv-synth` — it asserts
   points 1 and 2 directly, plus the grading function's substring logic.
4. `agents/tests/golden_runner.py --mode structural` exits 0 for every
   agent — every tool name referenced in every golden case exists on the
   loaded module.

## Running it

```bash
cd agents/tests && ../../.venv-synth/bin/python -m unittest test_golden_runner
../../.venv-synth/bin/python golden_runner.py                    # structural, all agents
../../.venv-synth/bin/python golden_runner.py advisor search     # structural, subset

# Operator workflow — real Bedrock $, needs a deployed runtime or `agentcore dev`:
../../.venv-synth/bin/python golden_runner.py advisor --mode live --threshold 0.8
```

## Adding a case

Add an object to the relevant agent's JSON file and re-run the structural
suite. If the case is meant to catch a real regression in what the model
says (not just which tool it calls), run `--mode live` once by hand before
committing — the validator won't catch a case whose `must_include` text can
never appear in a real answer, because it never asks a real model anything.

## Known limits

- `--mode structural` cannot tell you an agent picked the *right* tool for a
  prompt, only that the tool named in the golden case exists. Tool-selection
  correctness is what the `ToolSelectionEvaluator` `CfnEvaluator` grades
  online, and what `--mode live` grades offline by proxy (via the answer
  text, since `agentcore invoke`'s CLI output doesn't reliably expose which
  tools ran).
- `--mode live` is not wired into any CI-equivalent because there isn't one
  in this repo, and because it should not run unattended against a metered
  Bedrock account. Treat it as a pre-merge manual check for changes that
  touch an agent's tools, system prompt, or `MODEL_ID`.
