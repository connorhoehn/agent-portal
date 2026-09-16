# Research spike: ADOT floor audit + Strands version-bump audit

Read-only spike against aws-agentcore. No repo edits made. Sources cited inline;
"could not verify" flagged wherever the web didn't confirm.

---

## Spike (a): ADOT version vs the unified-span-group floor

### What's pinned vs what's required

- `agents/base/Dockerfile:30` pins `aws-opentelemetry-distro>=0.12.1` (unpinned
  floor, no `uv.lock` anywhere in the repo — every base-image build does a
  fresh `uv pip install --no-cache`, so the *installed* version is whatever's
  latest on PyPI at build time, not a fixed number). CLAUDE.md's SDK table
  (`## Key SDKs`) repeats the same `>=0.12.1` floor.
- Per AWS's release notes and devguide (confirmed live):
  "Unified telemetry needs ADOT version 0.18.0 or later
  (`aws-opentelemetry-distro>=0.18.0`). Earlier versions send spans to the
  shared `aws/spans` log group." Also requires CloudWatch Transaction Search
  with trace segments sent to CloudWatch Logs, and `logs:PutResourcePolicy`
  on the agent's execution role. Toggle: `UNIFIED_TRACES_DESTINATION_ENABLED`
  (agents created before **2026-07-20** default to `false`/split telemetry;
  all 8 OrgIQ runtimes predate that, so they're on split telemetry today
  regardless of ADOT version, unless the env var is set).
  Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-telemetry.html,
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html
- `aws-opentelemetry-distro` 0.18.0 released **2026-06-19**; current PyPI
  latest is **0.19.0**. Source: WebSearch of PyPI/release notes (could not
  pull the exact PyPI changelog page directly — corroborated by two
  independent search results, not a primary-source fetch).
- `agents/base/Dockerfile` was last touched **2026-08-17** (`git log`), i.e.
  after 0.18.0 shipped — so a base image built any time from that commit
  onward would resolve `>=0.12.1` to 0.19.0 and clear the floor. **Could not
  verify the actually-running ECR image's installed version** — this is an
  offline, no-AWS-creds spike; `aws ecr` / exec-into-container checks are
  needed to confirm what's really deployed, since the floor is unpinned and
  nothing pins a lockfile.

### The bigger finding: the floor mostly doesn't matter to this repo's own pipeline

`OrgIQ-SpanProjector` (`infra/lambda/span-projector/index.py:106-134`) and the
legacy poller (`middleware/src/lib/cw-trace-ingest.ts:66-74`) **do not read
`aws/spans` at all**. Both hard-code
`/aws/bedrock-agentcore/runtimes/*-DEFAULT` — the **stdout** log group AWS
creates for every runtime regardless of ADOT/OTLP config — and grep it for a
custom marker line, not real OTel/OTLP spans:

- SpanProjector greps for `ORGIQ_OI_SPAN:` (index.py:145,163) — written by
  `agents/_shared/instrumentation.py::_bootstrap_openinference` (lines 90-160),
  which builds its **own** `StrandsTelemetry()` TracerProvider and attaches a
  `ConsoleSpanExporter` (line 138-142) that prints to stdout. This is a
  hand-rolled export path parallel to ADOT — it never touches
  `OTEL_TRACES_EXPORTER=otlp` or the AgentCore-injected OTLP endpoint at all.
- The legacy poller greps the same log group for `ORGIQ_TRACE:` (its own
  separate marker, from `instrumentation.py::_emit_stdout_trace`, line 673).
- Neither path depends on ADOT's configurator, on `aws/spans`, or on
  `UNIFIED_TRACES_DESTINATION_ENABLED` in any way.

So: **flipping ADOT to ≥0.18.0 and/or turning on unified per-agent span
destinations would not starve the SpanProjector or the legacy poller** — they
never drank from `aws/spans` to begin with. What actually consumes
`aws/spans` today is AWS's own console/API surface: `OrgIQ-AgentCoreTelemetry`
(`infra/lib/agentcore-telemetry-stack.ts`, `CfnEvaluator` / online evaluation
config / X-Ray Transaction Search), which is unrelated OrgIQ code reading
AWS-managed infra, not application code in this repo.

### Risk if unified per-agent groups were turned on anyway

- `infra/lib/agentcore-runtime-stack.ts:270-279` grants the execution role only
  `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` — **no
  `logs:PutResourcePolicy`**, which AWS's unified-telemetry doc lists as a
  hard requirement. Turning on `UNIFIED_TRACES_DESTINATION_ENABLED=true`
  without adding that permission would fail per-agent log delivery for the
  ADOT/OTLP pipeline (the AWS-native one — again, not the OrgIQ one).
- No agent runtime sets `UNIFIED_TRACES_DESTINATION_ENABLED` today (grep of
  `infra/` and `middleware/` for the string returns nothing), so all 8
  runtimes are implicitly on split telemetry (shared `aws/spans`) regardless
  of ADOT version — consistent with them predating the 2026-07-20 default-flip
  date.

### Minimal change list (spike a)

1. **No urgent code change required** for OrgIQ's own trace pipeline — it's
   architecturally decoupled from `aws/spans` and the ADOT version floor.
2. If/when someone wants AWS's native GenAI Observability console
   (Online Evaluation, CfnEvaluator, X-Ray Transaction Search) to use
   per-agent log groups instead of the shared one:
   - Bump the Dockerfile comment/floor to `aws-opentelemetry-distro>=0.18.0`
     explicitly (`agents/base/Dockerfile:30`) so the requirement is pinned in
     source rather than implied by "whatever PyPI has today."
   - Add `logs:PutResourcePolicy` to the `Logs` IAM statement in
     `infra/lib/agentcore-runtime-stack.ts` (~line 270-274).
   - Add `UNIFIED_TRACES_DESTINATION_ENABLED: 'true'` to each runtime's
     `environmentVariables` block (~line 429 onward), gated behind a CDK
     context flag the same way `readOnlyGraphRole`/`deployRuntimes` are, so
     it's an explicit opt-in with a warning like the existing
     `readOnlyGraphRole` pattern.
   - Verify CloudWatch Transaction Search is `ACTIVE` first (CLAUDE.md already
     names this prerequisite for ADOT tracing generally).
3. Nothing in `OrgIQ-SpanProjector` or `cw-trace-ingest.ts` needs to change
   either way — confirmed by reading both, they don't reference `aws/spans`.

### Verdict: safe offline?

Auditing the pin and reading the code is fully offline-safe (done here). But
**confirming what's actually running requires either an ECR image inspection
or a deploy** — "could not verify" the live installed ADOT version without
AWS creds. Actually turning on `UNIFIED_TRACES_DESTINATION_ENABLED` needs a
real deploy + redeploy of runtimes to test (new IAM policy, new env var, and
AWS's own console/evaluator surface to confirm log delivery) — not something
to validate by code-reading alone.

---

## Spike (b): Strands version-bump audit (>=1.39 pinned vs 1.55.1 live)

### Pin sites (all 9 agents)

`agents/base/Dockerfile:21` pins the shared floor `strands-agents>=1.39`
(plus `strands-agents-builder>=0.1`). Every per-agent `pyproject.toml` under
`agents/*/pyproject.toml` repeats `strands-agents>=1.39` identically:
advisor, assessment-drafter, assessment-scorer, graph-builder, ingestion,
scoring, search, supervisor (8 files; `devbox` has no Strands dependency —
it's not a Strands agent per CLAUDE.md). Same "unpinned floor, no lockfile"
situation as ADOT: whatever's on PyPI at image-build time is what ships.

### The two confirmed renames — neither is used in this repo

- **`LocalMemoryStore` → `TestMemoryStore`**, landed in Strands **v1.47.0**
  (2026-07-10). Source: strandsagents.com/changelog (fetched).
  `grep -rn "LocalMemoryStore\|TestMemoryStore"` across the repo (`*.py`,
  `*.md`) returns **zero code hits** — the only two hits are the research doc
  itself (`docs/research-agentcore-2026-09-15.md:121-122`) describing the
  rename, not a usage. **No change needed.**
- **`bash` tool → `shell`**, landed in Strands **v1.51.0** (2026-08-07,
  `make_bash` marked `typing_extensions.deprecated` same version). Source:
  strandsagents.com/changelog + GitHub `strands-agents/tools` issue #586 /
  PR #600 (fetched/searched). `grep -rn "\bbash\b" agents/**/*.py` returns one
  hit: `agents/devbox/main.py:158`, a comment — `"start_new_session: claude
  spawns children (bash tool calls, subagents)"` — describing **Claude Code's
  own bash tool** inside the devbox microVM, unrelated to the Strands SDK's
  vended tool. No agent in this repo imports `strands_tools.shell`/`bash` or
  `strands.vended_tools.shell`/`bash` at all. **No change needed.**

### Other changes in the 1.39→1.55 range worth flagging

Fetched strandsagents.com/changelog directly for the range:

| Version | Date | Change |
|---|---|---|
| 1.47.0 | 2026-07-10 | `LocalMemoryStore`→`TestMemoryStore` (unused here) |
| 1.51.0 | 2026-08-07 | `bash`→`shell` rename + `make_bash` deprecated (unused here) |
| 1.52.0 | 2026-08-12 | `ModelRouter`, `Agent(model=)` accepts it; "top level storage" |
| 1.53.0 | 2026-08-21 | **agent-as-tool delegation** added; Python memory-manager port |
| 1.54.0 | 2026-08-27 | "cache system prompt in auto mode" — flagged as a behavior change |
| 1.55.0 | 2026-09-08 | `backgroundTasks` on `Agent`; `web_fetch` vended tool |
| 1.55.1 | 2026-09-09 | Google/OpenAI model config simplification; notebook tool ported |

No documented breaking change to `BedrockModel()`, `StrandsTelemetry()`, or
the core `Agent()`/streaming call signatures the repo actually uses
(`agent(input_text, messages=messages)` in `agents/supervisor/main.py:737-739`,
`StrandsTelemetry()` in `instrumentation.py:119`) — **could not find** any
changelog entry naming those APIs as changed in this range. The one item
worth a real look before bumping is **1.54.0's "cache system prompt in auto
mode"**: OrgIQ's supervisor rebuilds its `Agent` on every system-prompt sha
change (`agents/supervisor/main.py:420-436`, `_agents_for_role`) specifically
so Prompt Studio edits land within `PROMPT_REFRESH_S`; if 1.54.0's new
"auto" caching mode caches the system prompt more aggressively than before,
it's worth confirming a rebuilt `Agent` object actually busts that cache
(a *new* `Agent` instance should get a fresh cache key regardless, but this
is exactly the kind of interaction a changelog one-liner won't surface —
**needs a real invoke to verify**, not just a code read).

### Native agent-as-tool vs `_invoke_sub_agent` — not a drop-in replacement

`agents/supervisor/main.py:95-145` (`_invoke_sub_agent`) hand-rolls A2A by
calling `boto3 bedrock-agentcore invoke_agent_runtime` directly against each
sub-agent's Runtime ARN (discovered via `list_agent_runtimes`,
`_get_runtime_arn`, lines 70-92), threading `parentInvocationId`/`userId`/
`sessionId` through a custom JSON payload it controls end-to-end. This is the
exact code the TraceContext gotcha in CLAUDE.md lives in
(`_handle_streaming` needing `set_active_ctx`/`_current_ctx.set` for A2A
topology edges, lines 547-551).

Checked both directions Strands offers for multi-agent delegation:

1. **In-process "agents as tools"** (fetched strandsagents.com docs): the
   orchestrator holds live `Agent` Python objects in its own `tools=[...]`
   list, in the same interpreter. This is **architecturally incompatible**
   with OrgIQ's deployment model — each of the 8 agents is its own separate
   AgentCore Runtime (own container/ECR repo/IAM execution role/guardrail
   attachment, per `infra/lib/agentcore-runtime-stack.ts`). Adopting this
   would mean collapsing all 8 runtimes into one process, which contradicts
   the whole per-agent-runtime design (independent scaling, independent
   lifecycle config `AGENT_LIFECYCLE`, per-agent IAM scoping like the
   read-only-graph-role split between search/advisor and the rest). Not
   applicable.
2. **`A2AAgent` (remote, standard A2A protocol)**: confirmed via
   strandsagents.com docs — it's a generic A2A client. It discovers a remote
   agent via `GET /.well-known/agent-card.json` and talks JSON-RPC 2.0 over
   plain HTTP(S) (`A2AAgent(endpoint="http://...")`). Confirmed via AWS's own
   devguide (`docs.aws.amazon.com/.../runtime-a2a.html`, fetched in full) that
   AgentCore Runtime **does** have a distinct, real A2A server mode — but it
   is a **different runtime protocol** than what's deployed today:
   - Requires `protocolConfiguration: 'A2A'` (today every runtime in
     `infra/lib/agentcore-runtime-stack.ts:427` is hard-coded
     `protocolConfiguration: 'HTTP'`).
   - A2A servers listen on **port 9000** at path `/`, not port 8080 at
     `/invocations` (the `BedrockAgentCoreApp`/`@app.entrypoint` pattern all
     9 agents use today, `agents/base/Dockerfile:58` `EXPOSE 8080 8000`).
   - The entrypoint code changes shape entirely: `serve_a2a(StrandsA2AExecutor(agent))`
     replaces `BedrockAgentCoreApp()` + `@app.entrypoint async def handle(...)`.
   - Auth is SigV4 **or** OAuth2/Cognito bearer token, fetched through a
     `/runtimes/<arn>/invocations/.well-known/agent-card.json` proxy path —
     not the same call shape as today's `invoke_agent_runtime(agentRuntimeArn=...,
     payload=...)`.
   - Carrying `parentInvocationId`/`userId`/`sessionId` (today: custom JSON
     keys the supervisor controls) would need to move into A2A's `Message`/
     `Part`/metadata envelope instead — a real protocol translation, not a
     config flag.
   - `bedrock-agentcore[a2a,ag-ui]` is already an installed extra for the
     supervisor (`agents/supervisor/pyproject.toml`) but **is never imported
     or used** in `agents/supervisor/main.py` — no `a2a` import anywhere in
     that file. The extra is currently dead weight relative to what the code
     actually does (raw boto3 `invoke_agent_runtime`, no A2A protocol
     library).

**Verdict:** native agent-as-tool does not replace `_invoke_sub_agent` as a
drop-in. It's a legitimate but *substantial* re-architecture (new runtime
protocol, new port/path, new auth model, new instrumentation-context wiring)
— not something to fold into a routine version bump. Worth its own scoped
follow-up spike (a single sub-agent, e.g. `search`, ported to A2A mode and
tested against a live deploy), not a code-only change.

### Minimal change list (spike b)

1. **Bump the floor is safe to attempt offline first**: change
   `strands-agents>=1.39` → `>=1.55` (or pin exactly `==1.55.1`) in
   `agents/base/Dockerfile:21` and all 8 `agents/*/pyproject.toml` files.
   Neither confirmed rename touches any file in this repo, so the bump alone
   shouldn't break the two known landmines.
2. Rebuild `agents/base` (`agents/base/build.sh`) then run the existing
   agent unit tests (`agents/_shared/test_prompt_source.py`,
   `test_callbacks.py` per CLAUDE.md) plus the two `sql_guard.py` attack-table
   tests as a smoke check that nothing in `_shared/` broke.
3. **Before calling the bump done**, exercise at minimum the supervisor's
   streaming path (`_handle_streaming`) and one A2A sub-agent call
   end-to-end against a real (or `agentcore dev`) deploy — the 1.54.0
   system-prompt-caching change specifically touches the mechanism
   `_agents_for_role` relies on to pick up live Prompt Studio edits, and that
   can't be verified by reading code alone.
4. Do **not** attempt the A2A-protocol migration as part of this bump — track
   it as a separate, larger spike per the "Native agent-as-tool" section
   above.

### Verdict: safe offline?

The version-bump-and-grep part (steps 1-2) is safe and fully checkable
offline — done here, nothing found. Confirming the bump doesn't regress live
behavior (system-prompt caching interaction, actual runtime behavior under
1.55.x) needs `agentcore dev` or a deployed test, per CLAUDE.md's own
guidance that `agentcore dev` (not `agentcore deploy`) is the right tool for
this kind of local verification before a real CDK deploy.

---

## Sources

- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-telemetry.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html
- https://strandsagents.com/changelog/
- https://strandsagents.com/docs/user-guide/concepts/multi-agent/agents-as-tools/
- https://strandsagents.com/docs/user-guide/concepts/multi-agent/agent-to-agent/
- https://strandsagents.com/docs/user-guide/concepts/memory/test-memory-store/
- https://github.com/strands-agents/tools/issues/586
- https://github.com/strands-agents/tools/pull/600
- https://pypi.org/project/aws-opentelemetry-distro/ (version number only,
  via search — did not fetch the raw PyPI page directly)
