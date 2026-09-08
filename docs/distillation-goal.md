# Goal: make `/iq/distillation` a product, not a dashboard with a scroll cliff

`scripts/validate-distillation.sh` is the only judge. Work the backlog below
in order, run the script after every slice, and treat each failing line as
the next task. No `npm install` anywhere (offline). No hand-rolled HTML in
pages — ui-components composites; a missing primitive is composed ONCE in a
local `*Frame.tsx` and queued in `docs/ui-components-queue.md` ("Composed
locally in `<file>`" is what exempts it). Build to the middleware's response
shapes — the mock is the contract; a page never invents a key.

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

`/iq/distillation` mounts `DistillationLayout` → `SubNavLayout` (the same
composite `ObservabilityLayout` uses), groups and items:

| group | path | label | what it is |
|---|---|---|---|
| Memory | `overview` | Overview | the stat strip + tier health + ingest pressure + sampling verdict (today's top of page, nothing else) |
| Memory | `tiers` | Tiers | the three level cards; each card is a door: L0 → observations, L1 → clusters, L2 → artifacts (filtered item list) |
| Knowledge | `artifacts` | Artifacts | L2 list: type, title, status, Library link, clusters, evidence count, last compaction; row → detail drawer |
| Knowledge | `lineage` | Lineage | node graph (`@xyflow/react`, the dependency Explore already uses) for a selected artifact, cluster, or fact: observation → cluster → artifact → library item; `?focus=<id>` deep link |
| Operations | `compactions` | Compactions | the **compaction flow** at the top (≤ 200px: L0 → L1 → L2 → Library tier nodes on `@xyflow/react`, edges labelled with the latest merge, animated while a job runs, health-toned when a tier is behind/stalled, reduced-motion aware), then today's history table + job detail drawer with "what this compaction produced" (items in / clusters out / artifacts touched) |
| Operations | `review` | Review sample | the human sample queue: cluster or artifact, evidence, agree / disagree with a note; the calibration verdict lives here |

`/iq/distillation` redirects to `overview`. Breadcrumbs read
`Build › Distillation › Artifacts`. The palette gets one entry per item.
The rail item count on the shell stays one ("Distillation"); the six
destinations live in the nested rail. Every surface is a route, not a scroll
position.

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
Artifact (L2)     id · type runbook|insight|convention|decision
                  · title · summary · body_markdown
                  · cluster_ids[] · facts[] · library_item_id | null
                  · status draft|published|retired
                  · reviewed_by · reviewed_at · created_by_compaction_id
                  · created_at · updated_at
Fact              id · artifact_id · statement · subject · predicate · object
                  · evidence_observation_ids[] · confidence
ReviewSample      id · target_kind cluster|artifact · target_id · sampled_at
                  · reviewer | null · verdict pending|agree|disagree · note
Lineage           { nodes: {id, kind: observation|session|cluster|artifact|fact|library_item, label, meta}[],
                    edges: {from, to, relation: written_by|merged_into|distilled_into|supports|published_as}[] }
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
```

Every artifact with `library_item_id` links to a REAL Library item
(`GET /api/library/:id` must 200 for it); the Library detail page shows a
"Distilled from" section from `/provenance`. A compaction job gains
`produced: { cluster_ids[], artifact_ids[] }` so a job row can open what it
made. Mock data: ≥ 60 observations across ≥ 6 sessions and 3 repos, ≥ 18
clusters, ≥ 8 artifacts (≥ 5 linked to Library runbooks/skills that exist in
the Library mock, ≥ 2 drafts, 1 retired), ≥ 12 facts with evidence, ≥ 6
pending review samples and ≥ 20 decided ones — enough that every page has a
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
   screenshot for roles `member` (u-theo) and `org-leader` (u-vera), six
   surfaces each, protocol as in `docs/assessment-journeys/PROTOCOL.md`
   (console errors 0, layout numbers, keyboard, empty/error state, gating).
   Sign in as the REAL users via /select → Sign in as. Then a defects file
   per role and the fix → re-audit loop until every log passes.
8. **Docs** — `docs/distillation.md`: what the tiers mean, what a compaction
   does, how an artifact reaches the Library, how to read lineage; update
   `CLAUDE.md`'s architecture line for the middleware if the domain grows a
   schema file.

## Density rule (added 13:40 after the user's review of Tiers)

A list page's list is the page. On tiers, artifacts, compactions and review
the first data row must sit above the fold at the audit width
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
