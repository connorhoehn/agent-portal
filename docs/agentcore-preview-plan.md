# AgentCore preview adoption — implementation plan (v2)

Companion to [`agentcore-preview-surface.md`](./agentcore-preview-surface.md),
which holds the verified API research. This is the sequenced work plan.

**Status: Phases 0–4 implemented and locally verified** (docs, `agents/devbox/`,
`OrgIQ-Devbox` stack, notebook 20 + jupyter image, middleware `/api/devbox`
routes, lifecycle config on all nine agent runtimes). Local verification done
without deploying: both Docker images build and smoke-test (devbox 1.1 GB,
Claude Code 2.1.197 boots against the Bedrock model ID; jupyter carries
`agentcore` CLI 0.27.0 + botocore 1.43.72 with the command API); wrapper unit
tests (`agents/devbox/test_main.py`, stubbed claude, no AWS) caught and lock in
two real bugs — SSE double-encoding (yield dicts, not strings) and
orphaned-child pipe hangs on timeout (process-group kill). First deploy:
`./agents/devbox/build.sh`, then
`cd infra && ./scripts/deploy.sh OrgIQ-Devbox --context deployDevbox=true`.

**v2 reframe.** v1 of this plan treated session storage as an optimization for
the existing OrgIQ agents. The actual goal is the blog's headline scenario,
adapted to this accelerator:

> Launch a Claude Code terminal inside an AgentCore Runtime microVM,
> authenticated through Bedrock (no API keys), with a persistent workspace —
> driven from the notebooks, provisioned by CDK, with middleware API support
> for a future UI. **No portal/UI work now.**

The deliverable surfaces are: **notebooks**, **infra**, **middleware API**.
Portal pages are explicitly out of scope; the middleware routes are designed so
UI can be added later without rework.

---

## The thing being built: `orgiq-devbox`

A tenth runtime, unlike the nine OrgIQ agents. Instead of a Strands agent, the
container hosts **Claude Code** (the CLI) plus a thin Python wrapper that
satisfies the AgentCore Runtime contract. Three access modes:

```
┌────────────────────────────┐
│ JupyterLab (orgiq-jupyter) │
│                            │
│  notebook cell ──boto3──┐  │        ┌──────────────────────────────┐
│                         │  │        │  AgentCore Runtime microVM   │
│  notebook cell ──boto3──┼──┼──────▶ │  ┌────────────────────────┐  │
│   (command API)         │  │        │  │ main.py (HTTP :8080)   │  │
│                         │  │        │  │   └─▶ claude -p ...    │  │
│  Terminal tab ──────────┘  │        │  │        (headless)      │  │
│   agentcore exec --it      │        │  └────────────────────────┘  │
└────────────────────────────┘        │  /mnt/workspace (persistent) │
                                      │  IAM role ──▶ Bedrock Claude │
                                      └──────────────────────────────┘
```

1. **Task mode** (notebook cell, `invoke_agent_runtime`): send a prompt, the wrapper runs `claude -p <prompt> --output-format stream-json` headless in `/mnt/workspace`, output streams back. This is "run agent code": Claude Code writes, executes, and iterates on code inside the microVM.
2. **Command mode** (notebook cell, `invoke_agent_runtime_command`): one-shot deterministic shell — `git status`, `pytest`, `ls /mnt/workspace` — streamed stdout/stderr with exit code, no LLM in the loop. Verified present in the installed boto3 (1.42.92).
3. **Interactive terminal** (JupyterLab Terminal tab): `agentcore exec --it --runtime orgiq_devbox --session-id <id>` — a real PTY into the microVM. This is CLI-only (the `InvokeAgentRuntimeCommandShell` operation is not in botocore — bidirectional streaming isn't supported in Python), so it runs from JupyterLab's built-in Terminal, not a cell. Requires Node + `@aws/agentcore` baked into the jupyter image.

**Auth chain — the part that makes this clean.** Notebook uses host SSO creds
(`~/.aws` is already mounted `:ro`) → calls the AgentCore data plane → microVM
runs under the devbox execution role → Claude Code runs with
`CLAUDE_CODE_USE_BEDROCK=1`, so it calls `bedrock:InvokeModelWithResponseStream`
using the role's credentials. **No Anthropic API key exists anywhere in the
system.**

**Persistence.** `sessionStorage` mount at `/mnt/workspace` (preview, supported
in us-east-1). Both the working tree *and* Claude Code's own session state
survive stop/resume: set `HOME=/mnt/workspace` (or `CLAUDE_CONFIG_DIR`) in the
wrapper so `~/.claude` lands on the persistent mount — meaning `claude --resume`
works across microVM restarts, not just files. Because the mount only exists at
invocation time (not container init), all directory setup happens lazily inside
the request handler — never at import time.

### Constraints acknowledged up front

- **Model exception.** CLAUDE.md's convention says "AWS-native only — no Anthropic models" for agent `MODEL_ID`. Claude Code requires Claude models — via Bedrock inference profiles (`us.anthropic.claude-*`), so still AWS-hosted, AWS-billed, no external API. This is a deliberate, recorded exception scoped to the devbox only; the nine OrgIQ agents stay on Nova. CLAUDE.md gets a line documenting it. Exact model ID (Sonnet 4.5 as the cost-sane default vs Opus) is resolved at implementation time via `aws bedrock list-inference-profiles` and injected as an env var by CDK — not hardcoded.
- **Wipe-on-deploy.** Session storage resets on every runtime version update, and digest-pinning rolls the version on every image push. For a devbox this is tolerable-but-documented: work leaves the VM via `git push` or via command-mode extraction, never lives only in `/mnt/workspace`. Git credentials for push (the blog's Gateway + Identity token-vault pattern) are a follow-up, not v1 — v1 retrieves artifacts through the command API.
- **Session limits that shape UX**: 1 GB workspace, 8 h max session lifetime, 14-day idle expiry, session IDs ≥ 33 chars (the middleware's `deriveSessionId` already handles this; the notebook uses `uuid4()` twice-joined or similar).

---

## Phases

Each ships independently. Order: infra → notebook → middleware.

### Phase 0 — Doc corrections *(anytime, trivial)*

- CLAUDE.md: image-size limit 1 GB → 2 GB (current quota).
- CLAUDE.md Gotchas: session storage wipes on runtime version update + digest-pinning interaction.
- CLAUDE.md: record the devbox Claude-on-Bedrock model exception (once Phase 1 lands).
- Reconcile the `@aws/agentcore` CLI note (documented as installed; isn't).

### Phase 1 — Infra: devbox container + CDK stack

**New container, `agents/devbox/`** (kept beside the other agent sources, but
*not* added to `ALL_AGENT_NAMES` or `build-all.sh`'s shared-base flow — it has a
different dependency profile):

- Multistage ARM64 Dockerfile: `python:3.12-slim` + Node 20 + `@anthropic-ai/claude-code` + git + ripgrep. Non-root `bedrock_agentcore` (UID 1000), ports 8080/8000, `GET /ping`, CMD per the runtime contract. Node + Claude Code adds ~300 MB over the Python base — comfortably under the 2 GB quota.
- `main.py`: `BedrockAgentCoreApp` wrapper. Payload `{prompt, resume?}` → subprocess `claude -p` with `cwd=/mnt/workspace`, `--output-format stream-json`, `--dangerously-skip-permissions` (safe: the microVM *is* the sandbox), streaming lines back as SSE. Env plumbed from CDK: `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`.
- Wrapper degrades gracefully when `/mnt/workspace` is absent (local `agentcore dev` has no mount) — falls back to a temp dir with a warning in the response.

**New CDK stack, `OrgIQ-Devbox`** — deliberately *not* folded into
`OrgIQ-AgentCoreRuntime`, because that stack's loop grants every execution role
Aurora/KB/S3/DynamoDB data-plane access. The devbox should not inherit those by
default:

- Own ECR repo (`orgiq-devbox`), lifecycle rules matching the others.
- Own execution role, **minimal**: `bedrock:InvokeModel`/`InvokeModelWithResponseStream` scoped to the Claude inference-profile + foundation-model ARNs, plus the standard logs/xray/metrics/ECR/workload-token statements. An opt-in `--context devboxOrgAccess=true` adds read-only Aurora Data API + KB Retrieve for sessions that need to exercise real OrgIQ code — off by default.
- `CfnRuntime` with: digest-pinned container URI (same `resolveContainerUri` helper), `PUBLIC` network, `filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }]`, `lifecycleConfiguration: { idleRuntimeSessionTimeout: 3600, maxLifetime: 28800 }` — a 1 h idle window so a thinking pause doesn't kill the VM (the workspace survives regardless), 8 h hard cap.
- Gated on `--context deployDevbox=true`, mirroring the `deployRuntimes` phase-1/phase-2 pattern; registered in `deploy.sh` / `destroy.sh`.

**Verification**: `npx cdk synth OrgIQ-Devbox` template inspection; local image
build; `agentcore dev`-style local smoke of the wrapper; then one real deploy +
invoke.

### Phase 2 — Notebook: `20-coding-agent.ipynb`

The demo surface, following the corpus conventions (config.json state,
`cleanup_utils` registration; `18b-` precedent means no renumbering — cleanup
stays 19, index page gets a row).

Narrative arc of the notebook:

1. **Setup** — resolve the devbox runtime ARN from CDK outputs; mint a ≥33-char session ID; store in `config.json`.
2. **First contact** — command mode: `uname -a`, `ls /mnt/workspace` (empty), `node --version`. Proves the microVM + streaming plumbing with zero LLM cost.
3. **Task mode** — invoke Claude Code: "scaffold a small Python project with tests in /mnt/workspace". Stream and render the `stream-json` events.
4. **Verify deterministically** — command mode: `pytest`, `git -C /mnt/workspace log --oneline`. The LLM's work checked without the LLM.
5. **The money demo** — `stop_runtime_session`, wait for completion (docs: always wait before resuming, or data may not be flushed), re-invoke with the same session ID: files, git history, and `claude --resume` conversation all intact. *"It's safe to close your laptop."*
6. **Interactive terminal** — a markdown cell directing the reader to JupyterLab's Terminal tab: `agentcore exec --it --runtime orgiq_devbox --session-id $SID`, with a note on why this can't run in a cell (no bidirectional streaming in botocore) and the reconnect flags.
7. **Limits + teardown** — 1 GB / 8 h / 14-day / wipe-on-deploy caveats; register the session for `19-cleanup`.

**Jupyter image changes** (`notebooks/aws/Dockerfile` + `requirements.txt`):

- Add Node 20 (NodeSource or nvm layer) + `npm install -g @aws/agentcore` in the cached system stage — enables the Terminal-tab mode.
- Pin `boto3>=1.42.92` explicitly (first version verified to carry `InvokeAgentRuntimeCommand`) instead of relying on the float.

### Phase 3 — Middleware API (no UI)

Routes shaped for a future devbox page, exercised now only by tests/curl:

- `middleware/src/routes/devbox.ts`:
  - `POST /api/devbox/sessions` → mint + return a session ID (reuse/extract `deriveSessionId` from `routes/agents.ts:31` rather than duplicating the ≥33 rule).
  - `POST /api/devbox/:sessionId/task` → task mode, SSE stream of Claude Code events.
  - `POST /api/devbox/:sessionId/command` → command mode, SSE of stdout/stderr chunks + exit code. **Allowlist-gated** (`git status`, `ls`, `cat`, `pytest`, …) — no free-form shell through the HTTP surface even though the notebook path allows it; the notebook user already holds AWS creds, a future UI user may not.
  - `DELETE /api/devbox/:sessionId` → `StopRuntimeSession`.
- Provider addition in `agentcore.ts` with the naming trap defused explicitly:
  ```ts
  // NOTE: the SDK class `InvokeAgentRuntimeCommand` used above is the plain
  // InvokeAgentRuntime *operation*. The command-execution API is a different
  // operation whose class is InvokeAgentRuntimeCommandCommand — aliased here.
  import { InvokeAgentRuntimeCommandCommand as RunRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
  ```
- Verify the `^3.700.0` pin resolves to a client version that actually exports the new command class (current is 3.1111.0; `node_modules` has never been checked post-float). Bump the floor if needed.
- Middleware task-role IAM (`middleware-service-stack.ts`): `bedrock-agentcore:InvokeAgentRuntime`, `InvokeAgentRuntimeCommand`, `StopRuntimeSession` scoped to the devbox runtime ARN only.

**Verification**: route unit tests with a mocked client (allowlist enforcement,
SSE framing); one manual end-to-end against the deployed devbox.

### Phase 4 — Lifecycle knobs on the existing nine runtimes *(optional, carried from v1)*

Explicit `lifecycleConfiguration` on all nine `CfnRuntime`s in
`agentcore-runtime-stack.ts`, tuned down for the non-interactive agents. Pure
cost hygiene, one file, no dependencies on anything above. Ship whenever.

**2026-09-16 — `strands-agents` floor moved to `>=1.55`.** Per
`docs/research-versions-spike-2026-09-16.md` (spike b), the pin in
`agents/base/Dockerfile` and all eight `agents/*/pyproject.toml` files (not
devbox — it carries no Strands dependency) was raised from `>=1.39`. Grep for
the two confirmed renames in the 1.39→1.55 range came back clean: zero
usages of `LocalMemoryStore`/`TestMemoryStore` (renamed at 1.47.0) and zero
usages of the Strands `bash`-tool import (renamed to `shell` at 1.51.0) — the
only `bash` hit in any agent's `.py` file is an unrelated comment in
`agents/devbox/main.py:158` about Claude Code's own bash tool. `ModelRouter`
and in-process agents-as-tools are likewise unused. All 120 offline agent
unit tests pass unchanged after the bump (`test_prompt_source` +
`test_callbacks` = 61, `test_kb_resolver` + `test_sql_guard` = 55,
`test_kb_retrieve_config` = 4). Not yet verified: the spike flags 1.54.0's
"cache system prompt in auto mode" as the one item needing a live check —
quoting it directly, "if 1.54.0's new 'auto' caching mode caches the system
prompt more aggressively than before, it's worth confirming a rebuilt
`Agent` object actually busts that cache ... this is exactly the kind of
interaction a changelog one-liner won't surface — needs a real invoke to
verify, not just a code read." That needs a smoke test against the
supervisor's prompt-refresh rebuild (`agents/supervisor/main.py` ~420-436,
`_agents_for_role`) on the next image roll, once `agents/base/build.sh` +
`agents/build-all.sh` push a base image with the new floor.

---

## Deferred / dropped

| Item | Status | Why |
|---|---|---|
| Session-storage use inside `ingestion`/`graph-builder` (v1 Phase 2) | **Backlog** | User redirected; neither was load-bearing. The devbox is now the session-storage showcase. |
| Portal devbox UI | **Explicitly out** | User's call. Phase 3's API shapes are the contract for when it happens. |
| Git-push credentials via Gateway + Identity token vault | **Follow-up** | The blog's bot/OBO pattern; v1 extracts artifacts via command mode. |
| CDK bump to 2.265.0 / `CfnHarness` spike | **Deferred** | Nothing in this plan needs 2.265.0 — session storage, lifecycle, and the command API all work on installed toolchains. |
| VPC + BYO filesystems | **Deferred** | Unchanged from v1: needs a private-networking driver. |

---

## Sequencing

```
Phase 0 ─▶ (anytime)
Phase 1 ─▶ Phase 2 ─▶ Phase 3
Phase 4 ─▶ (anytime, independent)
```

Minimum shippable increment that satisfies the stated goal: **Phases 1 + 2** —
a deployed devbox and a notebook that launches, drives, stops, and resumes it,
including the interactive terminal from JupyterLab. Phase 3 makes it
UI-ready.

## Defaults chosen (flag if you disagree)

1. **Devbox IAM starts minimal** (Bedrock Claude + logging only); OrgIQ data-plane access is opt-in via context flag, read-only.
2. **Separate stack** (`OrgIQ-Devbox`), not a special case inside the nine-agent loop.
3. **`ANTHROPIC_MODEL` defaults to the Sonnet-tier inference profile**, overridable — Opus burns innovation-lab budget fast on long agentic runs.
4. **Notebook numbered `20`**, cleanup stays `19` (matching the `18b` precedent of not renumbering).
