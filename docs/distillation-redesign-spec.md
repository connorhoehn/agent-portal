# Distillation redesign — build spec (2026-09-24)

Source design: `distillation-information-architecture.md` (Knowledge / Review /
Activity) and its three mockups, plus the Overview mockup's tier-flow strip,
attention banner and procedure Runs tab where they fit. Backend: Aurora stays
the source of truth; **message-queue** runs compaction jobs, **realtime-modules**
pushes live updates to the page, **distributed-core** provides per-tier Merkle
digests and anti-entropy for a replicated L2 read cache. Every UI region is a
ui-components composite; missing primitives ship to the library first.

This spec is the contract between three workstreams: **L** (library),
**B** (middleware + schema), **P** (portal). Names below are binding.

---

## 1. Information architecture

Destinations (horizontal tabs in one module header; no second rail):

| Tab | Route | Default surface |
|---|---|---|
| Knowledge | `/iq/distillation/knowledge?view=guides\|patterns\|notes&item=<id>&panel=sources&sourceView=list\|graph&repo&initiative&q` | explorer · record · optional Sources |
| Review 7 | `/iq/distillation/review?tab=pending\|decided&sample=<id>&panel=sources&sourceView=…` | queue · claim · Sources |
| Activity • | `/iq/distillation/activity?view=runs\|graph&run=<id>&repo` | runs or tier graph · run inspector |

The header shows: title "Distillation", the three tabs (Review carries the
pending count; Activity carries a warning dot when any tier is behind or
stalled), a repository selector, and "Open Library ↗". Counts come from live
data, never literals.

**Knowledge** — explorer column: search (scoped to the current view, and says
so), view selector "Guides & findings 11 / Patterns 22 / Run notes 304",
filter popover (repo, initiative, type/kind, lifecycle), a grouped list
("Recently updated", …) of icon + title + quiet line (type · lifecycle · age),
cursor **Load more** in the footer with "N of M loaded" (M only when the server
reports a total). Record pane: crumbs (view / type), title, status + updated
line, tabs **Content | History** (+ **Runs** for procedures), header actions
**Sources N** (opens the inspector) and **Open in Library ↗** (only when linked).
Content renders once:
- guide/finding: markdown body, then **What the source run found** (the
  cluster claim), then collapsible **Technical details** (ids, versions,
  timestamps, classification).
- procedure: ordered steps once, each with its latest outcome marker when runs
  exist; the Overview mockup's **Runs** tab = latest-run callout ("Latest run
  stopped at step 3 — <note>"), step list with ✓ / ! / ○, run history list,
  and "Record a run" for `ManageBots`.
- pattern (L1): the concrete claim, confidence, member notes list.
- run note (L0): session, repo, time, kind (gotcha/worked/failed), body.
Sources inspector: **List** (default; source cards with kind icon, title,
age, excerpt, open) and **Graph** (the item's actual lineage, list equivalent
kept); following a source opens that record in Knowledge and Back returns.
Docked agent composer at the bottom of the record pane, context chip = the
record, Agent mode only explains (no writes).

**Review** — queue column: tabs Pending N / Reviewed, search, rows with the
**resolved target title**, type, source count, sampled age (never a bare
`cl-022`; unresolvable targets say so with Retry). Claim pane: crumbs
Review / <type>, title, "From <repo> · Sampled 3 hours ago", status; the
question **Does this match the source run?**, the claim, "View proposed guide →"
when an L2 exists; **Your review** textarea; Agree / Disagree (ManageBots)
with "This records your review; it does not publish the guide."; read-only
roles get an AccessNotice instead of buttons; **Earlier reviews** disclosure;
**Sampling details** disclosure (rate, agreement — replaces the full-width
banner). After a verdict: counts update, the next pending sample opens, the
decided one appears under Reviewed; failure rolls back.

**Activity** — view switch **Runs | Tier graph** (scope and selected run
preserved). Status line near the top: the single most important problem
("Guide updates delayed · Last run 12h ago · View runs →"), sourced from health
— never inferred from "last completed" alone. Also the Overview mockup's
**tier-flow strip** (L0 N → Compact → L1 N "50m behind" → Compact → L2 N
"Stalled" → Publish → Library N linked) above both views.
Runs: compact rows (transformation, status, started, inputs → outputs).
Tier graph: three storage tiers + Library, edges Compact/Compact/Publish,
job markers on edges (animated only for confirmed running jobs), zoom controls,
list equivalent; clicking a tier opens its Knowledge view; clicking a marker
selects that job. Run inspector: status + time, Input / Output / Duration /
Cost key-values, What changed, Produced (links into Knowledge), Inputs N,
Run log, Technical details. "Compact L0→L1 / L1→L2" for ManageBots.

**Migration** (old links keep working, selection preserved):
`/iq/distillation` and `/overview` → knowledge (guides); `/tiers?level=L0|L1|L2`
→ knowledge `view=notes|patterns|guides` (+repo/initiative/q); `/artifacts?open=X`
→ knowledge `item=X`; `/lineage?focus=X` → knowledge `item=X&panel=sources&sourceView=graph`
(no focus → knowledge with a prompt to choose an item); `/compactions` →
activity runs (`?view=graph` honoured); `/review?tab=` → review. Update
breadcrumbs, palette entries, the shell rail target, and every in-app link
(`LibraryPage`, `DistillationProvenance`, Overview-era links).

## 2. Library workstream (L) — ui-components, one minor release

Ship on top of the library's current `main` (another session releases often:
rebase, rebuild `dist` once, snapshot exports). Each with tests + a story.
1. `ProcedureSteps` — `steps: {id, title, body?, status?: 'done'|'failed'|'pending'|'skipped', note?}[]`, `numbered?`, `size?: 'sm'|'md'`, `onSelectStep?`. Ordered list, numeric or ✓/!/○ markers, note under a step.
2. `KeyValue` — `items: {label, value: ReactNode, mono?, title?}[]`, `layout: 'stack'|'row'|'grid'`, `labelWidth?`. (Upstream of `portal/src/components/KeyValue.tsx`; closes queue row 57.)
3. `TypedNodeCanvas` (xyflow, `/graph`) — `nodes {id, kind, data, rank?, x?, y?}`, `edges {id, from, to, label?, tone?, animated?, marker?}`, `renderNode(node)`, `layout: 'ltr'|'manual'`, `onSelectNode`, `onSelectEdge`, `selectedId`, reduced-motion aware, `listFallback` rendering; plus standalone `CanvasZoomControls` (`zoom`, `onZoomIn`, `onZoomOut`, `onFit`). Closes queue rows 23/26/32.
4. `StatStrip` additive — `connectors?: {label, tone?}[]` drawn between items (arrows with a label), `StatStripItem.status?: {label, tone}` line, `title?` (queue row 39).
5. `ScopeHeader` additive — `tabs[].dot?: 'warning'|'danger'|'info'|true`, `controls?: ReactNode` slot (repo selector) beside the link.
6. `SourceCard` — `{id, title, kind?, timestamp?, excerpt?, onOpen?, href?, current?}` row for evidence/sources lists (`SourceList` wrapper with `items`, `emptyLabel`).
7. `MarkdownView` additive `scale?: 'sm'|'md'|'lg'` (queue row 43).
Also bump the portal pin to HEAD to get `CanvasPaneLayout` (2.387.10).

## 3. Backend workstream (B) — middleware + schema

### 3a. API additions (mock + Aurora-shaped providers, tests, mock-floor)
- `GET /api/distillation/items` → add `total` (per the filtered query) and keep `next_cursor`. `GET /api/distillation/facets?level` → `{repos:[{value,label,count}], initiatives:[…], kinds:[…]}`.
- `GET /api/distillation/levels` → each tier adds `writers` (distinct sessions writing in the last hour for L0), `backlog` (items waiting for the next pass), `lastCompletedAt` for its inbound edge, `digest` (Merkle root, see 3c), and `health {state: 'ok'|'behind'|'stalled', reason, lagSeconds}`.
- `GET /api/distillation/compactions` / `:id` → each job adds `input_ids`, `output_ids`, `log: {at, level, message}[]`, `what_changed` (one sentence), `duration_ms`, `cost_usd`.
- `GET /api/distillation/review` → each sample adds `target {id, kind, title, repo, source_count}` (server join; `null` + `target_error` when unresolvable).
- `GET /api/distillation/items/:id/sources` → `{sources:[{id, kind, title, timestamp, excerpt, session_id?, repo?}]}` (direct evidence of the item: L2→clusters+notes, L1→member notes, L0→its session).
- `GET /api/distillation/sessions/:id` → the run-note session record (repo, started, notes).
- `GET /api/distillation/procedures/:id/runs` → applications with per-step outcomes `steps:[{step_id, status:'done'|'failed'|'pending'|'skipped'}]`, `note`, `at`, `actor`.
- Keep every existing route and gate (`requireSession('ViewDistillation')` reads, `ManageBots` writes).

### 3b. message-queue — compaction jobs
- Queues `distill-compact-l1`, `distill-compact-l2` (FIFO, `message_group_id = repo`), DLQ via `redrive_policy`. A small signed client (`send/receive/ack`) in `middleware/src/lib/mq-client.ts` over `${MESSAGE_QUEUE_URL}` with `X-Service-Auth` (service-runtime headers) — and upstream it to message-queue as an exported client if the repo accepts it.
- `POST /compact` enqueues and returns the job (status `queued` → `running` → `succeeded|failed`); a consumer loop (in the middleware) claims, runs the pass, acks; idempotency key = job id so a redelivery no-ops. A scheduler re-enqueues passes on a cadence.
- Offline/mock: `MOCK_QUEUE=true` (on under `dev:mock`) uses an in-process `QueueService` from the message-queue package if importable, else an in-memory queue with the same `send/receive/ack/visibility/DLQ` semantics behind the same interface. Registered in `mock/core/contract.ts` so reset clears it.

### 3c. distributed-core — digests and anti-entropy
- Per-tier `MerkleTree` over `(id, updated_at)` of that tier's rows → `levels[].digest`. Changes when and only when the tier's content changes.
- An L2 read replica: `KVStore<artifactId, ArtifactRow>` (`MemoryKVStore`) fed from the source of truth, kept in step by `MerkleSyncer` (in-process `fetchSubtree/fetchValues` against the primary); LWW on `updated_at` via `HLCRegister`. `GET /api/distillation/replication` → `{replicas:[{id, digest, lagMs, lastSync, repaired}], inSync}`; the Activity page shows "replicas in sync" or the drift.
- Import from `distributed-core` subpaths (`/replication`, `/persistence`, `/crdt-primitives`); add the direct dependency (pinned by full sha, matching realtime-modules' transitive version or newer) — verify against `dist`, not source.

### 3d. realtime-modules — live channel
- `attachRealtime(server, { features, authorize })` in `middleware/src/index.ts` replacing `rejectUnsupportedUpgrades` **only for the realtime path**; `authorize` reads the signed session cookie and requires an orgiq session with ViewDistillation. Keep other upgrade paths rejected.
- Channels (server push via `handle.router.sendToChannel`):
  - `distill:levels` → `{type:'levels', levels}` on every L0 write, job transition and replica sync.
  - `distill:jobs` → `{type:'job', job}` on each job state/progress change (`phase`, `percent`, `stepLabel`).
  - `distill:review` → `{type:'review', pending, decided}` after any sample change.
- Mock: the in-process router needs no infra, so the channel works under `dev:mock`.

### 3e. Schema
Add `distillation_compactions` (job rows incl. input/output ids, log, cost, duration, status) and `distillation_ingest_writers`, register in `load_schema.py`; providers keep the mock path and gain an Aurora path shaped by the same types.

## 4. Portal workstream (P)

- One module frame: `ScopeHeader` (tabs + dot + repo `controls` + Library link) over `ViewportFillRegion`, flush (`data-shell-flush`), no `SubNavLayout`.
- Knowledge: `ExplorerLayout` rail (`SearchInput`, view `Select`, filter popover via `WorkListFilters`, `GroupedList` rows with `FileKindMark`/icon, footer Load more + counts) · `EditorShell` record (`MarkdownView scale`, `ProcedureSteps`, `TechnicalDetails`, `KeyValue`, tabs) · `ContextColumn` Sources (`SegmentedControl` List/Graph, `SourceList`, `TypedNodeCanvas` lineage) · `RichChatComposer` footer.
- Review: `Tabs` + `SearchInput` + `GroupedList` queue · `EditorShell` claim (`OutcomeSection` note, Buttons, `AccessNotice`, `Disclosure` + `CommentList` earlier reviews, `Disclosure` + `StatStrip` sampling) · Sources as in Knowledge.
- Activity: `StatStrip` tier flow (connectors + status) · `Banner` status line · `SegmentedControl` Runs/Tier graph · runs `GroupedList`/`DataTable` · `TypedNodeCanvas` + `CanvasZoomControls` tier graph in `CanvasPaneLayout` · run inspector (`DetailHeader`, `StatusPill`, `KeyValue`, `DetailSection`, `LinkedItemsSection` produced, `Disclosure` + `LogStream` run log, `TechnicalDetails`).
- Live data: `useDistillationChannel(channel)` over `useGateway().subscribe/onMessage` (the `useCapability` push-over-REST pattern): REST snapshot via `useFetch`, channel frames patch it; falls back to polling when the gateway is offline. Point `VITE_GATEWAY_URL` at the middleware's realtime path in `.env.local` docs.
- Routes + redirects per §1, breadcrumbs, palette, rail, in-app links.
- Pure model files (no React) with node:test coverage: route migration mapping, tier-flow model, review queue model, sources model, procedure run → step statuses.

## 5. Acceptance (from the IA doc) and judges

Journeys 1–5 of the IA doc must work on `dev:mock`. Judges:
`scripts/validate-distillation.sh` (update its IA section and journey surfaces
deliberately to knowledge/review/activity; journeys re-walked as member and
org-leader), `validate-mock-floor.sh`, `validate-route-coverage.sh` (no new
uncovered routes), `validate-honest-numbers.sh`, `validate-nav-parity.sh`,
`validate-component-discipline.sh`, portal `tsc` + tests + `vite build`,
middleware `tsc` + jest, and the library's full suite for L.
