# AgentCore / Strands: what's new as of Sept 2026, vs. what this repo uses

Baseline read: `docs/agentcore-preview-surface.md` (§1-4, verified against CDK 2.253.1/2.265.0
deltas, boto3 1.42.92/1.43.34, blog-driven) and `docs/agentcore-preview-plan.md` (devbox v2,
Phases 0-4, session storage + lifecycle + command API). Primary source for new items: the
official AWS release notes page (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html),
cross-checked against AWS What's New posts. Strands: strandsagents.com/changelog (current pypi
1.55.1, repo pins >=1.39).

---

## Ranked findings (12)

### 1. AgentCore Harness reached GA June 17-18, 2026 — the doc's speculative §4.6 is now real
**Source:** https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-harness-generally-available/ · release notes "AgentCore Harness is now Generally Available" (June 2026)
Managed, container-free agent runtime: `CreateHarness`/`InvokeHarness`, no Dockerfile/ECR/ARM64
build. GA added built-in memory (or BYO), more model providers via LiteLLM + Bedrock Mantle
(unlocks OpenAI GPT-5.5/5.4 on Bedrock — irrelevant here, AWS-native-only), the AWS skills
catalog, evaluations/optimization, unified observability, versioning/endpoints, and **"export to
Strands code."** Also: BYO S3-Files/EFS filesystems on harnesses (May 2026), Step Functions
native integration (June 2026), MCP tool-result metadata streaming (July 2026).
**(b) Concrete gap.** `agentcore-preview-plan.md` §"Phase 4 — CfnHarness spike (time-boxed)" was
written against a preview-only, CDK-2.265.0-gated resource. It's GA now, in the installed CDK
range, and materially more capable than what the plan describes. The plan's crux question —
"does `agents/_shared/instrumentation.py`'s root AGENT span still work under a managed harness"
— is now answerable by a real spike, not a hypothetical. Worth re-running Phase 4 as the next
real experiment rather than a deferred footnote. Naming collision warning in the surface doc
(`middleware/src/routes/harness.ts` is unrelated evaluation-harness code) still applies.

### 2. AgentCore Runtime now has native AG-UI protocol support (WebSocket, bidirectional) — not mentioned anywhere in the existing docs
**Source:** release notes, March 2026 block, "Runtime: AG-UI Protocol Support"; also "Integrations: AG-UI Partnership with CopilotKit" (April 2026) — AgentCore listed as a first-party deployment target in the AG-UI GitHub repo.
Runtime-level streaming of text chunks, reasoning steps, tool calls/results, UI state sync, and
bidirectional WebSocket transport — built into the Runtime data plane itself, not a
library-in-container concern.
**(b) Concrete gap.** This repo implements AG-UI entirely at the agent-code layer
(`ag-ui-strands` + Strands `Agent`, per CLAUDE.md conventions) and proxies it through the
middleware as SSE-over-POST (`middleware/src/routes/agents.ts`, `providers/agentcore.ts:585`).
Neither `agentcore-preview-surface.md` nor `-plan.md` mentions Runtime-native AG-UI at all — it
postdates the SSE/POST convention documented in CLAUDE.md's "Conventions" section. Worth a
research spike: does native support reduce the middleware's proxy/SSE-framing code, and is
WebSocket transport compatible with the ALB `openListener:false` posture noted in the
Gotchas (custodian revokes open ingress)?

### 3. Runtime: unified per-agent CloudWatch log group for spans (July 2026, default since July 20)
**Source:** release notes, July 2026, "Runtime: Unified span destination for agents"
Agents can now send spans to `/aws/bedrock-agentcore/runtimes/<agent_id>-<endpoint_name>` (a
`spans` log stream, alongside stdout/structured logs) instead of the shared `aws/spans` log
group. Toggle: `UNIFIED_TRACES_DESTINATION_ENABLED`. **Requires ADOT >=0.18.0** and
`logs:PutResourcePolicy` on the execution role. New agents created after July 20, 2026 default
to per-agent; agents created earlier keep the shared group unless opted in.
**(b) Concrete gap.** Directly touches the repo's most load-bearing observability gotcha (the
shared `aws/spans` group + the `OrgIQ-SpanProjector` Lambda + the CloudWatch log poller in
`lib/cw-trace-ingest.ts`). Two things to check before adopting: (1) `agents/base/Dockerfile`
currently pins `aws-opentelemetry-distro>=1.12.1` per CLAUDE.md's table — needs a version check
against 0.18.0 (note the versioning schemes differ; verify the actual installed ADOT version,
not just assume it satisfies this). (2) Whether the SpanProjector Lambda and/or
`OBU_USE_LEGACY_POLLER` CloudWatch poller currently hard-code the shared `aws/spans` group name
— if so, switching any agent to per-agent spans silently starves both until they're updated to
scan per-agent groups too. Also unlocks IAM/encryption scoping per agent, useful given the
multi-tenant (orgiq/assessment) posture.

### 4. Amazon Bedrock Managed Knowledge Base reached GA (June 2026) — a possible structural fix for the KB reverse-ranking bug class
**Source:** release notes, June 2026, "Amazon Bedrock Managed Knowledge Base is now Generally Available"
Fully managed RAG pipeline queried through the Gateway: 6 native connectors (S3, SharePoint,
Confluence, Google Drive, OneDrive, Web Crawler), automatic sync, managed vector storage,
hybrid search, document ranking, and multi-modal content (text/video/audio/image) built in.
**(b) Concrete gap, high value, big lift.** CLAUDE.md's single most expensive gotcha is the
default-search-type reverse-ranking bug against the hand-rolled Aurora/pgvector KB (`Retrieve`
without `overrideSearchType` returning results in reverse relevance order — top-1 correct 0/8 on
default, 8/8 on HYBRID). That bug required pinning `HYBRID` search type at three production call
sites plus four notebook cells, and a GIN text index the KB stack must create in lockstep with
the HNSW index. It's exactly the kind of "ranking/index footgun" a managed pipeline exists to
absorb. Migrating is a real project (new KB type, new ingestion path, revisits
`schema/synth/load.py`'s KB sync, the KB registry reconcile logic in `kb-reconcile.ts`), so this
is a research-spike candidate, not a drop-in — but worth scoping given how much pain the current
approach has already cost.

### 5. AgentCore Policy now enforces Bedrock Guardrails at the Gateway layer, not just per-role at model-build time
**Source:** release notes, June 2026, "AgentCore Policy Now Supports Bedrock Guardrails"
Guardrails now evaluate gateway-target inputs and authorized-action outputs at the Gateway layer
— "outside the agent's code, where the agent cannot reason around them." Every tool/context
source routed through the gateway inherits the same governance automatically. Policy authored in
natural language or policy-as-code.
**(b) Concrete gap.** CLAUDE.md's current design attaches the role-specific guardrail
"at model-build time" inside the supervisor — i.e., inside agent code, which per this release
note is exactly the weaker boundary AWS is calling out. `OrgIQ-Guardrails` (per-role
`CfnGuardrail`) and `OrgIQ-AgentCorePolicy` (`CfnPolicyEngine`) both exist already; this is an
incremental hardening of a stack already deployed, not a new stack. Worth a design note on
whether gateway-layer enforcement should supersede or supplement the current build-time
attachment, particularly for the read-only SQL guard gotcha (`sql_guard.py`) — a second layer
that can't be reasoned around by a prompt-injected document is directly on point.

### 6. Runtime: enforce that invocations only originate from the Gateway (SigV4 `aws:SourceArn` / OAuth `allowedWorkloadConfiguration`)
**Source:** release notes, June 2026, "Gateway: Enforce inbound traffic from the gateway"
Lets a Runtime reject any invocation that didn't come through its Gateway — resource-based
policy + `aws:SourceArn` condition for IAM/SigV4 runtimes, `allowedWorkloadConfiguration` for
OAuth/JWT runtimes.
**(b) Concrete gap.** Directly usable defense-in-depth for the "direct-invoke of a write agent
requires `ManageIngest`" gotcha (`WRITE_AGENT_RE` in `routes/agents.ts`) — today that gate lives
entirely in middleware application code. Forcing graph-builder/ingestion/scoring runtimes to
reject anything not routed through `OrgIQ-AgentCoreGateway` would move part of that boundary into
IAM, independent of middleware code correctness. Cheap to evaluate since the Gateway stack
already exists.

### 7. Runtime: new "Instances" compute type — EC2-backed, in-account, up to 14-day sessions, GPU-capable (Aug 2026)
**Source:** release notes, August 2026, "Runtime: Instances compute type with capacity providers"
An alternative to the default microVM compute: agents run on AWS-managed EC2 in the customer's
own account via a capacity provider (OS, instance types, networking, storage); supports
persistent sessions to 14 days, GPU instance types, multiple agents sharing an instance, and
existing Savings Plans/ODCRs. Linux x86_64/arm64 at launch.
**(b) Concrete gap, worth a look for `orgiq-devbox` specifically.** The devbox plan already
fights the microVM's constraints (1 GB workspace, 8 h max lifetime, wipe-on-deploy from
digest-pinning) by treating `/mnt/workspace` as a cache and pushing work out via git. An
EC2-backed Instance with a 14-day session and data staying in-account could remove several of
those workarounds for exactly the "safe to close your laptop" scenario the devbox exists for.
Not relevant to the other 8 read/write OrgIQ agents.

### 8. Strands Agents: native agent-to-agent delegation ("agent-as-tool") since ~1.4x, current 1.55.1
**Source:** strandsagents.com/changelog (fetched); repo pins `strands-agents>=1.39`, live is 1.55.1 (Sept 9, 2026)
Multi-agent support now lets an agent delegate to another agent as a plain tool call, alongside
newer session/memory features (durable message IDs, `TestMemoryStore` rename from
`LocalMemoryStore`, agentic context management, prompt caching via `cache_config`/`cache_tools`,
`ModelRouter`, `backgroundTasks` on `Agent`).
**(b) Concrete gap.** The supervisor's `_invoke_sub_agent` / A2A invocation path
(`agents/supervisor/main.py`) is hand-rolled — it's also the exact code the TraceContext gotcha
lives in (`_handle_streaming` needing to set `_current_ctx` for A2A topology edges). Worth
checking whether native agent-as-tool delegation would simplify that hand-rolled path or whether
it's Strands-native-agent-to-Strands-native-agent only (i.e., not compatible with the
AgentCore-Runtime-to-Runtime A2A hop this repo actually does). Given the repo is >15 minor
versions behind pinned floor, a version-bump audit is due regardless, independent of this one
feature.

### 9. Gateway: customer-configurable rate limits, dimensioned by JWT claim / IAM principal / tool / model (Sept 2026)
**Source:** release notes, Sept 2026, "Gateway: Configurable rate limits"
Six new APIs (`CreateRateLimit` etc.) for RPS/RPM, TPM (token-based), and connection-rate limits,
scoped per caller/target/tool/model, evaluated with most-specific-match-wins, propagating to the
data-plane fleet in ~30s, fail-open on transient errors.
**(c) Interesting, likely irrelevant as-is.** The repo's actual budget/dispatch governance (sprint
envelopes, `decideRunBudget`/`decideAllocation`/`decideEnvelope` in `lib/bot-runner.ts`) is
Aurora-row-based money accounting, not per-request inference throttling, and doesn't route
through `OrgIQ-AgentCoreGateway` for those decisions today. Flagging because a JWT-claim-scoped
rate limit *could* eventually back a "per-SME token budget" primitive, but adopting it would mean
routing agent inference through the Gateway in a way the architecture doesn't currently do —
speculative, not a drop-in gap.

### 10. AgentCore Evaluations: skill evaluators, third-party evaluators (DeepEval/AutoEval), TypeScript framework support (Aug-Sept 2026)
**Source:** release notes, Aug 2026 ("Evaluations: Skill evaluators", "Evaluations: Third-party evaluators"), Sept 2026 ("Evaluations: TypeScript agent framework support")
Two new built-in skill-level evaluators (`SkillSelectionAccuracy`, `SkillInstructionFollowing`);
managed or derived evaluators sourced from DeepEval/AutoEval, discoverable via `ListEvaluators`
alongside built-ins; TypeScript-framework agent support (irrelevant here — agents are Python).
**(b) Minor concrete gap.** `OrgIQ-AgentCoreTelemetry` (`CfnEvaluator`) and the judge-config
surface (`/iq/evaluations`, `middleware/src/lib/judge-config.ts`) are a hand-rolled LLM-as-judge
system parallel to AWS's own evaluator catalog. Third-party evaluators (DeepEval/AutoEval) are
plausibly a faster path to more rubric coverage than growing the hand-rolled judge further; worth
noting in the evaluations doc trail even though nothing here demands a change now.

### 11. Failure Insights — public preview (June 2026)
**Source:** release notes, June 2026, "Failure Insights is now in Public Preview"
Mines production traces across hundreds of sessions for recurring failure patterns — including
silent behavioral failures with no error signal — explains root cause, ranks by prevalence.
Scheduled (daily/weekly) or on-demand after a deploy/complaint spike.
**(b) Loose gap, preview caution.** Overlaps conceptually with the repo's own
`errorRate`/`lowQualityRate` split (the "Error rate ≠ answer quality" gotcha) and the prompt
canary's judge-based regression detection. Since it's still Preview, treat as a watch item rather
than something to build against — but it's aimed at exactly the "healthy-looking traces, silently
bad answers" problem this repo has already paid real debugging cost to detect by hand.

### 12. AWS CDK AgentCore L2 constructs graduated from alpha to stable (May 2026, aws-cdk-lib 2.255.0)
**Source:** release notes, May 2026, "AWS CDK: AgentCore Constructs Graduate to Stable"; https://github.com/aws/aws-cdk/releases/tag/v2.255.0
`aws-bedrockagentcore` L2 constructs (runtime, memory, gateway, identity, and more) are now in
mainline `aws-cdk-lib` with backward-compat guarantees — no separate `-alpha` package. The Policy
submodule stays alpha.
**(a)/(c) Already effectively covered, low urgency.** `agentcore-preview-surface.md` already
documents the repo's deliberate choice to hand-build `CfnRuntime` (L1) directly rather than use
L2s, for fine-grained control over exactly the props (`filesystemConfigurations`,
`lifecycleConfiguration`) this doc's Phase 1 targets. L2 stability doesn't change that
calculus — noting it mainly so a future CDK-bump pass (Phase 3 in the plan) knows the L2 path now
exists as an option, not just L1.

---

## Recommended next research spikes

1. **Time-box a `CfnHarness` spike now that it's GA** (item 1) — the plan's own crux question (does `instrumentation.py`'s root AGENT span survive a managed harness) is answerable with a real deploy; this unblocks or kills the whole Phase 4 line.
2. **Audit ADOT version against the 0.18.0 floor** for unified per-agent span destinations (item 3) — cheap, and directly informs whether the SpanProjector/CloudWatch-poller code needs updating before any agent can safely opt in.
3. **Scope a Managed Knowledge Base migration spike** (item 4) — specifically: does it avoid the default-search-type reverse-ranking failure mode by construction, and what would it cost to replace the Aurora/pgvector KB + HYBRID pinning + GIN-index lockstep dependency.
4. **Check whether Runtime-enforced Gateway-origin invocation** (item 6) can be layered onto the existing `WRITE_AGENT_RE` middleware gate for graph-builder/ingestion/scoring with no architecture change — likely the cheapest concrete win on this list.
5. **Strands version-bump audit**: repo pins `>=1.39`, live is 1.55.1 — run the pinned agents against latest and check for the two confirmed renames (`LocalMemoryStore`→`TestMemoryStore`, bash tool→shell) and whether `_invoke_sub_agent`'s hand-rolled delegation has a native replacement worth adopting.
