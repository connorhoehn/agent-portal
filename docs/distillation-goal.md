# Goal: make `/iq/distillation` a product, not a dashboard with a scroll cliff

`scripts/validate-distillation.sh` is the only judge. Work the backlog below
in order, run the script after every slice, and treat each failing line as
the next task. No `npm install` anywhere (offline). No hand-rolled HTML in
pages — ui-components composites; a missing primitive is composed ONCE in a
local `*Frame.tsx` and queued in `docs/ui-components-queue.md` ("Composed
locally in `<file>`" is what exempts it). Build to the middleware's response
shapes — the mock is the contract; a page never invents a key.

## Status (2026-09-24) — IA redesign

The six-page `SubNavLayout` section was replaced by three destinations —
**Knowledge / Review / Activity** — per `docs/distillation-redesign-spec.md`
and the IA doc it cites. The portal half (workstream P) is built: one
`ScopeHeader` frame, explorer · record · Sources for Knowledge and Review,
runs / tier graph · run inspector for Activity, legacy routes redirected
with selection kept. The retired pages (Overview, Tiers, Artifacts, Lineage,
Compactions, the old Review sample) and their xyflow frames are deleted;
both graphs are the library's `TypedNodeCanvas`. The validator's IA section
and journey surfaces were rewritten for this structure; the six journey
logs (member + org-leader × knowledge / review / activity) are the open
item — they need a browser walk. The status entries below are the history
of the pre-redesign section.

## Status (2026-09-05 15:45)

Compaction flow shipped (user request 15:00): xyflow tier ladder on
Compactions, 200px, `first-row-top` 554px. Round 4 caught two presentation
bugs (52px edges hidden under their labels; labels on the cards) and a dead
mouse click; root cause of all three was the frame rebuilding xyflow's node
array on every render, so nodes were never measured (hidden, edge-less,
unclickable). Fixed by memoising nodes/edges on the model (a first attempt
placed the hooks after the early returns and white-screened the page — the
rules-of-hooks error was caught live and corrected). Verified with a
physical click: 4 visible nodes, 3 edges (186/186/192px), fitView applied,
L1 → `/iq/distillation/tiers?level=L1`, 0 console errors. Re-log of
Compactions for both roles in flight.

Follow-up shipped (16:25): `components/shell/RouteErrorBoundary.tsx` wraps
every routed page (`Page` in `App.tsx`, keyed on the location so navigating
away resets it) — a page throw now shows the library's ErrorState with a
"Try again" inside the shell instead of blanking the app, as the
`/api/health` shape drift and the hooks regression both did today.

## Status (2026-09-05 14:30)

Round-2 audit: 10 of 12 pass; Artifacts fails on an unbounded title column
(fix in flight), Lineage's record panel sits below a wheel-capturing graph
(moving beside it, in flight), Compact had no running state (fixed:
running → succeeded after 3s, produced at completion; middleware 112 suites /
1703 tests). The user's density rule landed (see below); Tiers is one
selector row now. Next: targeted re-audit of tiers/artifacts/lineage/
compactions with `first-row-top`, freshness sweep, full validator.

## Status (2026-09-05 13:40)

Backlog items 1–6 and 8 shipped; the validator passes every line except the
journey audit. Round-1 audit (u-theo member, u-rachel/u-vera org-leader): 10
of 12 surfaces pass; Tiers fails for both roles — tier cards promised
950/180/40 items above lists of 69/22/8 (fixed: counts derive from the
corpus, and compaction now produces real clusters/artifacts), and Tiers had
no filter or search (fix in flight); Artifacts needs its own horizontal
scroll at 1440 (fix in flight); a `/api/health` shape drift white-screened
the shell (guarded); `SubNavLayout`'s second `<main>` queued as a library
gap; Vera Green added to the curated Sign-in roster. Next: re-audit Tiers,
Artifacts and Compactions, then the freshness sweep.

## What is wrong today (UX persona: an SME who just ran a lab session)

Open `/iq/distillation` (screenshot 2026-09-05 07:45). The top is a memory
pipeline dashboard: L0/L1/L2 tier cards, health banners, ingest pressure.
Scroll once and you are on a different page — a compaction job ledger with
its own filter bar and a ten-column table — with nothing to say the two
belong together. One `<h1>`, zero links on the whole page (`main a[href]` →
`[]`), no sub-navigation, although the shell already has a nested vertical
nav composite (`SubNavLayout`) that Observability, Ingest, Identity and
Admin all use.

Worse than the layout: the feature does not answer the only question a
person has. "L2 artifacts — stable distilled artifacts (runbooks, insights)
that feed the library" is a **number** (40). You cannot see one artifact,
cannot see which runbook or skill in the Library it became, cannot see which
sessions and observations it was distilled from, and cannot check a distilled
fact against its evidence. The middleware confirms it: `providers/distillation.ts`
models `LevelState`, `IngestState`, `CompactionJob`, `SamplingState` — there
is no item, no artifact, no fact, no lineage anywhere in the domain. The
review sample ("4% what humans review", "214 reviewed in 30d, 6 in queue")
has no queue a human can open.

So: distillation must become navigable knowledge with provenance, and the
page must become a section with a rail.

## Information architecture (the contract for the portal)

Superseded 2026-09-24 by `docs/distillation-redesign-spec.md` §1. In short:
`/iq/distillation` mounts `DistillationModule` — a flush `ViewportFillRegion`
holding a vertical `SubNavLayout` rail (groups **Knowledge** — Guides &
findings / Patterns / Run notes; **Review** — Pending N / Reviewed N;
**Activity** — Runs, tinted when a tier is behind or stalled / Tier graph)
beside a `ScopeHeader` (destination title, repository selector in `controls`,
"Open Library ↗").

| tab | route | surface |
|---|---|---|
| Knowledge | `knowledge?view=guides\|patterns\|notes&item=&panel=sources&sourceView=list\|graph&repo&initiative&q&kind&lifecycle` | `ExplorerLayout` rail (view-scoped `SearchInput`, view `Select` with tier counts, `FilterPopover` + `WorkListFilters` over `GET /facets`, `GroupedList`, "N of M loaded" + cursor Load more) · `EditorShell` record (Content \| History, + Runs for a procedure; Sources N and Open in Library ↗) · `ContextColumn` Sources (`SourceList` \| `TypedNodeCanvas`) · docked explain-only `RichChatComposer` |
| Review | `review?tab=pending\|decided&sample=&panel=sources&repo` | `Tabs` + `SearchInput` + `GroupedList` queue (resolved target titles; unresolvable targets say so with Retry) · `EditorShell` claim (Agree / Disagree for `ManageBots`, `AccessNotice` otherwise; Earlier reviews and Sampling details disclosures) · Sources |
| Activity | `activity?view=runs\|graph&run=&repo&level&status` | `StatStrip` tier flow with Compact / Compact / Publish connectors · health `Banner` · `SegmentedControl` Runs \| Tier graph inside `CanvasPaneLayout` · run inspector (`DetailHeader`, `KeyValue`, Produced `LinkedItemsSection`, `Disclosure` inputs / `LogStream` run log, `TechnicalDetails`) · Compact buttons for `ManageBots` · replica status |

Legacy routes redirect with selection and filters kept
(`distillationRoutes.migrateDistillationUrl`): the root and `/overview` →
Knowledge; `/tiers?level=` → the matching view; `/artifacts?open=` and
`/lineage?focus=` → that record (Sources → Graph for lineage); `/compactions`
→ Activity. The palette has one entry per destination; the shell rail
targets Knowledge.

## Domain model (the contract for the middleware — mock = truth)

L0 observations are `lab_experiences` (`schema/lab_loop_schema.sql`): the
fleet's raw learnings, one per session write. L1 and L2 are new, additive:

```
Observation (L0)  id · session_id · box_id · repo · initiative_id
                  · kind worked|failed|gotcha|decision|convention
                  · title · body · tags[] · created_at
Cluster (L1)      id · title · summary · kind · repo · initiative_id · tags[]
                  · member_observation_ids[] · confidence 0–1
                  · created_by_compaction_id · created_at · updated_at
Artifact (L2)     id · type runbook|insight|convention|decision|procedure
                  · title · summary · body_markdown
                  · cluster_ids[] · facts[] · library_item_id | null
                  · status draft|published|retired
                  · reviewed_by · reviewed_at · created_by_compaction_id
                  · created_at · updated_at
Fact              id · artifact_id · statement · subject · predicate · object
                  · evidence_observation_ids[] · confidence
                  · ordinal | null   (1-based step position within a procedure; contiguous 1..n)
ProcedureApplication
                  id · procedure_id · session_id · box_id · repo · applied_at
                  · outcome succeeded|failed|abandoned · failed_at_step_id | null · note | null
                  (stored as rows; runs, success share, last proven and drift are COUNTED)
ProcedureView     artifact · repo · step_count · runs{total,succeeded,failed,abandoned}
                  · last_applied_at · last_succeeded_at · applied_per_day[14]
                  · drift{new_gotcha_clusters, failed_runs} · health{status proven|drifting|unproven, reason}
ReviewSample      id · target_kind cluster|artifact · target_id · sampled_at
                  · reviewer | null · verdict pending|agree|disagree · note
Lineage           { nodes: {id, kind: observation|session|cluster|artifact|fact|library_item|application, label, meta}[],
                    edges: {from, to, relation: written_by|merged_into|distilled_into|supports|published_as|applied_in}[] }
```

Routes (all under `/api/distillation`, existing five stay as they are):

```
GET  /items?level=L0|L1|L2&repo=&initiative=&q=&limit=&cursor=   → { items, next_cursor }
GET  /items/:id                                                   → the item (kind-discriminated)
GET  /items/:id/lineage?depth=                                     → Lineage
GET  /artifacts?status=&type=&q=                                   → { artifacts }
GET  /facts/:id/lineage                                            → Lineage
GET  /review?verdict=pending|agree|disagree                        → { samples }
POST /review/:id            { verdict, note }   ManageBots gate    → the sample
GET  /library/:libraryItemId/provenance                            → { artifact, lineage } (or 404)
GET  /procedures                                                   → { procedures: ProcedureView[] } drifting → unproven → proven
GET  /procedures/:id                                               → ProcedureView (404 unless the artifact is a procedure)
GET  /procedures/:id/applications                                  → { applications } newest first
POST /procedures/:id/apply  { outcome, failed_at_step_id?, note }  ManageBots gate → 201 the application
```

A `procedure` is minted by the L1 → L2 pass only when the chunk pairs a
trigger (`failed`|`gotcha`) with an outcome (`worked`|`decision`) and has ≥ 2
action-shaped members to order (`isProceduralChunk`, unit-tested);
`ARTIFACT_TYPE_FOR_KIND` stays total over the five observation kinds. Health
is a pure rule over counted rows (`procedureHealth`): no succeeded run →
unproven; a failed/abandoned run, a new `failed`/`gotcha` cluster in the
repo, or a success older than 14 days since the last success → drifting;
otherwise proven. The Overview shows the repertoire ("What the fleet knows
how to do") and a "Proven procedures" tile; the artifact drawer shows steps
toned by the latest run and the run ledger.

Every artifact with `library_item_id` links to a REAL Library item
(`GET /api/library/:id` must 200 for it); the Library detail page shows a
"Distilled from" section from `/provenance`. A compaction job gains
`produced: { cluster_ids[], artifact_ids[] }` so a job row can open what it
made. Mock data: ≥ 60 observations across ≥ 6 sessions and 3 repos, ≥ 18
clusters, ≥ 8 artifacts (≥ 5 linked to Library runbooks/skills that exist in
the Library mock, ≥ 2 drafts, 1 retired), ≥ 3 of them procedures with ≥ 3
steps each and one in each health state, ≥ 12 facts with evidence, ≥ 5
procedure applications, ≥ 6 pending review samples and ≥ 20 decided ones — enough that every page has a
real list, a real empty filter, and a real error state to exercise.
`schema/distillation_schema.sql`: additive DDL for clusters, artifacts,
facts, review samples (FK to `lab_experiences` where it applies), registered
in `schema/load_schema.py`. Aurora path optional; mock path mandatory.

## Backlog, in order

1. **Middleware domain** — types, mock, provider (mock path), routes with
   validation (ids, enums, pagination), tests for every route (the validator
   lists untested paths), `produced` on compaction jobs, Library provenance.
2. **Portal IA** — `DistillationLayout` on `SubNavLayout`, six routed pages,
   redirect, breadcrumbs, palette entries, the old page split so nothing is
   lost: Overview keeps the stats/health/sampling, Compactions keeps the
   table + Compact buttons (still `ManageBots`-gated).
3. **Artifacts + drawer** — `DataTable` with type/status chips, Library link
   (`/iq/library/:id`, a real `Link`), evidence counts; detail drawer: body
   markdown, facts with evidence pills, "Distilled from" mini-lineage, "Open
   in Library", "Open lineage".
4. **Lineage graph** — `@xyflow/react` on a `LineageFrame.tsx` (queued
   composite): typed nodes (colour + icon per kind, the library's `NodeCard`
   inside), labelled edges, fit-to-view, click a node → side panel with its
   record and "focus here"; `?focus=` deep link; keyboard: Tab through
   nodes, Enter focuses, Esc clears.
5. **Review sample** — queue with target, evidence, agree/disagree + note,
   optimistic update, capability-gated (hidden when not `ManageBots`), the
   calibration verdict explained inline.
6. **Library back-links** — Library item detail shows "Distilled from" with
   the artifact and a lineage link; the artifact shows "Published as".
7. **Journey audit** — `docs/distillation-journeys/<role>/<surface>.md` +
   screenshot for roles `member` (u-theo) and `org-leader` (u-vera), three
   surfaces each since the 2026-09-24 redesign (`knowledge`, `review`,
   `activity`; the IA doc's acceptance journeys 1–5 walk across them), protocol as in `docs/assessment-journeys/PROTOCOL.md`
   (console errors 0, layout numbers, keyboard, empty/error state, gating).
   Sign in as the REAL users via /select → Sign in as. Then a defects file
   per role and the fix → re-audit loop until every log passes.
8. **Docs** — `docs/distillation.md`: what the tiers mean, what a compaction
   does, how an artifact reaches the Library, how to read lineage; update
   `CLAUDE.md`'s architecture line for the middleware if the domain grows a
   schema file.

## Density rule (added 13:40 after the user's review of Tiers)

A list page's list is the page. On knowledge, review and activity (before
2026-09-24: tiers, artifacts, compactions and review) the first data row must sit above the fold at the audit width
(`first-row-top` ≤ 640px, recorded in every journey log and enforced by the
validator). Selectors and filters share one compact row (segmented control
+ selects + search); a description is one line; cards are only for things
that are themselves content. Three stacked status cards above a table — what
Tiers shipped with — is the anti-pattern.

## Rules that do not bend

- The validator is the judge; a green claim it does not confirm is false.
- No `npm install`. No hand-rolled HTML in pages. Mock is the contract.
- Guard on shape, not presence. Report real numbers from real commands.
- One owner per shared file (`App.tsx`, `Layout.tsx`, `portalCommands.ts`,
  `routes/distillation.ts`, `providers/distillation.ts`).
