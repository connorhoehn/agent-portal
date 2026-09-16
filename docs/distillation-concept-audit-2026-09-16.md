# Distillation Overview / Lineage — concept + UX audit
Repo: aws-agentcore · read-only · 2026-09-15

Scope read: `docs/distillation.md`, `docs/distillation-goal.md`,
`portal/src/pages/distillation/{OverviewPage,ProcessFlow,LineagePage,LineageFrame,
CompactionFlowFrame,CompactionFlow,ArtifactsPage,TiersPage,CompactionsPage,
distillationFormat,types}.tsx|ts`, `middleware/src/routes/distillation.ts`,
`middleware/src/providers/distillation.ts` (1504 lines), `middleware/src/mock/distillation.ts`
(1849 lines), `middleware/src/lib/local-compute-fleet.ts`, `middleware/src/routes/local-compute.ts`,
`middleware/src/routes/work.ts` (SSE), `middleware/src/routes/library.ts`,
`middleware/src/providers/prompt-library.ts`, `middleware/src/routes/promotions.ts`,
ui-components `shared/{StatusDot,DotMeter,Chip,ActivityFeed,EventRow,ProgressBar,
CardHeader,DropdownMenu,StackDiagram}.tsx`.

---

## 1. Concept audit of the Overview

### What each section claims to show, and whether it's mock-floor honest

`OverviewPage.tsx` has five sections. I checked each against
`docs/distillation.md`'s rule that "every number is counted from the queue
underneath it," which is the module's own stated contract
(`middleware/src/mock/distillation.ts:9-18`).

| Section | Claim | Backing rows | Honest? |
|---|---|---|---|
| `StatStrip` (OverviewPage.tsx:138-155) | L0/L1/L2 counts, active writers, L1 sample rate, proven procedures | `/levels`, `/ingest`, `/sampling`, `/procedures` | **Partially.** "Proven procedures" (`rollup.proven`/`rollup.total`) is computed by `procedureRollup()` (distillationFormat.ts:475-486) from the exact same `proceduresData.procedures` array the table below renders — this is the one number on the page that provably cannot drift from its table, the pattern every other card should copy. The other five StatStrip cells (L0/L1/L2/writers/sample-rate) have **no table on this page to check them against** — L0/L1/L2 counts are only checked by the Tiers page, active writers/sample-rate never render as rows on Overview at all. Not dishonest (they are counted server-side, see `providers/distillation.ts` module note lines 1-20), just **unverifiable from this page alone**, which is the same shape of bug the goal doc's "950/180/40 above lists of 69/22/8" defect was, just not yet triggered because nothing on Overview lists L0/L1/L2 items today. |
| `ProcessFlow` (OverviewPage.tsx:160-184) | "sessions, bot runs, sweeps and lab signals → L0 → L1 → L2 → Library, Promotions, Session config" | 8 separate fetches, reduced by `processFlowModel` (distillationFormat.ts:668-768) | Every node count is real and guarded on shape (`ProcessFlow.tsx:41-63`, e.g. `botRunsToday` is `null` not `0` on a failed fetch — good precedent). **But it draws from 8 different endpoints at 4 different poll cadences (20s/20s/20s/60s×5) that were never designed to agree at one instant** — the graphic is a snapshot mosaic, not a single consistent read. |
| "What the fleet knows how to do" (repertoire table, OverviewPage.tsx:192-217) | procedures with proof/last-proven/runs/success | `/procedures` | Honest — same array backs the StatStrip cell above it. |
| "Ingest pressure" (OverviewPage.tsx:219-244) | active writers, obs/hr, top-repo `ProgressBar`s | `/ingest` | Honest, standalone (no cross-check needed — it's the only place these numbers render). |
| "Sampling verdict" (OverviewPage.tsx:246-255) | verdict + reviewed-in-30d + queue depth | `/sampling` | Honest, standalone; the actual queue is one click away (`Review sample`, per `docs/distillation.md`'s note that this used to be a bare number with no queue — now fixed). |

**Fix for the brief's "the numbers should tie to the tables":** the two
un-backed StatStrip cells (L0/L1/L2, active writers) are the ones a person
will most want to trust-but-verify, because they're the ones a
last-activity/in-progress column (part 2) will sit next to. Either link them
(`StatStrip` items already support `onClick`/`href` conventions used
elsewhere in the portal — grep `StatStrip` usages) to Tiers, or drop an
inline `MetaLine` under the strip the way Artifacts does for evidence count
(ArtifactsPage.tsx:136-140), so the number's provenance is one glance away
without a page nav.

### What the process-flow graphic could honestly animate

The animation **mechanism already exists and is fully general** —
`CompactionFlowFrame.tsx`'s edge component (`CompactionFlowEdgeComp`,
lines 136-171) takes three independent signals per edge:

1. `running` (bool) → xyflow's native `animated: true` dash-flow (CompactionFlowFrame.tsx:219 `animated: e.running && !reducedMotion`) **plus** a hand-rolled `<circle>` riding the edge path via SVG `<animateMotion><mpath href="#<edgeId}"/></animateMotion>` (lines 152-158) — a moving dot, not just a dashed line.
2. `breathing` (bool) → a slower opacity pulse (`compaction-edge-breathe`, 3s keyframe, lines 232-234) for "something is off but nothing is actively running" — already used for unhealthy-tier edges.
3. `tone` → stroke color (healthy/behind/stalled/neutral, `EDGE_TONE_COLOR` line 43-48).

`prefers-reduced-motion` is respected globally (`usePrefersReducedMotion`,
lines 50-66) and short-circuits both 1 and 2 to a static stroke — this
already satisfies an accessibility bar the brief didn't ask for but would
have needed.

**The gap is entirely in the data, not the renderer.** `processFlowModel`
(distillationFormat.ts:668-768) sets **10 edges**, and only 2 of them
(`L0-L1`, `L1-L2`, via `mergeEdge()` lines 740-749) ever receive a
`running`/`breathing` value that isn't hardcoded false. The other 8 — all
4 input edges (`sessions-L0`, `bots-L0`, `sweeps-L0`, `lab-L0`) and all 4
output edges (`review-L1`, `L2-library`, `L2-promotions`, `library-session`)
— go through `plain()` (distillationFormat.ts:752-753):

```ts
const plain = (id: string, sourceId: string, target: string, label = ''): CompactionFlowEdge =>
  ({ id, source: sourceId, target, label, running: false, breathing: false, tone: 'neutral' });
```

**Every one of those 8 edges is permanently static, by construction,
regardless of real activity.** This is exactly the user's complaint. It's
a one-file fix (`distillationFormat.ts`), because the frame already knows
what to do with `running`/`breathing` per edge — no xyflow work needed.

Per-edge, the exact wire field to condition on, and what class of signal
each honestly supports (moving-dot "in flight now" vs. breathing "pressure,
not necessarily this instant"):

| edge | field that exists today | class | notes |
|---|---|---|---|
| `sessions-L0` | `IngestState.activeWriters` (`GET /api/distillation/ingest`, already fetched at `ProcessFlow.tsx:25` and unused for animation) | **running** — `activeWriters > 0` is a real "sessions writing right now" fact, not a proxy | Closest to a genuinely live signal on this page. |
| `bots-L0` | `botRunsToday` (summed `todayRunCount` from `/api/bots`, `ProcessFlow.tsx:57-59`) | **breathing only** — this is a *today* total, not a concurrency signal; treating it as `running` would overclaim | Do not use for the moving dot; a bot that ran once at 3am still reads `todayRunCount: 1`. |
| `sweeps-L0` / `lab-L0` | `findings.length` filtered by `sweep` (`/api/work/findings?status=open`, `ProcessFlow.tsx:46-48`) | **breathing only** — open-count, not "just written" | Same caveat as bots: a stale open finding from yesterday still counts. |
| `L0-L1`, `L1-L2` | `latestJobFor(level, jobs).status === 'running'` (already correct, distillationFormat.ts:743-746) | **running** | No change — this is the one edge pair already right. Note the mock job finishes in ~3s (`CompactionsPage.tsx:24-28` comment), so the moving-dot state is genuinely rare to catch live; that's a demo-realism issue, not a bug. |
| `review-L1` | `SamplingState.queueDepth` ("in queue now", `/sampling`) | **breathing** — nonzero backlog is real pressure, same semantic the tier-health breathing already uses for "behind" | Reuses an existing precedent (`breathing: !running && targetHealth != null && targetHealth !== 'healthy'`) rather than inventing a new visual language. |
| `L2-library` | needs `Artifact.updated_at` scanned for "published within window W" (field exists, `types.ts` Artifact.updated_at; the scan/threshold doesn't) | **breathing**, once added | Honest signal — "an artifact was actually published recently" — but requires a small pure helper (`hasRecentArtifact(artifacts, windowMs)`), not a new endpoint. |
| `L2-promotions` | same shape against `PromotionsResponse.candidates` — **no timestamp on a candidate today** (`ProcessFlow.tsx:16` `PromotionsResponse { candidates: Array<{status?}> }` has no `created_at`) | cannot honestly animate without a field add | Section 3/4 territory: needs `createdAt` on the promotions wire shape, from `providers/promotions.ts` / its mock, before this edge can breathe truthfully. Until then, leave static rather than fake it. |
| `library-session` | `LiveBundleResponse` (`session-bundle/live`) exposes only `skills?: unknown[]`, no timestamp | cannot honestly animate without a field add | Same conclusion — flag as a queued gap, do not fabricate. |

So: **2 edges get real `running`, 3 edges get real `breathing` with fields
that exist today, 2 edges need a small field addition before they can
honestly breathe, and none of it needs new xyflow plumbing.**

---

## 2. Real-time indicators (last activity / in progress, per table)

### The honest join key: repo, not session id

The instinct is "join a table row to `presence.sessions` by session id." It
doesn't work here — **the two domains use disjoint id spaces**:

- Distillation's `Observation.session_id` / `box_id` are synthetic mock ids
  (`sess-*`, `box-*` — `mock/distillation.ts:1564-1565`), generated
  independently of the local-compute registry.
- `local-compute-fleet.ts`'s `LocalSession.sessionId` is whatever the
  claude-mem plugin on a real laptop announces (`local-compute-fleet.ts:83-102`).

There is no FK between them today. The field both domains genuinely share is
**`repo`**: `Observation.repo` / `Cluster.repo` (types.ts) and
`LocalSession.repo` (`local-compute-fleet.ts:87`). So "how does this compare
to active/recently-active agent sessions" has to be phrased as *"which repos
this L0/L1/L2 row is about are also repos a live session is currently
touching"* — a repo-level join, not a row-level one. That's a weaker but
real and honest claim; don't build UI that implies a tighter link than
exists.

Also note the presence read itself is scoped: `GET /api/local-compute/nodes`
is **owner-scoped** ("my machines" — `local-compute.ts:654-664`,
`listNodesByOwner(session.sub)`), and the fleet-wide
`GET /api/local-compute/nodes/all` (`local-compute.ts:666-688`) deliberately
**strips session detail down to `sessionCount`** (`summarize()`,
`local-compute.ts:639-652`, comment: "never the session detail"). A page
that wants "intent / model / lastSeenAt of sessions currently touching this
repo" org-wide **cannot get it from an existing route** — that's a real gap
to name in the build plan, not paper over with `nodes/all`'s summary.

### Per-table proposal

**Overview — procedure repertoire (`OverviewPage.tsx:52-134`)**

| column | field(s) | composite | why |
|---|---|---|---|
| existing "Last proven" | `ProcedureView.last_succeeded_at` | unchanged | already relative-time |
| **new: "Repo activity"** | join `ProcedureView.repo` against live sessions' `repo` (needs a fleet-wide, non-owner-scoped repo-presence read — gap, see below) | `StatusDot` `pulse` when ≥1 live session on that repo, static dot otherwise, `label` = session count | Cheapest honest signal: not "this procedure is running," but "someone is actively in this repo right now," which is exactly the context a reader wants before trusting "proven." |
| existing "Runs" sparkline | `applied_per_day[14]` | unchanged `TrendSparkline` | already good — keep as the precedent for the rest of this table. |

**Tiers — item list (`ItemsList.tsx` under `TiersPage.tsx`)**

L0 rows are literally being minted live in the mock (`docs/distillation.md`:
"every read of levels, items or ingest mints the observations that 'landed'
since the last minute tick"). A "last write" column reading
`Observation.created_at` with `StatusDot pulse` when `age < ingest tick
window` would show the ingest simulator's own heartbeat — genuinely live,
zero new fields needed.

| column | field | composite |
|---|---|---|
| L0 rows: "Landed" | `Observation.created_at` | `StatusDot` pulse if < 60s old (matches the mock's own per-minute tick), relative-time label otherwise |
| L1 rows: "Confidence" | `Cluster.confidence` (0-1) | `DotMeter` (already the library's discrete-quantum meter, reads better than a bar for a 0-1 score with a warn threshold) |
| L2 rows via Artifacts (see below) | | |

**Artifacts (`ArtifactsPage.tsx:112-163`)**

Today's 5 columns (Artifact/Type/Status/Library/Clusters) are deliberately
narrow — the file's own comment (ArtifactsPage.tsx:92-110) documents that
Facts/Last-compaction were **removed** from columns to fix a horizontal-
scroll defect, moved into a `MetaLine` under the title instead. Respect that
constraint: a new "Activity" column must be narrow (≤90px) or it goes back
into the `MetaLine`, not a new `<th>`.

| addition | field | composite |
|---|---|---|
| `MetaLine` gains a 3rd item: "last run Nh ago" for `type==='procedure'` | `ProcedureView.last_applied_at` (via a per-row `/procedures/:id` — expensive N+1; better: bulk it, see build plan) | text, matches existing `MetaLine` items pattern (`evidenceLabel`, `updated ${relativeTime}`) |
| Status chip gains `dot="pulse"` when a review is pending against this artifact | `ReviewSample` rows where `target_kind==='artifact' && target_id===a.id && verdict==='pending'` (needs the review list, already fetchable via `/review?verdict=pending`, joined client-side) | `Chip dot="pulse"` (the library already treats `dot: 'pulse'` as the "awaiting a human" idiom — `CompactionsPage.tsx:160` uses it for `status==='running'`) |

**Compactions job table (`CompactionsPage.tsx:128-193`)**

Already close to right: `Chip dot="pulse"` on `status==='running'`
(CompactionsPage.tsx:160), and the page already fast-polls (2s) while
anything is running, backing off to 30s otherwise (`CompactionsPage.tsx:29-30,
67, 96-97`) — **this poll-adaptive pattern is the one to copy onto Artifacts
and Tiers**, which both poll at a flat cadence today (60s/20s) with no
"something's moving, poll faster" logic. The one gap: "Deduped"/"Reclaimed"
are static end-state numbers; a `running` row could show a `ProgressBar`
with `showRatio={false}` sized to elapsed-time-over-typical-duration if the
mock ever exposes an expected duration — not worth doing without that field.

### Refresh mechanism: poll vs. SSE

**No SSE exists for distillation today.** Two SSE streams exist in the repo
and neither is wired to distillation state:

- `GET /api/work/events` (`middleware/src/routes/work.ts:311-316`) relays
  `dispatcherEvents` from `job-dispatcher.ts` — this is `agent_jobs` queue
  activity (devbox job claims/completions), **not** compaction jobs.
  `compactNow()` (`providers/distillation.ts:983`) does not touch
  `job-dispatcher.ts` or `dispatcherEvents` at all — it's a separate,
  synchronous-timer mock path (`__setCompactRunMs`, `providers/
  distillation.ts:966`). Subscribing distillation pages to `/api/work/events`
  today would receive **zero relevant events**.
- `GET /api/local-compute/stream` (`local-compute.ts:690-703`) pushes
  `{ type: 'presence', node }` on every announce/heartbeat — this is real
  and owner-scoped, exactly the presence signal part 2 wants, but only for
  "my machines."

**Recommendation:** keep polling for distillation's own state (levels,
compactions, artifacts, procedures) — it's cheap, mock-driven, and
`CompactionsPage.tsx` already has the adaptive-cadence pattern to copy
elsewhere (see above) rather than introducing a new SSE channel for state
that isn't event-sourced server-side yet. **Do** subscribe to
`/api/local-compute/stream` specifically for the "live session" half of any
join (part 2's repo-presence column), since that's the one place a genuine
push channel already exists and polling it would visibly lag a laptop
going stale (90s/5min horizons, `local-compute-fleet.ts:111-112`).

---

## 3. Lineage as enterprise IP

### Why it reads "agentic" today

`LineagePage.tsx` + `LineageFrame.tsx` draw exactly
`docs/distillation.md`'s chain — `session → observation → cluster → artifact
→ library item`, with `fact`/`application` nodes threaded in
(`types.ts` `LineageNodeKind`) — as a generic xyflow graph. Every node
renders through one component (`LineageNodeComp`, `LineageFrame.tsx:83-114`)
with the same four fields regardless of kind: a `Chip` naming the kind, a
color swatch, a truncated label, and the raw id
(`LineageFrame.tsx:107-108`, deliberately shown "so a reader can still tell
nodes apart... without needing the pointer"). The `DetailPanel`
(`LineagePage.tsx:122-149`) that opens on click is just
`Object.entries(node.meta)` dumped as `KeyValue` rows — whatever the
provider happened to put in `meta`.

Nothing about that graph says "this is the org's intellectual property."
There's no owner, no confidentiality/classification, no "who is allowed to
use this," no business unit, no review sign-off with a name attached beyond
`reviewed_by` (a bare optional string on `Artifact`), and the only "quick
action" is `Focus here` (`LineagePage.tsx:143-145`) — a graph-navigation
action, not a knowledge-management one. It reads like a debugging tool for
the fleet's own internals (which is exactly what it's for structurally —
provenance/lineage), not like a catalog of enterprise assets a person
curates.

### What exists on the wire today vs. what's missing

`Artifact` (types.ts, the L2 row — the thing that becomes enterprise IP):

```ts
id, type, title, summary, body_markdown, cluster_ids[], facts[] (ids only),
library_item_id | null, status: draft|published|retired,
reviewed_by: string | null, reviewed_at: string | null,
created_by_compaction_id, created_at, updated_at
```

`LibraryAsset` (`providers/prompt-library.ts:72-105`, what it becomes once
`library_item_id` resolves):

```ts
id, name, description, kind, tier ('sandbox'|…, a RELEASE-READINESS tier,
not a sensitivity classification), roles[], tags[], ownerName: string|null,
version, lifecycleStatus, contract, evalPassRate, usedBy[] (consumer ids),
updatedAt, derivedFrom?, template, signoffs, designReviewId?
```

**Fields the brief's "enterprise asset row card" needs that genuinely don't
exist anywhere in this domain yet:**

| requested field | closest existing field | gap |
|---|---|---|
| classification (confidential/internal/public) | none — `LibraryAsset.tier` is release-readiness (`sandbox`/candidate/production-ish), not sensitivity | net-new field, `LibraryAsset` + `Artifact`, `providers/prompt-library.ts` + `providers/distillation.ts` |
| owner/steward | `LibraryAsset.ownerName: string \| null` exists; `Artifact.reviewed_by` is the closest analog on the L2 side but means "who reviewed the sample," not "who owns this artifact" | rename/add is honest here — don't conflate `reviewed_by` with ownership in the UI |
| provenance chain | fully covered by `GET /items/:id/lineage` already | **no gap** — this is the one piece already real and rich; the redesign should surface it as a compact inline chain on the row card, not just the full graph |
| last used | `LibraryAsset.usedBy: string[]` (consumer ids, no timestamp) and `LibraryAsset.updatedAt`; nothing on `Artifact` itself | need a `lastUsedAt` on `LibraryAsset` if "last used" means "last invoked," vs. `updatedAt` if it means "last edited" — these are different claims, don't merge them |
| confidence | `Fact.confidence`, `Cluster.confidence` exist per-fact/per-cluster; **no rollup confidence on `Artifact` itself** | a card-level confidence would need to be a derived min/mean of its facts — computed, not stored, matching this domain's own "no typed aggregate" rule (`mock/distillation.ts:9-18`) |
| review state | `Artifact.status` (draft/published/retired) + `reviewed_by`/`reviewed_at` are real, but describe the L1→L2 compaction's own review, not a *current* enterprise sign-off state (e.g. "up for re-cert," "flagged stale") | this is closest to already covered — reuse `status`/`reviewed_at` rather than inventing a parallel field, unless the product wants a genuinely different lifecycle |

### Redesign: each L2 artifact as a row card

Replace the flat `DataTable` with row cards (still inside `PageSection`,
still library composites — `Card` + `CardHeader` for the shell,
`MetaLine`/`KeyValue` for facts, `DropdownMenu` for actions, `Chip` for
classification/status, `StackDiagram` for the provenance chain condensed to
one line instead of a full graph). Proposed anatomy per card:

```
┌ CardHeader: title (Button→drawer, same pattern as ArtifactsPage.tsx:126-134)
│   meta: [type Chip, status Chip, classification Chip (new), confidence DotMeter]
│   action: DropdownMenu (quick actions, below)
├ summary line
├ MetaLine: owner · repo · library asset name (if published) · last used Nd ago
├ inline provenance chain (StackDiagram horizontal, 4 collapsed nodes:
│   clusters(n) → this artifact → library item → consumers(n), each a Link)
└ (expand) → same drawer body ArtifactsPage.tsx already has (body_markdown,
    facts, ProcedureSections, mini-lineage) — reuse, don't rebuild
```

**4–6 quick actions per row, wired to routes that exist today unless noted:**

| action | route | exists? |
|---|---|---|
| Open in Library | `GET /api/library/:id` → `Link to=/iq/library/:id` | yes — `ArtifactsPage.tsx:437-439` already does this in the drawer; promote it to a row-level quick action |
| Trace lineage | `/iq/distillation/lineage?focus=<id>` | yes — `ArtifactsPage.tsx:441-443` |
| Promote / publish | none | **gap.** `POST /api/promotions/:id/promote` (`promotions.ts:37`) operates on a *different* id space — promotion candidates from the cluster→pattern→skill ladder (`promotions.ts:1-3` comment), not on `Artifact.id`. There is no `PATCH /api/distillation/artifacts/:id` to move `status: draft → published`. A "Promote" quick action on this card needs a **new route** (`providers/distillation.ts` + `routes/distillation.ts`), not a reuse of promotions — naming it "Promote" beside the real Promotions inbox would also be actively confusing; call it "Publish" to match `ArtifactStatus`'s own vocabulary. |
| Request review | none | **gap**, related to the above: `POST /review/:id` (`routes/distillation.ts:181-190`) only **decides** a sample already in the queue (`verdict: agree\|disagree`); there's no "add this artifact to the review queue" route. Needs a new `POST /api/distillation/review` (create) or a `sampleForReview(artifactId)` provider function. |
| Pin to Enterprise doc | none found | **gap**, and no existing "Enterprise doc" concept was found anywhere in `middleware/src/routes/` — grep for `enterprise` / `knowledge-doc` came back empty in the surfaces read. This action needs a target surface to exist first; do not build the button before the destination does. |
| Export | none | **gap** — no export route in this domain; likely a client-side `body_markdown` download (no middleware change) rather than a real gap, unless "export" means "push to an external doc system," which is the Pin action's problem again. |

So of the 4-6 requested actions, **2 are real today (Open in Library, Trace
lineage)**, **2 are a small, well-scoped route addition each (Publish,
Request review)**, and **2 depend on a destination surface that doesn't
exist in this codebase yet (Pin to Enterprise doc, Export-to-system)** —
Export alone is doable now as a client-side download.

---

## 4. Sequenced build plan

Each slice is sized for one Sonnet fix-agent pass: touches a bounded file
set, has its own validator/test check, and leaves the mock-floor contract
intact (fixtures export rows + selectors; every timestamp read through
`mock/core/clock.ts`'s `clock`, never `Date.now()` at module scope — the
rule `mock/distillation.ts:19-22` already states and that this plan must not
violate). `scripts/validate-distillation.sh` stays the judge after each
slice, per `docs/distillation-goal.md`'s "Rules that do not bend."

**Slice 1 — Honest edge activity on the process flow (data only, no new UI)**
- Files: `portal/src/pages/distillation/distillationFormat.ts`
  (`processFlowModel`, lines 668-768) only.
- Work: replace `plain()` calls for `sessions-L0` with a `running` derived
  from `input.activeWriters > 0`; replace `bots-L0`/`sweeps-L0`/`lab-L0`
  with `breathing` derived from their existing counts > 0; add `breathing`
  to `review-L1` from a new `queueDepth` input (thread `SamplingState.
  queueDepth` through `ProcessFlow.tsx`'s existing `/sampling` fetch, which
  today only reads `reviewedLast30d` — one extra destructured field, no new
  fetch). Leave `L2-library`/`L2-promotions`/`library-session` static and
  add a code comment naming the missing timestamp fields (from part 1) so
  the next agent doesn't silently invent one.
- Also touches `ProcessFlow.tsx` (thread `queueDepth` into the `model`
  memo's dependency array and `processFlowModel` call).
- Re-observe: `docs/distillation-journeys/{member,org-leader}/overview.md`.

**Slice 2 — Poll-adaptive cadence + last-activity column on Tiers and
Artifacts (copy the Compactions pattern)**
- Files: `portal/src/pages/distillation/TiersPage.tsx`,
  `portal/src/pages/distillation/ItemsList.tsx`,
  `portal/src/pages/distillation/ArtifactsPage.tsx`,
  `portal/src/pages/distillation/distillationFormat.ts` (a small pure
  `isRecentlyLanded(iso, nowMs, windowMs)` helper, tested).
- Work: L0 rows in `ItemsList.tsx` get a "Landed" cell —
  `StatusDot pulse` when `Observation.created_at` is inside the mock's
  ingest-tick window (60s, per `docs/distillation.md`'s ingest simulator
  note), relative-time label otherwise. Artifacts' `MetaLine` gains a
  `Chip dot="pulse"` on the Status chip when the artifact has a pending
  `ReviewSample` (needs the `/review?verdict=pending` list fetched once and
  joined client-side by `target_id`, same shape as `ProcessFlow.tsx`'s
  existing multi-fetch-then-derive pattern). Copy `CompactionsPage.tsx`'s
  `IDLE_POLL_MS`/`RUNNING_POLL_MS` pattern (lines 29-30, 67, 96-97) onto
  both pages' `useFetch` calls.
- Re-observe: `docs/distillation-journeys/{member,org-leader}/{tiers,artifacts}.md`.

**Slice 3 — Middleware: artifact-as-enterprise-asset fields + Publish/
Request-review routes**
- Files: `middleware/src/mock/distillation.ts` (add `owner`,
  `classification: 'internal'|'confidential'|'public'`, `last_used_at` to
  the `Artifact` fixture rows and its `defineFixture` selector — additive,
  keeps existing rows valid), `middleware/src/providers/distillation.ts`
  (extend `Artifact`/`ArtifactView` type, add `publishArtifact(id, by)` and
  `sampleForReview(kind, id, by)` provider functions with the same
  "counted, not stored" discipline the file already follows),
  `middleware/src/routes/distillation.ts` (new `POST
  /artifacts/:id/publish` and `POST /review` under the existing
  `manageGate`), `portal/src/pages/distillation/types.ts` (extend
  `Artifact`, add the two response types).
- Tests: one route test per new endpoint (`middleware/src/routes/
  __tests__/distillation-routes.test.ts` or wherever the existing suite
  lives — the validator lists untested paths per the goal doc).
- No portal UI yet — this slice only stands up the contract the row cards
  in Slice 4 will call.

**Slice 4 — Lineage page → enterprise asset row cards**
- Files: `portal/src/pages/distillation/LineagePage.tsx` (the no-focus
  picker view, lines 61-100, becomes the row-card list), a new
  `portal/src/pages/distillation/ArtifactAssetCard.tsx` (Card + CardHeader +
  MetaLine + DropdownMenu + Chip, composed from library primitives only —
  no new `*Frame.tsx`, this is not an xyflow surface), reuse
  `ArtifactDrawerBody` from `ArtifactsPage.tsx` for the expand/drawer rather
  than duplicating it (consider extracting it to a shared file if both pages
  need it — that's an in-slice call, not a new slice).
- Quick actions wired: Open in Library (existing), Trace lineage
  (existing), Publish (Slice 3's route), Request review (Slice 3's route),
  Export (client-side `body_markdown` blob download, no middleware). Pin to
  Enterprise doc stays out of scope — no destination surface exists (part 3).
- Re-observe: `docs/distillation-journeys/{member,org-leader}/lineage.md`,
  and re-check `artifacts.md` since the drawer body is now shared.

**Slice 5 — Repo-level live-session join (if pursued)**
- Files: `middleware/src/routes/local-compute.ts` (a new, deliberately
  **redacted** fleet-wide-by-repo read — counts and repos only, same
  posture as today's `nodes/all` "never the session detail" rule, e.g.
  `GET /api/local-compute/presence-by-repo` → `{ repo, liveSessionCount
  }[]`), `portal/src/pages/distillation/OverviewPage.tsx` (procedure
  table's new "Repo activity" column), `portal/src/pages/distillation/
  TiersPage.tsx`/`ItemsList.tsx` (optional second use).
- This is its own slice because it's the one change that touches a router
  (`local-compute.ts`) outside `routes/distillation.ts`'s existing single-
  owner file (`docs/distillation-goal.md`'s "one owner per shared file"
  rule) — keep it isolated so a merge conflict there doesn't block Slices
  1-4.
- Re-observe: overview.md again (new column), plus a fresh
  `docs/distillation-journeys/*/tiers.md` if Slice 5 touches Tiers too.

Each slice ends with `scripts/validate-distillation.sh` and the relevant
journey re-audit per `docs/distillation-goal.md`'s backlog item 7 protocol
(role `member`=u-theo, role `org-leader`=u-vera, sign in via `/select` →
Sign in as, console errors 0, `first-row-top` ≤ 640px where applicable).
