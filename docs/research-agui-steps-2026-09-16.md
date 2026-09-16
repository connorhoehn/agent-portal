# Research: making the AG-UI run-phase stepper show real phases

Read-only spike. Builds on `docs/research-agentcore-2026-09-15.md` (item 2: AgentCore
Runtime native AG-UI exists, undocumented elsewhere) and
`docs/research-versions-spike-2026-09-16.md` (Strands 1.39→1.55 bump, `a2a` extra
unused) — not repeating either. Portal side verified in repo: the stepper and
reasoning accumulation are real and already generic. The gap is upstream, in what
the supervisor emits.

## 0. What the repo does today (verified in repo)

- `agents/supervisor/main.py:610-623` (`_handle_streaming`) does `async for event in
  ag_ui_agent.run(run_input): ... yield event` — it forwards whatever `ag_ui_strands`
  produces, filtering only `TEXT_MESSAGE_CONTENT` to accumulate the trace's response
  text. It never constructs a `STEP_STARTED`/`STEP_FINISHED` or `REASONING_*` event
  itself; every such event comes from the `StrandsAgent` adapter built at
  `agents/supervisor/main.py:436-444`.
- `agents/supervisor/main.py:95-145` (`_invoke_sub_agent`) is a plain `boto3
  bedrock-agentcore invoke_agent_runtime` call wrapped in `@tool`-decorated
  functions (`search_organization` etc.) — not Strands' native Graph/Swarm
  multi-agent orchestration. Matters directly for §1.
- Portal: `portal/src/pages/InvokePage.tsx:789-798` renders `WorkflowStepper` from
  `steps` whenever `isStreaming && steps.length > 0`, reset every `RUN_STARTED` —
  real, generic UI. The "one mock step" is a property of what the agent sends, not
  a portal limitation.
- Client hook (outside this repo, `realtime-modules`, so not editable from here per
  CLAUDE.md): `useAgentStream.ts:338-381` already handles `STEP_STARTED`/
  `STEP_FINISHED` and both `REASONING_MESSAGE_CONTENT`/`REASONING_MESSAGE_CHUNK`,
  reset on `RUN_STARTED`.

## 1. Does `ag-ui-strands` emit STEP_STARTED/STEP_FINISHED and REASONING_*?

Fetched `ag_ui_strands/agent.py` directly (github.com/ag-ui-protocol/ag-ui,
integrations/aws-strands/python/src/ag_ui_strands/agent.py, 7443 lines, fetched
2026-09-16). Two unconditional mappings:

- **STEP events are multi-agent-only.** They fire exclusively off Strands'
  `multiagent_node_start`/`multiagent_node_stop` callbacks (agent.py:6118-6139),
  which Strands' **Graph/Swarm orchestration** emits per node
  (`_multiagent_step_name`, agent.py:2723-2728, builds `"{node_type}:{node_id}"`).
  A plain `@tool` call instead produces `TOOL_CALL_START`/`ARGS`/`END`/`RESULT`
  (agent.py:1978-2040, 6779-6940). **Our supervisor's hand-rolled `@tool` + boto3
  `invoke_agent_runtime` routing produces tool-call events, never STEP events, no
  matter how new the adapter version is.**
- **REASONING events are automatic and model-driven.** The adapter watches
  Strands' raw callback dict for `"reasoningText" in event and event.get
  ("reasoning")` (agent.py:6025-6046, second arm ~3975) and emits `REASONING_START`
  → `REASONING_MESSAGE_START` → `REASONING_MESSAGE_CONTENT` deltas →
  `REASONING_MESSAGE_END`/`REASONING_END`, plus `REASONING_ENCRYPTED_VALUE` for
  redacted content (agent.py:6047-6081). `BedrockModel` surfaces this straight from
  Converse's `reasoningContent.reasoningText.text` blocks — if the model never
  emits `reasoningContent`, nothing fires; there's no agent-code switch to flip.

Source: https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/aws-strands/python/src/ag_ui_strands/agent.py

## 2. Does Nova Pro/Premier expose `reasoningContent`?

`reasoningContent` is a real Converse block, enabled per-call via
`additionalModelRequestFields.reasoningConfig` (`type: "enabled"`,
`maxReasoningEffort: low|medium|high`), default disabled
(docs.aws.amazon.com/nova/latest/userguide/extended-thinking.html, fetched
2026-09-16, flagged "Version 1" docs). Its worked example uses
`amazon.nova-lite-1-5-v1:0`, not plain `amazon.nova-pro-v1:0`.

**`amazon.nova-pro-v1:0` — CLAUDE.md's stated fleet default (the supervisor's own
literal default is actually `nova-lite-v1:0`, `main.py:54`) — does not support
`reasoningConfig` at all.** A GitHub issue documents `ValidationException` on every
sample when `reasoning_effort` is set against Nova Pro
(github.com/UKGovernmentBEIS/inspect_ai/issues/5301, via WebSearch, not
independently fetched). Only **Nova 2** models support extended thinking — Nova 2
Lite GA, Nova 2 Pro Preview-only
(aws.amazon.com/about-aws/whats-new blog, "Introducing Amazon Nova 2 Lite", fetched
via search 2026-09-16). **Consequence: REASONING_* events cannot fire on the
currently pinned model at all — getting them needs a Nova 2 model id, a real model
change, not a library bump.** Strands' handling is passive: it just forwards
whatever `reasoningContent` Converse returns (WebSearch of `sdk-python` issues
#79/#99, corroborating, not independently fetched).

## 3. Does AgentCore Runtime's native AG-UI support add STEP events itself?

Fetched the devguide contract page directly
(docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html,
2026-09-16). It's a **transport/container contract only**: port 8080,
`/invocations` (SSE) and `/ws` (WebSocket), session-id header injection, SigV4/OAuth
auth, `RUN_ERROR`-everywhere error model. It generates **no AG-UI event itself** —
the example stream (`RUN_STARTED` → `TEXT_MESSAGE_*` → `TOOL_CALL_*` →
`RUN_FINISHED`) is explicitly what *your container* must emit; the Runtime "passes
request payloads directly to your container without validation." So native Runtime
AG-UI support changes nothing about whether STEP/REASONING appear — that's still
100% determined by the agent process (§1). No middleware/agent-code change is
forced by it, but no free STEP events come from it either. The March 13, 2026
announcement (aws.amazon.com/about-aws/whats-new/2026/03/...) is marketing-level
and doesn't resolve origination on its own; the contract page is the primary source
that does.

**Middleware SSE proxy**: today's proxy (`routes/agents.ts`,
`providers/agentcore.ts:585` per the 2026-09-15 doc) already speaks SSE-over-POST
against `/invocations`; nothing here requires moving to `/ws` or changes event
framing, so no proxy change is required to receive whatever STEP/REASONING events
the agent emits. Could not verify whether the deployed runtimes' AG-UI wiring rides
the Runtime's native March-2026 surface vs. `BedrockAgentCoreApp`'s own handling —
needs `describe-agent-runtime` (AWS creds), not visible from the CDK stack alone.

## 4. AG-UI spec: STEP vs ACTIVITY/CUSTOM, 2026 changes

Fetched docs.ag-ui.com/sdk/js/core/events (2026-09-16). `STEP_STARTED`/
`STEP_FINISHED` are pure lifecycle markers — just `stepName: string`, matched
between the pair, no content payload — for "internal phases like LangGraph node
names and plan steps." `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` are richer: keyed by
`messageId`+`activityType`, carry structured content or JSON-Patch deltas, meant
for renderable widgets excluded from LLM history. `CUSTOM` is the unstructured
escape hatch, which is what `ag_ui_strands` uses for multi-agent handoff/cancel/
interrupt (§1) instead of STEP, since those need structured payloads STEP's schema
can't hold. **2026 spec change confirmed**: `THINKING_*` events are deprecated
(removal at v1.0.0), superseded by `REASONING_*` — the same names this repo already
uses, so it's on current naming, not deprecated. No evidence of a broader STEP-vs-
ACTIVITY redesign beyond that rename.

## What's shippable, what needs a pin move, what needs AWS creds

**Shippable today, agent-code only:** Nothing gets true STEP phases
("routing → sub-agent → answer") for free — Graph/Swarm is architecturally
incompatible with the per-Runtime A2A design (per the versions-spike doc). The
concrete, low-effort option: hand-emit `StepStartedEvent`/`StepFinishedEvent`
(trivial schema, just a matched `step_name`) around each `_invoke_sub_agent` call
inside `_handle_streaming`'s event loop — realistically per-sub-agent-call spans
(`sub-agent:search`, `sub-agent:scoring`), not a true "routing" phase, since
routing *is* the model turn before any tool is chosen and nothing observes that
turn's start today. This is a code change in `agents/supervisor/main.py`, not
proposed here (read-only task). REASONING events need no agent-code work — they
already flow through automatically once the model emits `reasoningContent`.

**Needs a pin move:** `ag-ui-strands` floor is `>=0.1.8` (`agents/base/Dockerfile:25`);
live PyPI is **0.4.0** (released 2026-09-11, five days before this note). No
lockfile exists, so a fresh base-image build already pulls 0.4.0 regardless of the
stated floor — the mapping in §1 is already what ships. Still worth bumping the
literal floor so the requirement is pinned rather than implied (mirrors the ADOT
recommendation in the prior spike). Could not determine exactly which version
between 0.1.8 and 0.4.0 introduced the multiagent→STEP mapping (15+ releases in
between, changelog not fetched) — moot given no lockfile, but worth knowing before
pinning an exact version. Separately: real REASONING events need moving off
`amazon.nova-pro-v1:0`/`nova-lite-v1:0` to a Nova 2 model id *and* setting
`reasoningConfig` — a deliberate model choice with cost/latency tradeoffs
(reasoning tokens bill as output; `high` effort forgoes streaming until a final
chunk), not a version bump, and should go through the AWS-native-models gate
explicitly.

**Needs AWS credentials (could not check offline):**
- Whether the 8 deployed runtimes' AG-UI wiring rides the native March-2026
  Runtime surface — `describe-agent-runtime` per runtime.
- The actual installed `ag-ui-strands`/`ag-ui-protocol` versions in the live ECR
  images (no lockfile — same caveat the ADOT spike flagged for that package).
- Whether Nova 2 Lite/Pro are enabled for this account/region, and real
  reasoning-token cost/latency at `high` effort against a representative query.

## Shipped (2026-09-16)

`_handle_streaming` (`agents/supervisor/main.py`) now synthesizes STEP_STARTED/
STEP_FINISHED around each sub-agent routing tool call, keyed off the existing
TOOL_CALL_START/TOOL_CALL_RESULT events (not TOOL_CALL_END — that fires on
args-complete, before the sub-agent call returns). Tests in
`agents/supervisor/test_step_events.py`.
