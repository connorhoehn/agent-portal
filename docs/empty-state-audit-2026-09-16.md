# Empty-state audit — 2026-09-16

The lens: the first hour. Every orgiq nav surface, rendered with no data, using
`dev:mock`'s `empty` scenario (`POST /api/__mock/scenario {"scenario":"empty"}`)
against a throwaway middleware on :3013. Judged against: an empty surface must
say WHAT is missing, WHY, and the ONE next action; it must be visually
distinguishable from a failed read (`UnavailableNotice`, not `EmptyState`,
for `error`/`degraded`); zeros are not an empty state.

Scope was the 12 nav items a new customer hits first: Initiatives, Work
Queue, Findings, Bots, Designs, Library, Promotions, Distillation, Knowledge,
Health, Sprints, Budgets. Distillation and Library/Designs' detail
drill-ins were swept too, since they share the same bug pattern.

## Per-surface

| Nav item | Before | After | Notes |
|---|---|---|---|
| **Initiatives** (`ProjectsPage.tsx`) | `scope=all` + zero initiatives showed "No matching initiatives / No initiative matches the current filters" — a filter-oriented message with dead "Clear filters" action, even with no filter active | Added a genuinely-empty branch: "No initiatives yet" + what an initiative is + how to get one, no dead action | `scope=mine` empty branch was already correct and untouched |
| **Work Queue** (`QueuePage.tsx`) | `error`/`degraded` from the jobs fetch was never read — a failed read rendered as "Nothing here", indistinguishable from a healthy empty queue | Added `UnavailableNotice` gated on `jobsFailure`; the empty/table branch now only renders when the read actually succeeded | The "Ready to assign" panel already handled its own error/empty split correctly |
| **Findings** (`FindingsPage.tsx`) | Same bug: `error`/`degraded` from the findings fetch was never destructured | Added `UnavailableNotice`; the findings `Card` now renders only on a real read | DLQ jobs table's own error path left as-is (secondary, smaller blast radius) |
| **Bots** (`BotsPage.tsx`) | Already correct — `UnavailableNotice` + `EmptyState` with WHAT/WHY copy, `StatStrip` gated behind non-empty | No change | Reference implementation |
| **Designs** (`DesignsPage.tsx`) | Already correct | No change | `DesignThreadPage.tsx` (detail view) used `EmptyState` for its error branch — fixed to `UnavailableNotice` |
| **Library** (`LibraryPage.tsx`) | Already correct, including a real "catalog-empty" vs "filtered" split | No change | `AssetDrawer.tsx` and `AssetEvals.tsx` (detail panels) used `EmptyState` for error — fixed to `UnavailableNotice`, `AssetEvals` also gained a `refresh` handle |
| **Promotions** (`PromotionsPage.tsx`) | Already correct | No change | — |
| **Distillation** (6 pages + 2 frames) | `TiersPage`, `ItemsList`, `ArtifactsPage`, `LineagePage`, `CompactionsPage`, `ReviewPage`, `LineageFrame`, `CompactionFlowFrame` all did `error ? <EmptyState title="Could not load X" description={error} /> : …` — the exact "empty state indistinguishable from failed read" bug, in 8 places | All 8 switched to `UnavailableNotice` with retry where a `refresh`/refetch was available (`ItemsList` gained a small retry-nonce since its fetch is a hand-rolled effect, not `useFetch`). Also improved genuinely-empty copy in `ItemsList`, `ArtifactsPage`, `LineagePage`, `CompactionsPage` to say what an L0/L1/L2 item, artifact or compaction job *is* and how one gets created, only when no filter is active (filtered-to-zero keeps its "Clear filters" copy) | `OverviewPage.tsx` was already the correct reference — half the feature had it right, half didn't |
| **Knowledge** (`KnowledgeHomePage.tsx`) | `UnavailableNotice` already wired for the registry-read failure and the live-comparison failure; the registry `DataTable`'s `emptyMessage` was a bare `'No knowledge bases registered yet.'` string | Replaced with a `ReactNode` explaining what the registry tracks, plus a link to Ingest sources when the viewer can see it | `emptyMessage` accepts `ReactNode`, so this stays in-vocabulary (no hand-rolled markup added) |
| **Health** (`observability/SummaryPage.tsx`) | Already excellent — dashes every number to `—` when "blind" (no credentials, no datastore, or a failed fleet read), distinguishes that from a genuinely-idle fleet, derives its own "what needs you" steps | No change | Reference implementation for the whole audit |
| **Sprints** (`SprintsLens.tsx`, `SprintBoard.tsx`) | Both used `EmptyState` for their error branch (`SprintsLens` even preserved a 403-specific hint inside the `EmptyState` body) | Both switched to `UnavailableNotice`, 403 hint folded into the error string passed to it | `SprintsLens`'s genuinely-empty branch (per-scope copy) was already good and untouched |
| **Budgets** (`BudgetsPage.tsx`, `InitiativesReport.tsx`, `SprintsReport.tsx`) | Top page already used `UnavailableNotice`; both report components underneath hand-rolled their error state as a plain `<T className="text-danger">Failed to load…</T>` inside a bare `Card` — no icon, no retry, no source explanation | Both switched to `UnavailableNotice`; threaded a `refresh` handle from `BudgetsPage` down to `SprintsReport` (it didn't have one) so its retry button works | `InitiativesReport`'s empty-vs-filtered copy was already good |

## Left alone, deliberately

- **Bots, Promotions, Designs (list), Library (list), Health, Distillation
  Overview** — already meet the bar; touching them would be churn.
- **QueuePage's "Ready to assign" secondary panel** and **FindingsPage's DLQ
  jobs table** — both already distinguish error from empty on their own
  smaller scale; left as-is to keep the diff to the primary list on each
  page.
- **Zeros-as-strips**: audited `StatStrip`/`KPIGrid` usage on Bots, Budgets,
  Health, Knowledge — all are gated behind a successful, non-empty (or
  explicitly "blind") read, never shown floating over an empty table. No
  fix needed anywhere in scope.
- **`ProjectsPage.tsx`'s "genuinely empty" branch is unreachable in the
  current mock** — `/api/graph/projects` sources from the org graph seed
  (`graph-people`/`graph-projects`), which the `empty` scenario does not
  fully blank (an org-graph "empty" tenant with a live person roster but no
  initiatives is not a fixture combination the mock currently expresses).
  The code fix is real and correct regardless; it just could not be curl-
  verified end to end against this mock.

## Verify

- `cd portal && npx tsc --noEmit` — exit 0, clean.
- `cd portal && npm test` — 848/848 passing (baseline: 848).
- `cd middleware && npx tsc --noEmit` — exit 0, clean.
- `cd middleware && npm test` — 3938/3938 passing across 264 suites (baseline: 3938/264).
- `./scripts/validate-component-discipline.sh` — ALL CHECKS PASS, exit 0.
- `./scripts/validate-branding.sh` — ALL CHECKS PASS (includes a clean `tsc`
  + `vite build`), exit 0.
- `POST /api/__mock/reset` called; `GET /api/__mock/state` confirmed
  `scenario: "default"` with no pinned/non-default fixtures; throwaway
  server on :3013 killed.

No hand-rolled markup was introduced — every fix reuses `UnavailableNotice`
(`portal/src/components/UnavailableNotice.tsx`) or the library's `EmptyState`
with richer `title`/`description`, matching the house style already set by
`BotsPage.tsx` and `QueuePage.tsx`.
