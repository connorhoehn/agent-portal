# Activity / work graph — migration from realtime-examples (2026-10-06)

The user asked where the activity graph from realtime-modules was. It was not
in this repo: realtime-examples shows it, platform-api feeds it, and the two
libraries ship the contract and the canvas. This document records what the
reference graph is, the exact wire contract the client hook expects, how orgiq's
own data maps onto it, and what slice 1 shipped.

Installed versions: realtime-modules **0.107.0** (`work-graph`, `work-graph/server`,
`client` → `useWorkGraph`), ui-components **2.410.0** (`graph` → `WorkGraph`).

## 1. What the reference graph is

**Where it lives.** One composite, `ActiveWorkGraphPanel`
(`realtime-examples/frontend/src/work-graph/WorkGraphPanel.tsx:815`), mounted in
two places:

- a side panel in Social chat (`pages/MessagesPage.tsx:3372-3388`), opened from the
  "Active now" rail (`MessagesPage.tsx:3625-3642`, `openPersonWorkGraph` `:3428`) or
  from a work reference in a message (`:3468`);
- a standalone page `/social/work-graph/:personId` (`app/App.tsx:595-598`,
  `work-graph/WorkGraphFullPage.tsx:22-56`) with **no nav entry** — reached by the
  panel's pop-out (`popOutWorkGraph`, `MessagesPage.tsx:3056`).

**What it shows.** One person's working day: a graph of their work, grouped into
*efforts* (frames), with a time strip over the local day.

| Node kind | Produced by (platform-api, shared reducer `projectEvent.js:51-213`) |
|---|---|
| `project`, `terminal`, `run`, `agent` | cloud-compute events (devbox sessions, jobs) |
| `terminal`, `project`, `run` | local-compute events |
| `document`, `change` | document revisions (`change` = one revision) |
| `run` (steps as `runId#stepId`), `terminal` | pipeline runs |
| `conversation` | a chat contribution |
| `meeting`, `transcript` | meeting lifecycle, recording/transcript |
| `task` | declared in the contract; **no reference source produces it** |

| Relation | Meaning in the reference |
|---|---|
| `works-on` | terminal → project |
| `runs-in` | run → terminal (workspace) |
| `operates-on` | agent → run |
| `produced` | run → document it wrote |
| `edited` | change → document |
| `derived-from` | run → its inputs; transcript → meeting |
| `discussed` | conversation → an explicitly related resource |
| `attended` | declared, unused |

**Day window.** `workDayWindow(day, timezone)` turns a local calendar day into a
half-open UTC interval (DST-correct); an entity belongs to the day when
`intervalOverlapsWorkDay(startedAt ?? updatedAt, endedAt, window)`. The reader
always ASKS for the whole local day (`workGraphQueryWindow`, `activity.ts:204`) and
applies the visible window (default: last 15 minutes, following now) client-side,
so dragging the time handle never restarts the subscription. The server clamps
the answer's window end to its observation instant.

**Live activity.** platform-api publishes two content-free Redis signals
(`work-graph.projection.changed`, `work-graph.access.changed`); the
websocket-gateway re-authorizes per subscriber (`/internal/work-graph/authorize`)
and replays deltas (`/replay`). Frames: `delta{batch}` (v2 adds `view`/`viewPatch`),
`invalidate{reason}`, `reset-required{reason}`, `activity{snapshot}`.

**Disclosure and capabilities.** Default deny: no grant → the uniform
`404 WORK_GRAPH_UNAVAILABLE`. A node's disclosure (`existence` | `summary` |
`details`) is the best grant capped by the source ACL; an existence-only node is a
"Shared work item" placeholder. Capabilities (`message`, `view-document`,
`view-run`, `dispatch-run`, …) are the intersection across sources and drive the
collaboration-request actions. Every HTTP request rebuilds authorization.

**v2 activity layer.** Efforts (`deriveWorkEfforts`, anchored on project/task/meeting),
per-node details (state line, badge, participants, footer, work-item link,
freshness lease), operations (a running process's leased edge — the animated
line), and event buckets (`bucketWorkEvents`, per-minute counts on the strip).

## 2. The wire contract the client hook expects

`useWorkGraph({ scope, transport, schemaVersion, window })`
(`client/work-graph/useWorkGraph.d.ts`). The host supplies the transport; the hook
owns the handshake and validates everything with the library's own validators.

- `scope = { viewerId, personId, day, timezone }`. Changing any field starts a new
  subscription generation and never shows the previous scope's data.
- `transport.fetchSnapshot({ scope, signal, activity? })` → a `WorkGraphSnapshot`
  (v1) or `WorkGraphSnapshotV2`. A thrown error with `status` 4xx (not 408/429) is a
  refusal (graph cleared, "Try again"); anything else is transient (backoff,
  last graph kept for `outageGraceMs`).
- `transport.openWebSocket({ scope, cursor, subscriptionGeneration, onMessage, onClose, onError, awaitAccess? })`
  → `{ close() }`. `onMessage` takes `WorkGraphStreamMessage`; v2 also accepts
  `activity` refreshes and deltas carrying `view`/`viewPatch`.
- Snapshot validity (`validation.js`, `validationV2.js`): exact keys only; ids match
  `^[A-Za-z0-9][A-Za-z0-9._:-]*$` (≤128); timestamps strict ISO `…sssZ`; ≤250 nodes,
  ≤500 edges; every edge endpoint present; v2 `query.personId/day/timezone` equal
  `scope`, `query.windowEnd ≤ temporal.observedAt`, buckets inside the day and
  ≤ observedAt, details only on `details`-disclosed nodes, operations only from a
  `run`/`agent`/`terminal` node on one of its own edges.
- Reducers (`reduceSnapshot.d.ts`): `createClientWorkGraphState`,
  `applyWorkGraphSnapshot(V2)` (fenced by generation and scope),
  `applyWorkGraphActivity` (dropped on another policy revision),
  `reduceWorkGraphStream` (`reset-required` → `refetch-required`; `gap`,
  `replay-unavailable`, `source-unavailable` keep the graph visible while refetching).

## 3. Mapping onto orgiq's own data

orgiq has **rows**, not a lifecycle event log, so the projection is a pure
function over rows already served by REST (`middleware/src/lib/work-graph/`), and
its temporal mode is always `recent` (latest state), never an `as-of`
reconstruction. The contract's `personId` slot carries the graph's **subject**:
`initiative:<id>`, `workspace` or (slice 2) `person:<id>`.

| orgiq entity (source) | Node | Edge | Read gate mirrored (fresh per request) | Slice |
|---|---|---|---|---|
| initiative (`getProject` / `listProjects`) | `project` `initiative:<id>` | — | `/api/graph/projects/:id`: `requireTenant('orgiq')` | 1 |
| work item (`getProjectWorkItems`) | `task` `work:<id>` | → initiative `works-on` | `/api/graph/projects/:id/work`: tenant | 1 |
| person (assignee on the row) | detail `participants` on the task | — | tenant (the row's own `assigneeName`) | 1 |
| bot run (`listBotRunsForBotsResult`, depth 50/bot) | `run` `run:<id>` | → its work item `operates-on`, else → initiative `works-on` | `/api/bots/:id/runs`: org-leader, hr-admin, program-owner, else `ManageBots` | 1 |
| marketplace run (`listMarketplaceRuns`, depth 100) | `run` | → work item `operates-on` | `/api/bots/marketplace-runs`: org-leader, hr-admin, else `DispatchAgentRun` | 1 |
| bot (`listBotsResult`) | `agent` `agent:<id>` | → run `operates-on` | `/api/bots/:id`: as bot runs | 1 |
| work↔document association (`listWorkDocuments`) | `document` `doc:<id>` | work item → doc `derived-from` | `/api/graph/work-items/:id/documents`: tenant | 1 |
| decisions (`listDecisionActivity`; the `decisions` table `/api/graph/decisions` and the Decisions tab serve) | `change` `decision:<id>`, only on an instant the row carries (`escalated_at`, or the `decided_at` calendar day) | → initiative `works-on`; → the work item it shapes `discussed` | `/api/graph/decisions`: tenant | 2 |
| sprints (`listSprints`, the `/api/sprints` rows) | `task` `sprint:<id>`, a DATE range read as calendar days in the viewer's zone | → initiative `works-on`; work item in the sprint → sprint `works-on` | `requireSession('ViewSprints')`; `scope=all` and its money = budgets read tier, else the viewer's own sprints (`scope=mine`) | 2 |
| sprint envelopes (`listGrants`) | detail line on the sprint (`Envelope · name $x`) | — | `/api/grants`: org-leader, hr-admin, else `ManageBudgets` | 2 |
| agent_jobs (work queue, `/api/work/jobs`) | `run` (queued/claimed) | → work item `operates-on`; `bot_runs.job_id` joins | `ViewWork` | 3 |
| devbox / local compute (`devbox_boxes`, local-compute) | `terminal` + `runs-in` | run → terminal | `ManageDevbox` / owner | 2 (the existing `middleware/src/work-graph/` compute emitter already maps these for platform-api) |
| flow runs (`flow_runs`, orgiq kinds `orgiq.summarize/diagram/doc`) | `run` `flow:<id>`; steps are a detail line, not nodes | → initiative `works-on` / work item `operates-on`, from the run's conversation scope | requester-private AND the run's conversation read, asked per run (`routes/conversation-summarize.ts` `ownRun`) | 2 |
| initiative chat / huddle (`orgiq:initiative:<id>`, call chat) | `conversation` / `meeting` | `discussed` / `attended` | `orgiq:initiative` family; call-chat participants | 3 |

Honesty rules the projection keeps (CLAUDE.md honest numbers):

- Every node is exactly one source row; every count, cost and timestamp on the
  wire is that row's own (`Cost · $0.0341` is `bot_runs.cost_usd` to four places;
  bucket counts sum to the rows' own instants inside the day). Nothing is derived
  from a number another surface computed.
- Day membership is the library's own `intervalOverlapsWorkDay`: a work item is
  `[created_at, completed_at]` (a closed row without `completed_at` ends at its
  last update); a run is `[started_at, finished_at]`, open while running.
- Mock mode replays seeded work-item timestamps through `mockReprojectedIso`, the
  same reprojection the activity feed and series share.
- `running` is reserved for a process (a bot run). An initiative or a work item in
  progress is `idle` with its row's status word as the badge — the renderer reads
  a running node without a fresh lease as "updates delayed", which would be a
  claim about a process that does not exist.
- A live run's animated edge and fresh dot come from a 5-minute lease on the read
  that saw `status = 'running'`; it expires on its own.
- Bounded reads say so: a bot whose 50-row history page is entirely inside the day,
  a marketplace page of 100, or more than 100 document lookups mark
  `coverage.complete = false`.

Authority (`lib/work-graph/authority.ts`): default deny, decided per request from
the session reloaded through `currentLiveSession` (epoch, grants, masquerade actor)
and re-checked after the reads. A part the viewer's gate refuses is never read — a
member's request never touches `bot_runs` — and leaves no placeholder or count. A
Cedar evaluation that throws withholds that part and reports the source
`authorization-unavailable` (`partial: true`).

## 4. Slice 1 — shipped 2026-10-06

**BFF.**

- `middleware/src/routes/work-graph.ts` — `GET /api/work-graph/initiatives/:id/graph`
  and `GET /api/work-graph/workspace/graph` (`?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]`),
  mounted under `requireTenant('orgiq')` (`index.ts`). Unknown keys and half a v2
  query are 400s; a missing initiative is the reference's uniform 404 body.
- `middleware/src/lib/work-graph/projection.ts` (pure), `sources.ts` (provider reads
  behind the gates), `snapshot.ts` (v1 / v2 via the library's
  `buildWorkGraphSnapshotV2`, `deriveWorkEfforts` anchored on initiatives,
  `bucketWorkEvents`), `authority.ts`, `live.ts`.
- Live: a content-free `work-graph.changed` activity row (`{ initiativeId?, cause }`)
  on the dedicated default-deny family **`orgiq:workgraph`**
  (`lib/tenant-channels.ts`: one exact name, read = active orgiq tenant, write =
  none, no lobby, no presence/reactions). Producers: work-item create/patch
  (`routes/work-items.ts`), document link/unlink (`routes/work-documents.ts`), and
  every bot run insert/settle (`onBotRunChange` in `providers/bots.ts`). The hint is
  not the record: the portal answers it with a fresh, re-authorized snapshot.
- Mock floor: no new fixture — the projection reads only registered fixtures
  (initiatives, work items, bots, bot runs, work-document links), so
  `POST /api/__mock/reset` restores it. Wire snapshots recaptured on a private
  `:3012` server (capture hints for both routes in `mock/core/wire/capture.ts`,
  the `:id` source in `http.ts`).

**Portal.**

- `portal/src/lib/workGraph.ts` — the `useWorkGraph` transport (snapshot fetch; a hint
  becomes `reset-required`/`gap`, so the last authorized graph stays on screen while
  it refetches), the state → `WorkGraph` presentation mapping, and open targets
  (initiative, work item, bot, document pages).
- `portal/src/components/work-graph/WorkGraphActivity.tsx` — `useWorkGraph` (v2) into
  ui-components' `WorkGraph`; subscribes `useActivity('orgiq:workgraph')` while the
  gateway is connected.
- `portal/src/components/ChannelActivity.tsx` — with `graph`, the initiative
  overview's Activity section leads with the graph and keeps the channel's
  `WrappedActivityPanel` feed beneath it (the pipelines run page is unchanged).
- `/iq/activity` (`pages/iq/ActivityPage.tsx`, `App.tsx`) — the full-page workspace
  graph (`?initiative=` scopes it, `?day=` picks a day), reached from the overview's
  pop-out like the reference's standalone page. **Not in the rail or palette**: the
  reference gives its page no nav entry, and `components/shell/**` is being edited
  by another session; adding a rail/palette row (Operate group, every orgiq role,
  matching the route) is a follow-up. nav-parity holds either way (the palette
  never offers a jump the route refuses).

**Verified.** Middleware: projection honesty + snapshot validators (10), route
honesty/authz matrix (6), family refusals + hint delivery (5); typecheck. Portal:
reducers/transport/presentation (`node:test`, 5); typecheck, 1,414 tests, build.
Headless Playwright `portal/e2e/orgiq-activity-graph.spec.ts` (3/3): the overview
draws every run node the API serves; a member is served and shown no runs; another
SME's status change appears on an open page without reload (~0.4 s). Gates: route
coverage 0/670, mock floor, component discipline, nav parity, honest numbers.

## 4b. Slice 2 — shipped 2026-10-06

**Library kind set (verified against the installed dist).** realtime-modules
`work-graph/contracts.d.ts` and ui-components `graph.d.ts` carry the same ten node
kinds (`project terminal agent run document change conversation meeting
transcript task`) and eight relations. There is no `sprint`, `decision` or
`person` kind, so: a sprint is a `task` (`sprint:<id>`, badge "Sprint · dates"), a
decision is a `change` (`decision:<id>`), a flow run is a `run` (`flow:<id>`), and a
person is **not a node** — the person is the graph's subject (`scope.personId =
person:<id>`) and appears as `participants` on the work item, sprint and decision
cards. Adding real `sprint`/`decision`/`person` kinds is a library change (queue).

**BFF.**

- `GET /api/work-graph/people/:id/graph` (same query contract). A person's day is
  the rows that person is attached to: work items they are assigned, bot/marketplace
  runs that operated on those items, sprints they steward or have work in,
  decisions they participate in, and — only when the person is the viewer's own
  linked person — the viewer's flow runs. Initiative *owner* is shown as the
  initiative card's `Owner` line; it does not pull the owner's other initiatives'
  rows into the day. Unknown person: the uniform 404.
- Initiative and workspace graphs gain sprints, decisions and the viewer's own
  flow runs (an initiative graph keeps only runs whose conversation names it).
- Sources: `providers/decisions.ts` `listDecisionActivity` (new reader, mock +
  SQL, same table), `lib/flow-runs/store.ts` `listByRequester`, the existing
  sprints/grants/projects/work-item providers. Sprint, decision and document
  failures share the `document` source health (the contract has no "records" kind);
  flow runs report on `pipeline`.
- Gates (`lib/work-graph/authority.ts`, per request, never cached): sprints at the
  viewer's own scope (`mine`, via their linked person) unless the budgets read tier
  (`org-leader`, `hr-admin`, `program-owner`, `admin`, else `ManageBudgets`), which
  reads all sprints and the money they carry (`Planned · $`, `Granted · $`);
  envelope lines need the grants gate (`org-leader`, `hr-admin`, else
  `ManageBudgets`); decisions tenant-only, like their REST routes; flow runs are
  the viewer's own and each run's conversation is re-authorized. A budgets-tier
  Cedar failure withholds the money and marks `document` `authorization-unavailable`.
  The policy revision now includes both new gate outcomes.
- Honesty: a decision with neither `escalated_at` nor `decided_at` has no moment and
  is not drawn (`created_at` is the seed's `NOW()` default, not an event). A
  `decided_at` DATE spans its calendar day in the viewer's zone and adds no event
  bucket. A sprint in session across the day is stamped live at the day's start
  (else the reader folds it as "earlier" context); counts are the sprint row's own
  rollups; money lines appear only behind their gate. Detail lines are capped at
  the contract's four. Flow run source material and results are never carried.
- Assessment runs: **not projected.** `assessment_runs` and drafts are behind
  `requireTenant('assessment')` + `ViewAssessment`; no orgiq-tenant read exists to
  mirror, so nothing in the orgiq graph can honestly show them (slice 5).
- Live: still content-free hints on `orgiq:workgraph`, new causes `sprint` (sprint
  create, sprint item add/remove, grant create/patch/revoke), `decision` (decision
  link/unlink) and `flow-run` (an orgiq flow run's move, resolved to its
  initiative). No new channel, no payload beyond `{ initiativeId?, cause }`.
- Mock floor: no new fixture (decisions, sprints, grants, flow runs, work items are
  registered); capture hints for the person route in `mock/core/wire/capture.ts` /
  `http.ts`; wire/routes/writes snapshots recaptured on a private `:3012` server.

**Portal.** `lib/workGraph.ts` handles the `person` subject (key, path, hints) and
opens sprint (`/iq/projects?lens=sprints`) and decision (initiative Decisions tab)
nodes; `/iq/activity` has a library `Select` person picker (`?person=`, people
from `/api/graph/entities`) beside "Whole workspace". The initiative overview graph
draws sprints and decisions with no portal change (same snapshot).

**Verified.** Middleware: 11 projection tests (5 new), 11 route tests (5 new:
provider-vs-wire honesty for sprints and decisions, budgets-tier money gating,
Cedar failure, own-flow-runs-only incl. conversation re-authorization and
cross-tenant exclusion, the person day incl. never another person's flow runs),
6 live tests (1 new). Portal: 7 node:test (2 new). Playwright
`orgiq-activity-graph.spec.ts` 5/5 (a sprint card on the overview and a decision
card on its day for a budgets-tier viewer; the person selector narrows the graph
and the URL).

## 4c. Slice 3 — shipped 2026-10-06

- **agent_jobs.** Live rows (`queued`, `claimed`, `running`; read per status via
  `listJobs`, cap 100) become `run` nodes `job:<id>`: queued = `idle`, claimed or
  running = `running`, with a freshness lease only while `running`. Attribution
  is the payload's `workItemId` (checked against the items already read), else
  its bot's target, else `initiativeId`; unattributable jobs are not drawn. The
  prompt, payload and result are never carried. A job a bot run already shows
  (`bot_runs.job_id`) is not drawn twice.
- **Gate.** `/api/work/jobs` is signed-in only (`requireSession('ViewWork')`), but
  a job row is a prompt-carrying dispatch record, so the graph uses the narrower
  dispatch tier (`reads.marketplaceRuns`: org-leader/hr-admin/admin, else
  `DispatchAgentRun`). A member, or a failed Cedar decision, gets no job nodes.
  Never wider than REST.
- **Live.** New hint cause `job` from `jobEvents` (enqueue, claim, start, finish,
  cancel); content-free `{ initiativeId?, cause }` like the rest. The stream's
  per-viewer rebuild turns it into deltas, for initiative, workspace and
  `person:<id>` subjects (a person's day carries only jobs serving their items).
- **Person subject.** Already in the `orgiq:workgraph` family (default deny);
  tests now prove a pipelines session and a forged orgiq context are refused.
- **Portal.** `workGraphNodeHref` opens job and flow nodes (work item, else
  initiative). No library addition: kinds/colours cannot be set per node by props,
  and the existing `run` kind carries the badge words.
- **Mock floor.** No new fixture (`agentJobs` is registered); snapshots recaptured
  on a private :3012 server (this also absorbed another session's `/agent` routes).

## 5. Further slices

3. (agent_jobs shipped in 4c) devbox/local-compute `terminal` nodes (reuse
   `middleware/src/work-graph/` mappers); initiative chat and huddles as
   `conversation`/`meeting`; an "Active now" entry point from presence into the
   person day; a day picker on `/iq/activity`; rail + palette rows; library
   `sprint`/`decision`/`person` node kinds so these stop borrowing `task`/`change`.
4. Real deltas instead of refetch hints (watermarked per-subscription replay, as
   platform-api's `/replay`), node detail panes (`WorkNodePane`), omitted-node paging.
5. Social tenant behind its own family and read gates. Shipped: pipelines §8, assessment §9, social §10.

## 8. Pipelines counterpart — shipped 2026-10-06 (parity gap 5)

The pipelines tenant draws its own work on the same snapshot assembly, v2
validation and live stream as orgiq; only the projection, the gates and the
channel family are the tenant's.

**8.1 What is drawn** (`lib/work-graph/pipelines-projection.ts`, rows read by
`pipelines-sources.ts` through the providers `/api/pipelines/*` already uses):

| Node | Kind | Row | Edge |
|---|---|---|---|
| `definition:<id>` | `project` (effort anchor) | the definition a drawn run belongs to | run → definition `works-on` |
| `prun:<id>` | `run` | a projected run, its status crosswalked (`running` is a live process, `awaiting_approval` is `waiting`) | |
| `step:<run>:<step>` | `task` | a step of the run (all steps on a run page; only in-flight runs' steps on the workspace) | step → run `works-on` |
| `approval:<id>` | `change` | a pending approval (`GET /api/pipelines/approvals`), an open interval from `requestedAt` | approval → step `operates-on` (→ run if the step is not drawn) |
| `deck:<id>` | `document` | a run report deck (`GET /api/pipelines/decks`) | deck → run `derived-from` |
| `pflow:<id>` | `run` | the viewer's own summarize / diagram / doc / agent / deck-revise flow runs | → its run or deck `operates-on` |

People acting are participants on a node's detail (`triggeredBy`, a deck's
`producedBy`); the contract has no person node kind. The reader draws only
nodes inside an effort, so rows no run owns (a consult or change awaiting a
person, an approval on a run older than the day, a flow tied to no run) hang off
a labelled queue anchor (`queue:<source>`, kind `project`) that carries no count
or timestamp of its own; a run whose definition the registry no longer lists is
anchored by a definition node made from the run's `definitionId`. A running
step animates its edge to the run (the contract's process must be a run node).

**8.2 Gates** (`authority.ts` `pipelinesWorkGraphViewer`, decided per request
from the reloaded session, never cached): tenant `pipelines` (admin crosses, as
`requireTenant`), `ViewPipelines` for definitions, runs, steps, decks and own
flow runs, `ApproveStep` for approvals. An author never receives an approval
node, its title, or any trace of it, in the snapshot or on the stream. A gate
that cannot be decided withholds its part (default deny) and marks the `pipeline`
source `authorization-unavailable`. A run the viewer cannot read answers the
uniform 404. The policy revision (`pipelines.<hash>`) moves with either gate, so
a lost `ApproveStep` ends an open stream with a content-free `invalidate`.

**8.3 Wire.** `GET /api/pipelines/work-graph/runs/:id/graph` and
`/workspace/graph` (`routes/pipelines-work-graph.ts`, mounted inside the pipelines
router behind `requireTenant('pipelines')`). Subjects in the contract's `personId`
slot: `run:<id>` and `workspace:pipelines` (never `workspace`, which stays
orgiq's, so one key cannot name both tenants' graphs).

**8.4 Live.** Family `pipelines:workgraph[:workspace|:run:<id>]` in
`lib/tenant-channels.ts`, default-deny, read = tenant + `ViewPipelines`, nobody
publishes. One `WorkGraphSource` serves both tenants: the channel prefix selects
the tenant's builder and policy-revision function (`stream.ts`), and a change names
its tenant so an orgiq change never recomputes a pipelines reader and vice versa.
Content-free `work-graph.changed` hints (`live.ts`) on job change (an
`awaiting_review` job is an `approval`), bot run, pipelines flow-run move, run
cancel, approval decision, deck create, lab consult open/answer and change-request
decision; the hint names at most a run id. Found by the tests: an `access` signal
names no tenant and must reach every open stream (it was dropped by the new
tenant filter until `concerns` special-cased it).

**8.5 Portal.** `lib/workGraph.ts` gains `run` / `pipelines` subjects, the
`pipelines:workgraph` hint channel and node destinations (run, approvals page,
deck, definitions); the run page (pipelines door only) gets an Activity section
and `/pipelines/activity` is the workspace page (open to every pipelines role,
like the API), linked from Runs.

**8.6 Not done (since closed: both rows exist in `Layout.tsx` / `portalCommands.ts`).** The rail row (`Layout.tsx` NAV_ITEMS) and palette row
(`portalCommands.ts`) for `/pipelines/activity` live under
`portal/src/components/shell/**`, which this change was told not to edit. Add
`{ label: 'Activity', hint: 'Runs, steps and approvals for the day', path:
'/pipelines/activity', tenant: 'pipelines', group: 'Runs', keywords: ['activity',
'graph', 'runs', 'approvals'] }` to both, with no `roles` (route and API are open
to every pipelines role); nav parity is green without it because it only checks
that palette rows resolve. Change-request creation (a capture) has no hint yet; a
new pending change shows at the next hint. Flow runs of `pipelines.deck-revise`
are the requester's alone, behind `ViewPipelines`.

**8.7 Verification.** Jest: projection honesty and policy revision
(`projection.test.ts`), the authz matrix over the real mock fixtures
(`routes/__tests__/pipelines-work-graph.test.ts`), stream default-deny, per-viewer
frames, run page and revocation (`stream.test.ts`), hints and family
(`live.test.ts`). Portal `node:test` (`lib/__tests__/workGraph.test.ts`).
Playwright `e2e/pipelines-activity-graph.spec.ts` against the shared stack:
run appears and is cancelled, a consult arrives as an approval for an operator and
never for an author, and leaves when answered, all as stream deltas; the run page
graph. Mock floor: no new fixture; snapshots recaptured on a private :3012 server.

## 9. Assessment counterpart — shipped 2026-10-06 (parity gap 5)

The assessment tenant draws its own work on the same snapshot assembly, v2
validation and live stream as orgiq and pipelines; only the projection, the
gates and the channel family are the tenant's.

**9.1 What is drawn** (`lib/work-graph/assessment-projection.ts`, rows read by
`assessment-sources.ts` through the providers `/api/assessment/*` already uses):

| Node | Kind | Row | Edge (direction as designed) |
|---|---|---|---|
| `team:<id>` | `project` (effort anchor) | a team (an assessment) with something drawn; the page's own team always | team → dimension `works-on` |
| `dim:<team>:<dim>` | `task` | a dimension: its level, confidence, open follow-ups; the day's score change is its newest history entry | |
| `evidence:<team>:<id>` | `document` | an evidence row (`GET /teams/:id/evidence`: scored and pending) | evidence → dimension `operates-on` (→ team if the dimension is unknown) |
| `draft:<runId>` | `change` | an evidence summary / follow-up draft (durable flow run); running, `waiting` once finished and undecided, `completed` accepted, `stopped` discarded | draft → dimension `operates-on` |
| `adeck:<id>` | `document` | a review deck (`GET /decks`) | deck → team `derived-from` |
| `arun:<id>` | `run` | an agent run of the `assessment_runs` ledger (`GET /runs`) | run → deck (its `deck_id`) else team `operates-on` |
| `aflow:<id>` | `run` | the viewer's own summarize / diagram / doc / agent flow runs | → its team (`assessment:team:<id>` scope) else a queue anchor |

People acting are participants on a node's detail (the dimension's last scorer,
a draft's requester, the team lead). A workspace day draws a team only when one
of its rows moved in the day (a dimension scored, evidence captured, a draft,
deck or run touched); a team page draws everything of that team, older rows
folding as context. Rows no team owns (a run with no team, a flow about a
document) hang off a labelled `queue:<source>` anchor with no count of its own.

**9.2 Gates** (`authority.ts` `assessmentWorkGraphViewer`, decided per request
from the reloaded session, never cached): tenant `assessment` (admin crosses, as
`requireTenant`), `ViewAssessment` for teams, dimensions, evidence, drafts, decks
and ledger runs (every GET above uses it), `RunAssessmentAgent` for the viewer's
OWN flow runs (requester-private; each re-checked against its conversation's
chat read), `ScoreAssessment` only marks a draft the viewer may act on
(`edit-document`; `dispatch-run` with the run gate) and never widens what is
drawn. All three feed the policy revision (`assessment.<hash>`), so losing any
one ends an open stream with a content-free `invalidate`. A gate that cannot be
decided withholds its part (default deny) and marks the `document` source
`authorization-unavailable`. A team the viewer cannot read answers the uniform
404. The assessment REST gates are not per-team, so "teams they cannot read" means
no `ViewAssessment` (or another tenant): such a viewer receives no team, draft or
evidence, in the snapshot or on the stream.

**9.3 Wire.** `GET /api/assessment/work-graph/teams/:id/graph` and
`/workspace/graph` (`routes/assessment-work-graph.ts`, mounted inside the
assessment router behind `requireTenant('assessment')`). Subjects in the
contract's `personId` slot: `team:<id>` and `workspace:assessment`.

**9.4 Live.** Family `assessment:workgraph[:workspace|:team:TEAM-…]` in
`lib/tenant-channels.ts`, default-deny, read = tenant + `ViewAssessment`, nobody
publishes; stream channels `assessment:workgraph:team:<id>` and
`assessment:workgraph:workspace`. Content-free `work-graph.changed` hints
(`live.ts`, naming at most a `teamId` and a cause: `score`, `evidence`, `draft`,
`deck`, `run`, `flow-run`) come from three places: a `changeHints()` middleware on
the assessment router (any 2xx write on a score, evidence, intake, draft, deck,
submission, feedback or run path), the durable flow-run move events (a draft
finishing, a conversation flow), and the assessment event broker's `run.*` events.
Document proposals (`/doc/proposals`) are not drawn: they attach to a knowledge
document, which no team or dimension owns, and their REST gate is signed-in only.

**9.5 Portal.** `lib/workGraph.ts` gains `team` / `assessment` subjects, the
`assessment:workgraph` hint channel and node destinations (team, dimension,
evidence/draft at their dimension, deck, run ledger). The team scorecard gets an
Activity tab (`?tab=activity`, mounted on first visit), and `/assessment/activity`
(`pages/assessment/ActivityPage.tsx`) is the workspace page, open to every
assessment role like the API. Rail row "Activity graph" under Analyze
(`Layout.tsx`) and the matching palette row (`portalCommands.ts`), neither
role-gated (the API is `ViewAssessment`, which every assessment role holds; the
existing System "Activity" row is the agent run ledger, hence the distinct label).

**9.6 Verification.** Jest: pure projection (`assessment-projection.test.ts`),
honesty and the authz matrix over the real mock fixtures
(`routes/__tests__/assessment-work-graph.test.ts`: no `ViewAssessment` gets no
team/draft/evidence, own flow runs need `RunAssessmentAgent`, cross-tenant 403,
anonymous/stale/forged 401, Cedar down withholds), stream default-deny, per-viewer
frames, team page and revocation (`stream.test.ts`), hints and family
(`live.test.ts`). Portal `node:test` (`lib/__tests__/workGraph.test.ts`).
Playwright `e2e/assessment-activity-graph.spec.ts` against the shared stack (3/3):
rail row, scorecard tab, a score change and an evidence draft arriving as deltas
on the socket, an orgiq session refused. Mock floor: no new fixture; snapshots
recaptured on a private :3012 server. Journey-log digests of the assessment
dashboard and scorecard pages are stale from these page edits and were not sealed.

## 10. Social counterpart — shipped 2026-10-07 (parity gap 5, last tenant)

The social tenant draws the conversations a person belongs to on the same snapshot
assembly, v2 validation and live stream as orgiq, pipelines and assessment. Only the
projection, the gates and the channel family are the tenant's. The difference from
the other three is that every part sits behind **membership**, not a role: a private
channel is a secret, so the graph never reads, names or counts one the viewer is not in.

**10.1 What is drawn** (`lib/work-graph/social-projection.ts`; rows read by
`social-sources.ts` through the providers `/api/social` and `/api/chat` already use):

| Node | Kind | Row | Edge (direction as designed) |
|---|---|---|---|
| `sconv:<channel name>` | `project` (effort anchor) | a channel the viewer is an active member of, a DM, a team channel, a room | |
| `steam:<id>` | `project` | a team the viewer belongs to, with a channel drawn | team → channel `works-on` |
| `sthread:<channel name>` | `conversation` | the day's messages in one conversation: a COUNT, first/last time and the people who posted, never text | thread → conversation `discussed` |
| `scall:<id>` | `meeting` | the viewer's call-log rows plus calls the call state store holds now (ringing = `waiting`, answered = `running`) | call → conversation `runs-in` |
| `srec:<id>` | `transcript` | a recording the viewer was in | recording → call `derived-from` (→ conversation if the call is not drawn) |
| `sdeck:<id>` | `document` | a deck built from a drawn conversation | deck → conversation `derived-from` |
| `sflow:<id>` | `run` | the viewer's OWN summarize / diagram / doc / agent / deck runs | run → conversation `operates-on` |

Conversation node ids carry the plain chat channel name (`sconv:social:ch:general`)
and their detail footer is `Conversation · <channel name>`; the portal reads its
destination from that. A workspace day draws a conversation only when something in it
moved in the day; a conversation page draws that conversation alone with all of its
calls, recordings, decks and runs (older ones fold as context). People acting are
participants on a node's detail.

**10.2 Membership and gates** (`authority.ts` `socialWorkGraphViewer`, `social-sources.ts`;
decided per request from the reloaded session, never cached): the tenant is `social`
(admin crosses, as `requireTenant`); `ViewSocial` is decided as the gateway decides it,
against the roles held in the social tenant (`live-principal.ts` `socialActionRole`).
`PostMessage` and `StartCall` only mark capabilities (`message`/`join-conversation`,
`join-meeting`) and never widen what is drawn. A conversation is read only after
`socialConversationReadable` (the chat's own rule from `routes/chat-pins.ts`
`chatAccess`: the lobby/name rule — channel members, DM ids, team roster — and the chat
service's explicit membership rows) says the viewer belongs to it now; a public channel
the viewer has not joined is not theirs here either, as the gateway admits members only.
Messages respect the member's history floor and skip deleted ones. A call-log row that
is still open but that nothing live corroborates (no entry in the call state store, older
than five minutes) is `stale`, not `running`: the platform log can keep a row open forever.
A gate that cannot be decided withholds its part and marks the `conversation` source
`authorization-unavailable`. A conversation page the viewer does not belong to answers the
uniform 404, the same body as an absent or malformed one.

**10.3 Wire.** `GET /api/social/work-graph/workspace/graph` and
`/conversations/:id/graph` (`routes/social-work-graph.ts`, mounted in `routes/social.ts`
behind `requireTenant('social')`); `:id` is the URL-encoded channel name. Subjects in
the contract's `personId` slot: `workspace:social` and `conversation:<channel name>`.

**10.4 Live.** Family `social:workgraph[:workspace|:conversation:<channel>]` in
`lib/tenant-channels.ts` (`PartitionTenant` gains `social` for this family only;
`TENANT_PARTITIONS` stays three, so every other `social:` name keeps its own rules),
default-deny, read = active tenant + `ViewSocial`, nobody publishes. The sync channel
guard admits any `social:` name, so `live-principal.ts` also refuses every
`social:workgraph*` name that is not the family's, and adds
`authorizeSocialWorkGraphChannel`: a conversation stream asks the conversation's chat read
fresh on every subscribe and delivered frame, so a non-member is refused before anything is
computed and a removed member's stream ends. Hints never carry content, and the
conversation name is itself a secret, so: the stream-internal change names the conversation
(it only narrows which open streams recompute and is never sent), while the fallback hint
every `ViewSocial` reader may subscribe to is `{ cause: 'activity' }` and nothing else.
The sources of change, none touching `lib/realtime-gateway.ts` or `lib/call-chat*.ts`:
a stored message and a membership write (`lib/social-chat.ts` patches the one store
instance every writer shares), the call state store (`lib/call-pages.ts`
`watchCallStateForWorkGraph`: placed, answered, last seat left, forgotten, and a recording
re-hint a few seconds after the end), deck saves/revisions (`providers/social-decks.ts`),
recording delete (`routes/social.ts`) and the durable flow-run moves (`live.ts`). They meet in
`lib/work-graph/social-events.ts` and are coalesced per conversation per 250 ms
(`live.ts` `coalescedSocialHint`). A recording that platform-api finishes by itself has no
BFF event; it arrives with the call-end re-hint or the next change.

**10.5 Portal.** `lib/workGraph.ts` gains `social` subjects, the `social:workgraph` hint
channel and node destinations. `/social/work-graph` (`pages/social/WorkGraphPage.tsx`) is the
workspace page, rail row "Work graph" under Library (`Layout.tsx`) and the matching palette
row (`portalCommands.ts`), neither role-gated (the API is `ViewSocial`, which every social
role holds). Inside a conversation the chat workspace's header has a "Work graph" toggle
(`?view=graph`, `SocialConversation.tsx`): the library's conversation tabs have no graph view,
so the graph replaces the transcript pane and any view tab closes it. Channels, DMs and team
channels have it; room panes do not.

**10.6 Verification.** Jest: pure projection (`social-projection.test.ts`), honesty and the
membership matrix over the real mock fixtures (`routes/__tests__/social-work-graph.test.ts`:
a non-member of a private channel/DM/room/team gets none of its nodes, titles, calls, decks or
runs and the same 404 as an absent conversation; leaving a channel and a history floor take
effect on the next read; other people's flow runs are never drawn; no `ViewSocial` gets nothing;
Cedar down withholds; another tenant 403; anonymous/stale 401), the family and the router
authorization with the conversation read, the content-free hint, the three event seams and the
burst coalescing (`social-live.test.ts`), per-viewer frames and revocation
(`stream.test.ts`: a live message and a call status change as deltas that reduce to each
viewer's REST snapshot; a member of #general never receives #moderators; removal ends the page
stream with a content-free invalidate). Portal `node:test` (`lib/__tests__/workGraph.test.ts`).
Playwright `e2e/social-activity-graph.spec.ts` against the shared stack (4/4): the rail row, a
live message as a stream delta on a second member's conversation graph, a call placed and left
as stream deltas on the workspace graph, a non-member and an orgiq session refused. Mock floor:
snapshots recaptured on a private :3113 server (query hints and an `:id` source added in
`wire/capture.ts` / `wire/http.ts`; a person in no conversation is answered the uniform 404, so
the conversation route's `:id` capture is recorded as skipped). Route coverage at budget. The
`validate-social-tenant.sh --quick` journey-log digests are stale from the page edits and were
not sealed. Not covered: Aurora/IAM, a real recording landing without a call end, and calls on
another replica (the live overlay is per process; the log row then reads `stale` after five
minutes rather than `running`).
