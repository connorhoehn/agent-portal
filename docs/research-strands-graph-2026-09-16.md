# Research: should the supervisor route via a Strands Graph instead of hand-rolled tools?

Read-only spike, builds on `docs/research-agui-steps-2026-09-16.md` (STEP events
are Graph/Swarm-only; our routing produces TOOL_CALL events instead). Question:
adopt `strands.multiagent.graph`/`Swarm` for supervisor→sub-agent routing, or keep
the hand-rolled `@tool` + `invoke_agent_runtime` design (`agents/supervisor/main.py`)?

## 0. What's actually deployed today (verified in repo)

- `_invoke_sub_agent` (`main.py:95-137`) is a plain `bedrock-agentcore`
  **`invoke_agent_runtime`** boto3 call wrapped by four `@tool` functions
  (`SUPERVISOR_TOOLS`, `main.py:319-321`). Its own docstring calls this "the
  AgentCore A2A invoke API" — that's a misnomer; it is the Runtime invoke API,
  not the A2A protocol (different wire formats, see §4).
- Every one of the 8 agent images actually ships `bedrock-agentcore[a2a,ag-ui]`,
  not just the supervisor's. `agents/base/Dockerfile:21-25` installs that fixed
  extras set once into the shared base image; the per-agent `pyproject.toml`
  files (7 say `[ag-ui]`, only supervisor's says `[a2a,ag-ui]`) are never
  actually `uv sync`'d — `Dockerfile.agent` copies site-packages straight from
  the base image. CLAUDE.md's "the supervisor alone pins `[a2a]`" describes the
  *declared* pin, not the *installed* one; `a2a` ships everywhere, unused.
- Only the supervisor per-role-builds its `Agent` (`_build_agent`,
  `main.py:377-383`, keyed on `(tenant, role)` in `_agents_for_role`,
  `main.py:415-433`) with a role-specific guardrail attached at model-build time
  (`_model_kwargs`, `main.py:358-375`). Sub-agents attach one **fixed**
  guardrail from their own `GUARDRAIL_ID` env, no per-role branching (verified:
  `agents/search/main.py:327-331`). Role-aware guardrailing is a
  supervisor-only concern, orthogonal to how it dispatches to sub-agents.
- `_invoke_sub_agent` threads `parentInvocationId`/`userId`/`sessionId` from the
  active `TraceContext` (`agents/_shared/instrumentation.py:226-268`) into the
  sub-agent payload; `_handle_streaming` establishes that context via
  `with_orgiq_root` before the tool-call loop (`main.py:594-690`) — this is what
  makes `/api/topology/a2a` show edges for real traffic.

## 1. What strands-agents 1.55+ provides for multi-agent orchestration

Four named patterns (Strands docs, fetched 2026-09-16):
[Multi-agent Patterns](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/),
[Graph](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/),
[Swarm](https://strandsagents.com/docs/user-guide/concepts/multi-agent/swarm/),
[Agent-to-Agent](https://strandsagents.com/docs/user-guide/concepts/multi-agent/agent-to-agent/).

- **Agents-as-Tools** — an orchestrator `Agent` decides at runtime which
  specialist to call via a tool. This is the *named, documented pattern our
  supervisor already implements*, just against a remote runtime instead of an
  in-process sub-`Agent` — not an unsupported shape, one of the four.
- **Graph** — deterministic directed graph (`GraphBuilder.add_node`/`add_edge`).
  A dependent node's input auto-composes as "the original task" plus "results
  from all completed dependency nodes." **Conditional edges** are plain Python
  functions over `GraphState` (+ optional `invocation_state` for feature
  flags/roles) returning bool — branching is code, not a model tool-call
  decision. Supports cycles (`max_node_executions`), per-node timeout
  overriding a graph-wide `execution_timeout`, and concurrent node execution.
- **Swarm** — autonomous handoff with shared memory, no central router; docs
  note it "needs four separate safety mechanisms" (more autonomy, more failure
  surface). Not a fit for a role/tenant-gated, auditable supervisor.
- **Streaming**: `stream_async()` on Graph/Swarm emits `multiagent_node_start` →
  `multiagent_node_stream` → `multiagent_node_stop`
  ([sdk-python PR #961](https://github.com/strands-agents/sdk-python/pull/961),
  merged 2025-10-31). `ag_ui_strands` maps exactly these three callbacks to
  `STEP_STARTED`/`STEP_FINISHED` (confirmed yesterday, `agent.py:6118-6139`) —
  the entire source of the STEP events this research thread started from.
- **Node executor type**: `add_node()` accepts any `AgentBase` implementation,
  not only `Agent` — per the Graph docs page (node types include "remote
  `A2AAgent` instances") and a WebSearch-sourced example,
  `builder.add_node(A2AAgent(endpoint=...), "research")`, not independently
  fetched as a working sample — treat the exact call signature as illustrative.

## 2. The crux: does a Graph node accept our remote runtimes?

**Yes in principle, but not via the transport we use today.** `A2AAgent`
(`strands.agent.a2a_agent`, requested in
[sdk-python issue #907](https://github.com/strands-agents/sdk-python/issues/907),
opened 2025-09-22) is a client wrapper for the **A2A protocol** — JSON-RPC over
HTTP, discovering the remote agent at `/.well-known/agent-card.json` (A2A docs
page, fetched 2026-09-16). It implements `AgentBase`, so `GraphBuilder` takes it
like any local `Agent`, streaming via `A2AStreamUpdateEvent`.

**That protocol is not what `_invoke_sub_agent` speaks.** The A2A docs page
never mentions `invoke_agent_runtime`; A2A is "a separate, open standard
protocol independent of AWS-specific services." For a Graph node to reach
`orgiq-search` etc., each sub-agent runtime would need to run an `A2AServer`
(the Strands class that exposes an agent as a network service) as a **second
listener**, distinct from the `BedrockAgentCoreApp` entrypoint at :8080 they run
today. AWS does support hosting A2A servers on AgentCore Runtime — [AWS
Marketplace A2A server support](https://aws.amazon.com/about-aws/whats-new/2025/11/marketplace-a2a-server-bedrock-agentcore-runtime/)
(2025-11-19) — but that's framed around *installing* third-party A2A products,
says nothing about a first-party agent adding its own `A2AServer`, and never
mentions `invoke_agent_runtime`. **A Strands Graph with `A2AAgent` nodes wired
to our own runtimes is an architecture change (every sub-agent grows an A2A
server surface), not a drop-in replacement for the boto3 call we already make.**

## 3. What Graph would buy, and what it would cost or risk

**Gain:** native `STEP_STARTED`/`STEP_FINISHED`, retiring the hand-emitted pair
shipped 2026-09-16 (`SUB_AGENT_STEP_NAMES`, `main.py:511-527`). Conditional
edges move branching into inspectable Python — but something still has to
*classify* "who knows auth best?" vs "team gaps?"; realistically that's still an
LLM router node whose output a conditional edge inspects, comparable complexity
to today's tool-call routing, not strictly simpler. Per-node timeout/retry and
concurrent node execution enable real fan-out (search + scoring in parallel),
which sequential `@tool` calls inside one Agent turn cannot do.

**Cost/risk, checked against what's real here:**
- Guardrail-per-role, Cedar/authz, and the Bedrock-Prompt-Management refresh
  (`_model_kwargs`, `resolve_system_prompt`, `_agents_for_role`) are all
  supervisor-Agent-build concerns — orthogonal to the routing shape, survive a
  Graph rewrite unchanged as long as the supervisor's own node stays a
  per-(tenant,role) `Agent`.
- `parentInvocationId` threading for A2A topology edges is hand-done inside
  `_invoke_sub_agent` today. `A2AAgent`/`A2AStreamUpdateEvent` has its own
  task/context model (§2); whether it carries an equivalent field the trace-sink
  can read is **unverified** — if not, `/api/topology/a2a` breaks silently until
  rebuilt for the new transport.
- Whether Graph's per-node spans nest correctly under `with_orgiq_root`'s single
  root AGENT span is **unverified** — needs a local `agentcore dev` run with a
  toy Graph.
- Both sub-agent code (add `A2AServer`) **and** supervisor code (swap `@tool`
  functions for `A2AAgent` nodes) change — touches all 8 agent images, not
  supervisor-only.

## 4. Is AgentCore-native A2A the better fit than Graph?

A2A and Graph aren't alternatives — Graph is the orchestration shape, A2A is one
possible *transport* a Graph node uses to reach a remote agent. The real
question is A2A transport vs. today's `invoke_agent_runtime` transport,
independent of whether routing stays hand-rolled or becomes a Graph.

- A2A server support on AgentCore Runtime shipped via Marketplace 2025-11-19
  (cited above) — framed for installing third-party A2A agents, not documented
  (in what was fetched) as a first-party "expose your own Strands agent as A2A
  on Runtime" recipe with a GA/preview label. **Unverified** whether Runtime's
  HTTP contract (8080/`/invocations`, SigV4/OAuth, covered yesterday) has an
  equivalent for A2A's `/.well-known/agent-card.json` + JSON-RPC shape, or
  whether that needs another port or a Gateway target.
- Every image already carries the unused `a2a` extra (§0), so installing it is
  free; exposing an A2A server per sub-agent and wiring its auth (nothing found
  about SigV4/Cognito integration for A2A, unlike the documented AG-UI
  contract) is real, unscoped work.
- No source found (WebSearch, 2026-09-16) that step/progress events flow through
  an AgentCore-specific A2A surface distinct from `A2AStreamUpdateEvent` at the
  Strands SDK layer — any step-visibility win comes from the Strands client
  wrapper, not from anything AgentCore Runtime adds on top.

## 5. Recommendation

**Keep the hand-rolled `@tool` + `invoke_agent_runtime` routing.**

1. Agents-as-Tools is itself a named, supported Strands pattern — the
   supervisor is doing the documented pattern against a network call, not
   something unsupported.
2. The prize (native STEP events) requires every sub-agent to grow a second
   server surface (§2) whose AgentCore-side auth/contract story is unverified —
   real cross-cutting work, for a UI affordance the 2026-09-16 hand-emitted STEP
   events already deliver today at near-zero cost.
3. Everything else this system depends on — per-role guardrails, Cedar/authz,
   prompt refresh, `parentInvocationId` topology threading — is either
   orthogonal to the routing shape or would need rebuilding from scratch on the
   new transport with no verified equivalent (topology threading specifically).

**If revisited**, staged plan:
- **Behind a flag, no image roll**: none — this can't be flag-gated without
  changing what each sub-agent listens on.
- **Needs an image roll, no AWS creds required**: spike `agents/search`
  alone — add an `A2AServer` alongside its `BedrockAgentCoreApp` entrypoint, run
  under `agentcore dev`, drive with a toy local `A2AAgent` Graph node to observe
  whether parent-id-equivalent context survives and how spans nest. Answerable
  locally.
- **Should NOT change**: the supervisor's per-(tenant,role) `Agent`/guardrail
  cache, the Cedar/authz gate, the prompt-refresh path — none implicated by the
  routing-shape question either way.

## What to verify with credentials

- Whether AgentCore Runtime documents an A2A-specific auth/contract surface —
  check `describe-agent-runtime` output for any A2A field on the 8 deployed
  runtimes.
- Whether a second listener (`A2AServer`) inside an AgentCore Runtime container
  is even permitted by the Runtime's networking model — deploy the
  `agents/search` spike above to a real runtime and probe a third port.
- Real cost/latency of per-node parallel fan-out (search + scoring
  concurrently) against live Nova Pro/Lite quota, if a Graph spike proceeds.
