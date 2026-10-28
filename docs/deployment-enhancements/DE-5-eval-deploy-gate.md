# DE-5 Eval as a deploy gate

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Gates DE-3 (registry writes), DE-4 (prompt promotion) and DE-2 (image rollout).

## Current state (read from the code, 2026-10-27)

There are two offline eval suites and one online evaluator, and **nothing
blocks a ship on any of them**.

**Golden sets** (`agents/tests/golden/*.json`): eight agents, 3 to 5 cases
each, 27 in total. `golden_runner.py` has two modes:

- `structural` (the only one judged, `scripts/validate-agent-eval.sh`) checks
  that each case's `expected_tools` exist on the loaded module
  (`agents/tests/golden_runner.py:68-84`). No model is called.
- `live` shells out to `agentcore invoke --agent <runtime_name>`
  (`golden_runner.py:90-105`) and grades by substring (`:108-119`), with an
  80 % default threshold (`:145`). The golden files name runtimes
  `orgiq-<agent>`, but CDK names them `orgiq_<agent>`
  (`infra/lib/agentcore-runtime-stack.ts:201,407`), and no agent directory has
  an `agentcore` project config. So **live mode probably cannot reach a
  CDK-deployed runtime as written** (unverified; I did not run the CLI).

**The regression harness** (`infra/scripts/harness.py`, cases in Aurora via
`/api/observability/harness`) already invokes deployed runtimes with
`invoke_agent_runtime` (`harness.py:660-676`), judges through the trace sink
and records `pass_rate` per run. But `run` exits 0 whatever the pass rate,
non-zero only when results went unrecorded (`harness.py:1179-1181`), so it is
a report, not a gate. Its `promote` route stamps a sha as blessed
(`middleware/src/routes/harness.ts:1547-1568`), but no agent reads that stamp
(see DE-4).

**Online eval.** `enableEval` is on in `infra/cdk.json:17`, so two
`CfnEvaluator`s are deployed (quality at TRACE level, tool selection at
TOOL_CALL level; `infra/lib/agentcore-telemetry-stack.ts:154,194`) with the
judge on `us.amazon.nova-pro-v1:0` (`:33`). The config that runs them needs
`enableOnlineEvalConfig=true` as well (`:37-40`), is off by default, and is a
raw `cdk.CfnResource` (`:246`) sampling 10 % of **supervisor** spans only
(`ServiceNames: [orgiq-supervisor]`, `:257-266`). The telemetry stack's agent
list omits both assessment agents (`:9`).

Two things the backlog line misses:

- **The raw `CfnResource` is no longer needed.** The installed
  `aws-cdk-lib` 2.270.0 ships `CfnOnlineEvaluationConfig` with `serviceNames`
  (`infra/node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/bedrockagentcore.generated.d.ts:9040`),
  the field whose absence the comment at `:242-245` cites.
- **Online eval results feed nothing.** They land in
  `/aws/bedrock-agentcore/evaluations/results/<config-id>` (`:70-82`). No code
  in `middleware/`, `infra/lambda/` or `scripts/` reads that log group. The
  `JudgeScore` anomaly alarms (`:429-523`) watch `OrgIQ/Observability`
  metrics the BFF's own judge publishes (`middleware/src/lib/trace-sink.ts:957-966`),
  not AgentCore's evaluator output.

Online eval scores traffic after it has been served, so it cannot gate the
**first** exposure to a change. It can only gate widening a canary (DE-2
traffic shift, DE-4 candidate weight).

## Change

**One gate command, two stages, one verdict file.**

`scripts/eval-gate.sh <change-kind> <subject> [--agents a,b]`, where the kind
is `prompt`, `model` or `image`. It writes `.scratch/eval-gate/<id>.json`
(`{kind, subject, agents, stage, passRate, threshold, verdict, cases[]}`) and
exits non-zero on a fail.

1. **Stage A, offline, before anything ships.**
   - `golden_runner.py --mode structural` (free).
   - Live golden cases against the candidate. `golden_runner.py --mode live`
     is retargeted to `invoke_agent_runtime` by ARN, reusing
     `harness.py`'s `_load_agent_runtime_arns` and its hyphen-to-underscore mapping (`harness.py:528,557-559`), so it reaches CDK runtimes.
     The candidate is pinned per run: a prompt version through DE-4's
     `SYSTEM_PROMPT_VERSION`, a model through DE-3's
     `MODEL_REGISTRY_VERSION`, an image through the DE-2 non-default
     endpoint. Before DE-2 exists, a candidate *image* runs under local
     `agentcore dev`.
   - `harness.py run --mode live --agent <a>`, given a `--min-pass-rate` flag
     that sets exit 5 below the bar.
   - Per-agent thresholds sit in `agents/tests/golden/<agent>.json` as
     `"gate": {"minPassRate": 0.8}`, so the bar is reviewed with the cases.
2. **Stage B, online, before a canary widens.** The online config moves to
   the L1 `CfnOnlineEvaluationConfig`, one per user-facing agent, because the
   service limit is one service name per config (`:235`). That fixes the
   supervisor-only sampling. A small reader
   (`middleware/src/lib/online-eval-results.ts`) queries the results log
   group per agent and per `orgiq.prompt_arm` or image digest. The DE-4
   canary controller and the DE-2 traffic shifter then refuse to widen while
   the candidate's mean evaluator score sits more than the configured delta
   below live's. Log fields are **unverified**; read one real results record
   before writing the parser.
3. **Wiring.**
   - DE-4's candidate route and DE-3's registry write call stage A and refuse
     on a fail.
   - `infra/scripts/deploy.sh` runs stage A when the CDK context touches
     `deployRuntimes`/`onlyAgents` and the agent image digests changed.
     `--context skipEvalGate=<reason>` is logged into the verdict file and
     never silent.
4. **Cost bound.** Stage A is about 27 golden calls plus harness cases per
   full run. The gate takes `--agents` and runs only the agents a change
   touches.
5. **Offline.** In `dev:mock` and with `DEV_OFFLINE`, live stages report
   `verdict: "skipped-offline"` and exit 0 only under an explicit
   `--allow-offline`, so a missing credential never reads as a pass.

## Decisions owed

- **Thresholds.** Proposal: 0.8 per agent offline (the existing default); online,
  the candidate's mean may be no more than 0.3 below live's on the 1-to-5 scale,
  over at least 30 sampled traces (the canary's `min_samples`).
- **Turning online eval on.** Proposal: enable it in `cdk.json` once the
  runtimes are serving again (the credentials have been invalid since early
  October), at 10 % sampling per agent; evaluator cost goes on the DE-10 meter.
- **One offline suite or two.** The golden JSON and the Aurora harness cases
  overlap. Proposal: keep both for now, with golden as the gate floor and
  harness cases as extra coverage; merging them is a later item.

## Done when

- `scripts/eval-gate.sh prompt search:7 --agents search` exits non-zero when
  a stubbed invoker fails a case and writes a verdict file naming the case;
  covered by a `.venv-synth` unittest that never touches AWS.
- `golden_runner.py --mode live` resolves `orgiq_<agent>` ARNs, with a unit
  test on a stubbed `bedrock-agentcore` client.
- `harness.py run --min-pass-rate 0.8` returns 5 below the bar (unit test).
- `cd infra && npx cdk synth OrgIQ-AgentCoreTelemetry --context enableOnlineEvalConfig=true`
  shows `AWS::BedrockAgentCore::OnlineEvaluationConfig` from the L1, one per
  user-facing agent, with no `cdk.CfnResource` left in the telemetry stack.
- A jest test parses a captured results-log record into a per-arm score
  (the fixture is captured from a real run, per `docs/mock-floor.md`).
- `validate-agent-eval.sh` gains a check that every golden file has a `gate`
  block, and stays green.
