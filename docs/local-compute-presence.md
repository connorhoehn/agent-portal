# Local compute presence — goal spec

> Status: **goal spec, pre-implementation.** Written 2026-09-02 in the
> `local-compute-presence` worktree. Companion reading: the memory-harness
> guide (`~/Desktop/claude-mem/the-memory-harness.html`, sections 7, 19, 22,
> 25, 29, 30), `docs/handoff-computer-lab.md`, and
> `docs/program-operating-model.md`.

## Intent

The Computer Lab and the bot fleet assume all compute is in the cloud —
AgentCore microVMs, dispatched by the middleware, billed against initiative
budgets. This feature makes **the developer's own machine a first-class
participant**: a laptop (or a beefy workstation running offline models) that
runs Claude Code sessions locally, announces itself to OrgIQ, and can
eventually claim work from the same governed pipeline the cloud fleet uses.

The visible product is a **top-nav presence indicator**: a chip in the portal
header showing *my machine is connected, N sessions running*. Clicking it
opens a dropdown listing each live session — the project/worktree it's in,
what it's working on, which model provider it's using (Bedrock vs. a local
Ollama/vLLM model), and how synced its memory is against the shared memory
mesh. The machine also appears in the Computer Lab beside the microVM boxes,
and — opted in explicitly — becomes a dispatch target for `agent_jobs`.

The local side is a **claude-mem plugin**: the hooks + sidecar the memory
harness already describes (SessionStart / PostToolUse / Stop → local SQLite →
sync-on-write to a hub). This feature gives that sidecar a second, tiny
destination: an OrgIQ presence endpoint. The sidecar's own sync state (its
outbox depth, its hub cursor age) is exactly the "how synced am I" number the
dropdown shows.

Three design rules carried over from the memory harness, verbatim:

1. **Degraded means slower, never stopped** (s7). Everything durable moves
   over plain HTTP with debounce + backoff; any realtime lane is advisory.
2. **The database is the queue** (s7/s25). The sidecar's outbox
   (`synced_at IS NULL`) is the pending-work signal; presence just reports it.
3. **Record reachability honestly** (s19). The portal must never offer an
   affordance ("open a shell on this box") that the machine can't serve. A local
   machine is *presence + optional job claiming*, not a remote shell target,
   until it explicitly advertises that capability.

## What exists today (the seams)

All confirmed by survey on 2026-09-02; line numbers from `main`.

| Seam | Where | What it gives us |
|---|---|---|
| Top bar | `portal/src/components/shell/Layout.tsx:246-257` | `<ChannelHeader>` with an `actions` slot already holding `CommandPaletteHint` + `GatewayStatusBadge` + `MasqueradeMenu`. The insertion point. |
| Status-dot precedent | `portal/src/components/shell/GatewayStatusBadge.tsx` | Two-dot indicator: one HTTP poll, one live WS state. |
| Dropdown precedent | `portal/src/components/shell/MasqueradeMenu.tsx:118-133` | Hand-rolled header panel (trigger + positioned panel + click-outside). Precedent, **not** the pattern to copy — see UI section. |
| Fleet registry | `middleware/src/lib/devbox-fleet.ts` | In-memory `FleetBox` map; `registerBox()` (`:119`), status derived from event flow not client claims (`:220-288`). No heartbeat protocol; no durable table. |
| Dispatcher | `middleware/src/lib/job-dispatcher.ts:139-146` | Claims `agent_jobs` per idle box every 10s. **Any registered box is automatically dispatch-eligible** — a local machine needs an explicit opt-in. |
| Reaper | `middleware/src/lib/devbox-reaper.ts:29-58` | 20m idle / 60m lifetime kill for microVMs. A laptop is not billable — must be exempt. |
| Visibility | `middleware/src/lib/devbox-visibility.ts:49-55` | `ownerId`-only boxes are visible to the owner + fleet-wide roles. A local machine is naturally this shape. |
| Lab UI | `@connorhoehnslalom/ui-components/compute` — `Computer` (`compute.d.ts:306-362`) | Already carries `currentTask`, `projectId`/`project`, `contextUsed`, `activeModel`, `spendUsd`, `tokensUsed` — nearly every dropdown field except memory sync. `ComputeProvider` mounted once in `portal/src/components/compute/ComputeHost.tsx:128-142`. |
| Live transport | `middleware/src/lib/sse.ts` + `routes/devbox.ts:442` (tail), `routes/work.ts` (dispatcher stream) | SSE is the house style for live status; the gateway WS (realtime-modules) carries chat/presence/activity for a *separate* service. |
| Jobs | `middleware/src/providers/agent-jobs.ts` — `claimNextJob` (`:252-285`, `FOR UPDATE SKIP LOCKED`), `agent_jobs.box_id/session_id` (`schema/agentic_work_schema.sql:37-38`) | The claim path a local runner can reuse unchanged. |
| Attribution | `bot_runs.dispatched_by` (`schema/agent_run_attribution_schema.sql`), envelope gates in `lib/bot-runner.ts` | The governance rails local work must ride, not bypass. |
| Session identity | `portal/src/lib/auth.tsx:12-21` (`session.sub`), `routes/devbox.ts:389` (owner always from session, never body) | The ownership rule to preserve. |
| Memory (server) | `middleware/src/providers/memory.ts` (AgentCore Memory event store), `capability-reconcile.ts:140` (probe) | "Is memory connected" exists server-side; **no mesh/sync concept exists yet** — the local sidecar is the first component that has one. |
| Machine-auth precedent | CLAUDE.md gotcha: `requireServiceAuth`/`requireTraceAuth` on agent-callback routes | Machine callbacks get token auth per-route, never a session floor. The local machine follows this rule. |

Schema gap: **there is no table for boxes/nodes/heartbeats anywhere.** The
fleet dies with the middleware process. Local machines need pairing tokens that
survive restarts, so this feature introduces the first durable compute table.

## Domain model

Two entities, deliberately not one:

- **Node** — a machine, called `node` in the schema and API. This doc says
  "machine" everywhere else and reserves `node` for schema/API references.
  Durable (survives restarts), paired once, owns a
  token. `node_id` is stable (host UUID). Carries: label ("connor-macbook"),
  platform, hardware hints (arch, RAM, GPU), advertised capabilities
  (`accept_jobs`, `local_models: ["qwen2.5-coder:14b", …]`), owner
  (`app_users` sub), created/last-seen.
- **Session** — a live Claude Code (or other harness) session on a machine.
  Ephemeral (in-memory, like `devbox-fleet`), announced at SessionStart,
  heartbeated, ended at Stop or by staleness. This is the s19 presence
  record, near-verbatim:

```jsonc
// POST /api/local-compute/announce  (one node, N sessions per call)
{
  "node": {
    "nodeId": "…", "label": "connor-macbook", "platform": "darwin/arm64",
    "acceptJobs": false,
    "localModels": ["qwen2.5-coder:14b"]
  },
  "sessions": [{
    "sessionId": "…",                      // ≥ the harness session id
    "harness": "claude-code",              // claude-code | cursor | other
    "projectId": "p-realtime",             // resolved from git remote, nullable
    "repo": "aws-agentcore",
    "branch": "worktree-local-compute-presence",
    "worktree": "~/Projects/aws-agentcore/.claude/worktrees/…",
    "intent": "wire local presence into the portal header",  // first prompt line / task title
    "touching": ["middleware/src/routes/…", "portal/src/components/shell/…"],
    "modelProvider": "bedrock",            // bedrock | anthropic | ollama | vllm | lmstudio
    "model": "us.anthropic.claude-…",
    "contextUsed": 0.42,                   // fraction, if the harness exposes it
    "memory": {                            // the sidecar's own sync state — see below
      "mode": "synced",                    // synced | pending | offline | disabled
      "pendingOps": 0,                     // outbox WHERE synced_at IS NULL
      "lastPushAt": 1788285120,
      "pullCursorAgeS": 12,                // how stale my read replica is
      "importedPacks": ["capability-registry@2026-08-30", "p-realtime/90d"]
    },
    "startedAt": 1788284310
  }]
}
```

`memory.mode` is computed by the sidecar, not the server: `synced` when the
outbox is empty and the pull cursor is fresh; `pending` when draining;
`offline` when the hub is unreachable (writes queuing locally); `disabled`
when sync is off (the s7 rule: token+user+URL all set, or it isn't running).

Server-side status is **derived, not claimed** (mirroring
`devbox-fleet.appendEvent`): `last_seen ≤ 90s` → connected; `≤ 5min` → stale;
beyond → offline, sessions dropped. The node row persists; sessions don't.

## Protocol

Local plugin → middleware, all plain HTTP, sync-on-write shape (s7):

- **Pairing (once per machine).** Browser flow, because the cookie can't
  leave the browser: portal shows a short-lived pairing code
  (`POST /api/local-compute/pair/start`, session-gated); the plugin claims it
  (`POST /api/local-compute/pair/claim`, no session) and receives a
  `nodeToken` — scoped **write-presence-only** (the s22 rule: automation gets
  write-only scopes; read scopes stay with humans). Token stored alongside
  the claude-mem settings at mode 0600. Node is bound to the pairing user's
  `sub` as `ownerId`, server-side, forever.
- **Announce** on SessionStart; **heartbeat** every 30s active / 5min idle
  (piggybacking the sidecar's existing flush timer — no new daemon, the
  worker syncs on write); **end** on Stop hook. Debounced ~1.5s so PostToolUse
  bursts coalesce. Failed sends back off 30s → 10min and never block the
  session — presence is advisory; losing it must cost nothing locally.
- Middleware → portal: `GET /api/local-compute/nodes` (poll, owner-scoped)
  plus `GET /api/local-compute/stream` (SSE via `lib/sse.ts`, same shape as
  the devbox tail). The badge works on the poll alone; SSE is the speed layer
  and can be dropped (rule 1).

Auth on the machine routes is the `nodeToken` (constant-time check, per the
`requireServiceAuth` precedent) — **no session floor on machine callbacks.**
Browser routes ride the normal session + capability path.

## Schema (new, `schema/local_compute_schema.sql`)

```sql
CREATE TABLE compute_nodes (
  id            TEXT PRIMARY KEY,          -- host UUID from the plugin
  owner_id      TEXT NOT NULL,             -- app_users sub; set at pairing
  label         TEXT NOT NULL,
  platform      TEXT,
  token_hash    TEXT NOT NULL,             -- sha256(nodeToken); token never stored
  accept_jobs   BOOLEAN NOT NULL DEFAULT FALSE,
  local_models  JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ                -- soft revoke; a revoked token 401s
);
CREATE TABLE compute_pairing_codes (
  code          TEXT PRIMARY KEY,          -- short, single-use
  owner_id      TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  claimed_at    TIMESTAMPTZ
);
```

Sessions stay in-memory in a new `middleware/src/lib/local-compute-fleet.ts`
(sibling of `devbox-fleet.ts`, same subscribe/replay idiom) — consistent with
the existing fleet's posture and honest about what a restart costs: the machine
re-announces within one heartbeat. In-memory fallback for `compute_nodes`
when Aurora is unconfigured, mirroring the identity provider's pattern, so
`dev:mock` demos the whole feature offline.

## What the first real pairing taught (2026-09-15)

A person paired a laptop from the portal, saw it listed offline with no
runnable kinds, read that as a failed pairing, and ran the (single-use) code
again; started the worker; handed it "what is 10+10" from the page's free
prompt; got `awaiting_review` back; and saw a black log box. Each of those
is now a contract:

- **Pairing registers; the worker connects.** Every message on the path —
  the plugin's success line, the dialog, the page's offline banner — names
  the next command (`node tools/local-compute-worker.mjs`). The dialog polls
  `GET /api/local-compute/pair/:code` (owner-scoped; `{claimed, claimedAt,
  nodeId}`) every 2.5s and advances to the worker step the moment a machine
  claims, then closes itself when that machine's presence reads `connected`.
- **Presence is acknowledged, never assumed.** The worker checks every
  announce/heartbeat response: a 401/403 first re-reads the token file (a
  second pairing of the same machine rotates the token under a running
  worker — the row is upserted by node id, so nothing duplicates, but the old
  token dies) and adopts a newer token; if the server still refuses it says
  so and exits. Reachability failures print once per state change. A worker
  that says "connected" while the portal says offline was the bug.
- **Review is for a change.** `requiresReview` defaults to `Boolean(repo)`
  on both the dispatch route and the worker: a run with no repo produced no
  capture, so it lands in `done`; a caller wanting a look anyway sends
  `requiresReview: true`.
- **Work reaches a machine from governed paths only.** The page no longer
  carries a free-prompt composer. It shows the machine's lane — queued,
  claimed and running jobs targeted at it or untargeted in a kind it
  registered — and links to bots (`/admin/bots`, scheduled, budgeted,
  reviewed) and initiative work (`/iq/projects`). `POST
  /api/local-compute/nodes/:id/work` stays for those callers; it is not a
  page affordance.
- **The pick list, not a prompt.** "Up next on <machine>" carries a
  top-8 pick list (SegmentedControl: Initiative work · Bots) drawn from the
  same feeds the rest of the app uses — `GET /api/work/suggestions` (the
  ranked open work on the person's own initiatives) and `GET /api/bots`
  (only for a role with ManageBots; parked bots are filtered out). Each row
  has one action, "Send to <machine>" / "Run on <machine>", which POSTs
  `{workItemId}` or `{botId}` to `POST /api/local-compute/nodes/:id/work`.
  The route builds the job from the origin: the item's title and description
  (or the bot's rendered mission) as the prompt, the codebase that delivers
  the initiative as `repo` (so the run is reviewed), and `workItemId` /
  `initiativeId` / `botId` on the payload so the run can be traced back.
  It keeps the fleet routes' checks — a work item is grant-scoped, a bot
  needs ManageBots and must be enabled and unpaused. The Initiatives and
  Bots links remain as browse links; they carry no machine context on
  purpose — picking happens here, next to the machine.
- **The log console reads the theme.** ui-components' `LogStream` paints
  `var(--color-surface-subtle, #0b1020)`; the portal now defines that token
  in both themes (light `#f1f5f9`, dark `#0b1020`) so the box is no longer
  black on a light page. The library-side fix (a defined token or a real
  `tone` prop) is queued in `docs/ui-components-queue.md`.

## Live metrics and a merged event stream (2026-09-16)

The presence page had nothing to show connection status transitioning,
whether a run is queued/running/stopped/failed, or any signal of the
machine's own health — just a badge that changed color on a poll. Two
additions close that, both server-side; the portal consumes them separately.

**Machine metrics ride the announce, not the heartbeat.** `worker.mjs`'s
periodic loop only ever calls `POST /api/local-compute/announce` on a
repeating timer — `POST /api/local-compute/heartbeat` exists as a
machine-callback route but nothing in the shipped worker calls it — so that
is where an OPTIONAL `metrics` object attaches, all fields independently
optional so an older worker (or a degraded reading — `node:os` can throw in a
sandbox) keeps working byte-for-byte:

```jsonc
// POST /api/local-compute/announce
{
  "sessions": [...],
  "metrics": {
    "loadAvg1": 1.25,        // os.loadavg()[0]
    "cpuCount": 10,          // os.cpus().length
    "memTotalMb": 32768,
    "memFreeMb": 8192,
    "uptimeS": 12345,        // os.uptime()
    "workerVersion": "1.1.0",
    "activeJobs": 1
  }
}
```

Validated and clamped at the route (`routes/local-compute.ts` `parseMetrics`):
a present-but-malformed object (non-finite, negative, or past a generous
absurd ceiling; `workerVersion` not a string) 400s the WHOLE announce rather
than storing a partial guess — the same all-or-nothing shape `parseSessions`
already uses. Absent is a no-op: the previously stored snapshot, if any, is
left alone rather than wiped, which is what makes an older worker safe.
Storage lives beside presence in `lib/local-compute-fleet.ts` (in-memory,
keyed by node id, stamped with the observation time) rather than in
`compute_nodes` — a CPU/memory reading is a live signal with the same
lifecycle as a session, not a durable fact about the machine, and putting it
there needed no schema migration. `metricsOf()` hides a stale snapshot the
same way `presenceOf()` hides sessions once a node ages past the offline
horizon (5 min) — a number from ten minutes ago is presence the machine can
no longer back.

`GET /api/local-compute/nodes` gained a `metrics: {...} | null` field per
node, sibling to `presence`, for exactly this reason: a wire consumer that
only reads the announce contract would miss that the same object rides the
existing "my machines" read.

**`GET /api/local-compute/events`** is a second SSE stream, guarded and
owner-scoped exactly like `GET /nodes` (`browserTenant` +
`requireSession('ViewLocalCompute')`), additive to the existing `/stream`
route rather than a replacement for it. One connection now carries everything
the page needs:

```jsonc
// on connect — a full snapshot, same node shape GET /nodes returns, so the
// client never needs a second round-trip just to bootstrap
{"type":"hello","nodes":[{ id, ownerId, label, ..., presence, metrics }]}

// a node's connected/stale/offline status changed, OR new metrics landed —
// one frame kind for both, since both are "this machine's presence record
// changed" and a second type would be a distinction the client gains nothing
// from
{"type":"presence","nodeId":"...","status":"connected","lastSeenAt":"...","metrics":{...}|null}

// a job belonging to one of THIS owner's machines changed state — queued,
// claimed, running, done/failed/cancelled/awaiting_review
{"type":"job","jobId":"...","nodeId":"...","status":"claimed","title":"...","at":"..."}
```

Job events are emitted from the provider (`providers/agent-jobs.ts`
`jobEvents`, a small `EventEmitter` in the same shape as `job-dispatcher.ts`'s
existing `dispatcherEvents`), not polled inside the route: every write that
moves a job's `status` — enqueue, the pull-side claim, the fenced
running/complete transitions, cancel, review — emits, and the route resolves
which machine a job belongs to from its `box_id` once claimed or from
`payload.nodeId` before that (a queued-but-unclaimed targeted job has no
`box_id` yet, and that is exactly the window "up next on `<machine>`" is
watching). Every frame is filtered to the connecting owner's own node ids
before it is written — never another owner's machine or job, proven by a
route test that pairs and dispatches to a second owner's machine on the same
stream and asserts none of it appears in the buffer. `initSSE`'s existing
`heartbeat` named event is the periodic keepalive; nothing new was needed for
that.

## Authorization

- New Cedar action **`ConnectLocalCompute`** — gates pairing-code creation
  and the browser-facing machine list/revoke. Granted to `sme`, `org-leader`,
  `hr-admin` in `middleware/seeds/roles/orgiq/*.cedar`; `member` can hold it
  too (presence is personal and read-only) — decide at implementation with a
  default of *yes for every OrgIQ role that can hold a session*, since the
  feature only ever shows the owner their own machine.
- Added in **both** `middleware/src/lib/authz.ts:34` (`CAPABILITY_ACTIONS`)
  and `portal/src/lib/capabilities.tsx:15` (the `Action` union) — the survey
  confirmed these drift when only one is edited.
- Job participation (P2) reuses the existing money/attribution rails
  unchanged: dispatch to a local machine still flows through `agent_jobs`, still
  carries `dispatched_by` from a real session sub, still hits the envelope
  gates in `bot-runner.ts`. A local machine lowers the *cost* of a run, not the
  *governance* of it.
- Visibility: local machines/sessions are owner-visible plus the existing
  `FLEET_WIDE_ROLES` (`devbox-visibility.ts:32`) — a release manager can see
  that a machine is contributing, but `touching` paths and intents are
  presence data about a person's live work; default the *detail* (intent,
  touching, worktree paths) to owner-only and show others only
  machine/label/count. This is the s29 "sensitive records never leave the
  actor" instinct applied to presence.

## UI

### P0 — the header presence chip

Lives in the `ChannelHeader` `actions` slot (`Layout.tsx:251-255`), rendered
only when the session user owns ≥1 paired machine (zero-state: nothing — no
chrome for a feature you haven't paired).

- **Chip**: dot (green connected / amber stale / gray offline) + `⌂ connor-macbook · 3` (sessions). Multiple machines: `⌂ 2 machines · 5`.
- **Dropdown panel**, per session:
  - project + branch (`p-realtime · worktree-local-compute-presence`)
  - intent / current task, one line
  - model provider chip — `bedrock · nova-pro` vs `anthropic · claude-sonnet-5` vs `ollama · qwen2.5-coder:14b` (each provider rendered distinctly; the seeded demo machine shows the anthropic case, since the worker runs plain `claude -p` on the operator's own login by default, pinned to Sonnet or Haiku — never a frontier model for ticket work)
  - context meter (fraction, `DotMeter`)
  - memory sync line — `● synced`, `◐ 14 pending`, `○ offline — queuing`, with pull-cursor age on hover
  - footer: machine totals + "Open in Computer Lab" deep link (`/admin/devbox?box=local:<nodeId>`), "Manage machines" → settings page (revoke, rename, pairing)

**Component discipline.** No hand-rolled panel. The dropdown is a genuine
missing primitive in ui-components (`MasqueradeMenu` hand-rolls it today, and
its own comments will tell you it wants extraction). Per the standing rule
the primitive ships to ui-components **first**: a `HeaderStatusMenu` (or
`StatusMenu`) — trigger chip + positioned panel + click-outside + `SectionLabel`/`MenuItem`
internals, tone-aware. That is a **cross-repo ask** (see Coordination). Until
it lands, P0 may compose from existing primitives (`ConnectionPill`, `Chip`,
`DotMeter`, `SectionLabel`) inside a portal shell component, with the panel
chrome as the one temporary exception, explicitly TODO-tagged to migrate onto
the primitive — and `MasqueradeMenu` migrates onto it in the same pass.

### P1 — Computer Lab integration

Local machines project into the lab as `Computer`s: `id: "local:<nodeId>:<sessionId>"`,
`activeModel`, `contextUsed`, `currentTask`, `projectId` all map 1:1. Two
honest gaps to respect:

- `Computer` has no `kind` discriminator and no memory-sync field. Cross-repo
  ask: `kind?: 'microvm' | 'local'` + `memorySync?: {...}` on `Computer`, and
  the lab renders local boxes with a distinct glyph and **without** shell
  affordances unless the machine advertises them (rule 3: never offer an
  unreachable affordance — `runCommand`/`shell-url` don't exist for a laptop).
- Injection point: middleware merges local sessions into `GET /api/devbox/boxes`
  (server-side merge keeps `ComputeProvider` untouched) — preferred over a
  second provider input, because `DevboxQuickSwitch` (⌘I), `LabChooser` (⌘K),
  and `rollUpProjects` all read the same list and get the feature for free.
- The reaper and dispatcher must skip `kind: 'local'` boxes (reaper: always;
  dispatcher: unless `accept_jobs`).

### P2 — working the queue

A machine with `accept_jobs: true` runs a small local runner (plugin-side) that
polls `POST /api/local-compute/claim` → middleware calls the existing
`claimNextJob(boxId, sessionId)` with jobs filtered to what the machine can run
(job `kind` allowlist + the machine's `local_models`). Results flow back through
the existing job completion path; spend attribution records
`modelProvider: 'ollama'` runs at $0 marginal model cost but still meters
tokens — the budget story becomes "this initiative's maintenance floor
dropped because Connor's workstation absorbed the batch jobs," which is the
whole point of the feature. The lab's cost-centre rollup then shows local
compute as a distinct (cheap) band per project.

Job kinds that suit local first (straight from harness s25's routing table):
nightly distillation, re-embedding, consolidation — batch, latency-tolerant,
corpus-wide reads. Interactive runs stay on the cloud fleet.

### P3 — memory mesh depth

When the shared memory fabric materializes (harness Part III; `graph_proposals`
and `agent_jobs` `memory.merge` already exist in schema), the dropdown's
memory line deepens: which packs are imported (capability registry, project
90d replica), claim/lease state when the machine is doing fabric work
(distributed-core `DistributedLock` fencing per s30), and the merge-queue
depth for proposals the machine authored. Nothing in P0–P2 blocks on this; the
`memory` object in the announce payload is deliberately open-shaped so the
sidecar can enrich it without a protocol rev.

## Phases and acceptance

**P0 — presence** *(the demo: my machine shows up in the header)*
1. Pair a machine from the portal; token lands in the plugin config; node row survives middleware restart.
2. Start a local Claude Code session → chip appears within one heartbeat showing 1 session with project/branch/intent/model/memory line.
3. Kill the network → chip goes stale then offline within 5min; restore → recovers with no local errors (backoff observable in plugin logs).
4. A second portal user cannot see the machine detail; fleet-wide roles see machine+count only.
5. Works end-to-end in `dev:mock` (in-memory machine store, a fixture machine).

**P1 — lab** — local sessions appear in ComputerLab grouped under their
projects, distinct glyph, no shell affordance; ⌘I/⌘K find them; reaper and
dispatcher provably skip them (unit tests on `decideReaping` + the dispatch
filter).

**P2 — work** — an `accept_jobs` machine claims a seeded `agent_jobs` batch
job, completes it, and the run shows attribution + $0 model cost in the
lab's project rollup; envelope gates still fire for over-budget dispatches
targeting local machines.

**P3 — mesh** — spec'd separately once the fabric exists; only the payload
seam is reserved here.

## Coordination contract (other live sessions)

Other agent sessions are concurrently editing **ui-components**,
**realtime-modules**, and **this repo**. Rules of engagement:

- **This feature is additive-first.** New files wherever possible:
  `middleware/src/lib/local-compute-fleet.ts`, `middleware/src/routes/local-compute.ts`,
  `middleware/src/providers/local-compute.ts`, `schema/local_compute_schema.sql`,
  `portal/src/components/shell/LocalComputeBadge.tsx`. Shared-file touches
  are kept to single-seam insertions and listed here so a rebase is mechanical:
  - `middleware/src/index.ts` — one router mount
  - `middleware/src/lib/authz.ts:34` — one action in `CAPABILITY_ACTIONS`
  - `portal/src/lib/capabilities.tsx:15` — one action in the union
  - `portal/src/components/shell/Layout.tsx:251-255` — one element in the actions slot
  - `middleware/seeds/roles/orgiq/*.cedar` — one permit block per role
  - (P1) `middleware/src/routes/devbox.ts` boxes merge + `devbox-reaper.ts`/`job-dispatcher.ts` skip guards
- **Never edit ui-components or realtime-modules from this repo** (standing
  rule; also `isolation: worktree` does not protect them). Cross-repo asks are
  filed as explicit TODOs for the sessions that own those repos:
  1. ui-components: `HeaderStatusMenu` primitive (trigger + panel + menu internals); migrate `MasqueradeMenu` onto it.
  2. ui-components `/compute`: `Computer.kind?: 'microvm' | 'local'`, `Computer.memorySync?`, local-machine rendering (glyph, suppressed shell affordances).
  3. realtime-modules: none required. The gateway WS presence channel is a *possible* later transport for the badge's live lane; P0–P2 deliberately use middleware SSE/poll so this feature has zero coupling to that team's churn.
- **Version bumps**: consume ui-components asks by moving the git sha in
  `portal/package.json` only after the owning session lands them on `main`;
  remember the stale-deps gotcha (`rm -rf node_modules/.vite` + dev-server
  restart after a pin bump).
- **Interface freeze points**: the announce payload and the `nodeToken` auth
  header are the plugin↔middleware contract; version them (`v: 1`) from day
  one since the plugin ships outside this repo's deploy cadence.

## Non-goals

- Not building the org-wide memory fabric, team memory sharing, or the merge
  queue — the harness doc specs those; this feature only *reports* the local
  sidecar's relationship to them.
- Not a remote-shell/SSH path to the laptop. No inbound connections to the
  machine, ever; the machine only dials out.
- Not presence for cloud sessions (Claude Code on the web, ECS harnesses) —
  they're already visible via the devbox fleet and traces.
- Not per-file locking/claims in P0–P2 (`touching` is informational; the
  collision-avoidance query from s19 is a P3+ read on top of it).
- No new billing machinery: local runs ride existing attribution; $0 model
  cost is a property of the run record, not a new budget type.

## Open questions (decide at implementation, defaults stated)

1. **Where does the plugin live?** Default: a small standalone package in the
   claude-mem plugin ecosystem (outside this repo), with a reference
   implementation checked in under `tools/local-compute-plugin/` here until
   it has a home — the announce contract is the real deliverable.
2. **`member` role pairing** — default yes (see Authorization).
3. **One chip or merged into GatewayStatusBadge?** Default: separate chip;
   the gateway badge reports *infrastructure*, this reports *your machine* —
   different mental objects.
4. **Session `intent` source** — default: first user prompt line, updated by
   a Stop-hook summary; never tool output (prompt text is sensitive — it
   stays out of the payload entirely, only the distilled one-liner travels).
