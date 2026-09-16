# Request-budget audit — 2026-09-16

**Lens.** What does each nav item cost the browser on first paint and while it
sits open? Measured in Chrome as Rachel Kowalski (hr-admin) eight seconds after
a full load, then traced statically to the component that fires each call.
The two earlier lenses (screen reader, laptop widths — see `d70e3f7`) looked
at what a page shows; this one looks at what it asks for.

## What was measured

Shell baseline on EVERY page (12 GETs before the page's own):
bots/active-runs, health, session/me, auth/config, session/capabilities,
local-compute/nodes, work/summary, observability/harness/runs?limit=5,
devbox/boxes, devbox/status, graph/projects, budgets
+ devbox/boxes AND devbox/status re-fetched every ~2s (4 pairs in 8s) on every page.

Page-own requests (beyond baseline):
- Initiatives /iq/projects: graph/projects?limit=100&scope=all (so graph/projects ×2 shapes)
- Budgets /admin/budgets: budgets ×2 more (×3 total), budgets/grants, graph/projects?limit=100 (×3 shapes total)
- Designs: designs
- Promotions: promotions
- Automate /iq/work: bots, work/summary (dup of shell), lab/consults?status=pending, work/jobs?limit=50, work/proposals?status=pending, rediscovery/stats, work/events (SSE)
- Library: library?kind=all&tier=all
- Distillation overview: levels ×2, ingest ×2, compactions ×2, sampling ×2, artifacts?status=published, work/findings?status=open, session-bundle/live, bots, promotions, procedures, local-compute/nodes (dup), local-compute/presence/repos  (17 page requests, 4 routes doubled)
- Local compute: local-compute/nodes (dup of shell), local-compute/runs, work/suggestions, bots
- Computer Lab /admin/devbox: none beyond baseline (boxes/status are the baseline)
- Health /admin/observability/summary: observability/summary ×2, health (dup of shell), capabilities/guardrail/metrics?hours=6, agents, oncall/alarms, recent-invocations?limit=50
- Architecture /iq/agents: topology/a2a?windowHours=24, agents
- Knowledge /admin/knowledge: kb-registry/health, kb-registry/reconcile, ingest/jobs?limit=10, ingest/crawl-targets, ingest/storage, kb-registry/upload-links?kbSlug=orgiq-default
- Explore: graph/entities
- Identity /admin/identity: identity/roles, identity/schema → 503 on every load (no policy store offline)
- Session config /iq/release: session-bundle/live, session-bundle
- Capabilities: capabilities/reconcile, observability/capability-events?limit=100

Idle polling seen between batches (~30s windows): Automate polls work/summary, jobs, consults, active-runs at ~10s; Health polls observability/summary + recent-invocations at ~15s. Not storms.

## Where each call comes from (static trace)

Shell timers — fire on every page, every tenant, none check
`document.visibilityState`:

| Source | Route | Cadence |
|---|---|---|
| `components/shell/Layout.tsx` | `/api/health` | 30s |
| `components/shell/Layout.tsx` | `/api/work/summary` (orgiq) | 15s |
| `components/shell/ActiveRunsBadge.tsx` | `/api/bots/active-runs` | 10s |
| `components/shell/LocalComputeBadge.tsx` | `/api/local-compute/nodes` (orgiq) | 15s |
| `components/shell/GatewayStatusBadge.tsx` | gateway `/health` | 30s, hand-rolled `setInterval` |
| `pages/admin/AdminLayout.tsx` → `KBHealthBadge.tsx` | KB health | 60s, hand-rolled `setInterval`, all `/admin/*` |
| `components/compute/ComputeHost.tsx` | `/api/graph/projects`, `/api/budgets` | once, for `canManage` roles |
| library `ComputeProvider` via `ComputeHost` | devbox fleet | 5s default — measured ~2s |

Duplicate layout+page fetches (same route, two independent timers on one page):
Health → Summary (`ObservabilityLayout` 30s + `SummaryPage` 30s — the comment
claiming the browser cache de-dupes was false: `useFetch` is a plain `fetch()`
with no cache option); Health → Invocations (layout 10s + page 5s); Admin
Ingest (`IngestLayout` + `CrawlTargetsPage`/`RunHistoryPage`, same false
comment); Distillation overview (`OverviewPage` + `ProcessFlow` re-fetch
levels/ingest/compactions/sampling); Budgets (`BudgetsPage` + `InitiativesReport`
both read `graph/projects?limit=100`); `/api/graph/projects` has four
independent fetchers in three URL shapes app-wide.

N+1: assessment Reports (`useDimensionIndex` → one `teams/:id` per team, on
every load, just for heatmap cells — worst in either tenant, scales with org
size); `ProjectDetailPage` rails (one runs fetch per bot, one access check +
one runs fetch per environment).

Waste: `DashboardPage` fetches the whole roster on the scorecard view and
never reads it; `TeamScorecard` mounts all five panes on open so four fetch
sight-unseen; `DiffPage` mounts two pickers that each fetch the prompt library.

Runaway polls: `LocalComputePage` `RunLog` polls at 2s forever (never reads
`done`); harness `RunDetailPage` keeps polling a terminal run at 5s;
`PairMachineDialog` runs two 2.5s loops that both re-read `/nodes`.

Keystroke fetches: Library, distillation Artifacts and Lineage interpolate the
live search value into the `useFetch` URL with no debounce — `TiersPage`
already has the right pattern.

Raw `fetch` bypasses (no abort, stale state on unmount): assessment
`ConfigurationPage`, `RunACommandPanel`, identity `UsersPage`.

`CostPage` fires eight `windowHours`-keyed endpoints, seven polling at 30s,
for one dataset.

## The one hook change

Every finding in the "shell" and "duplicate" groups is the same missing
behaviour in `hooks/useFetch.ts`: no visibility awareness, no error backoff,
no in-flight dedupe. The audit's recommendation, adopted: add all three to
the hook — visibility pause + refetch-on-visible and backoff unconditionally
(they change no caller's data), dedupe as an OPT-IN option so the ~217 call
sites keep their independent `isLoading`/`refresh` semantics until a caller
asks to share.

## Resolution (same day)

- `hooks/useFetch.ts`: polls pause while the tab is hidden and refetch once
  on return; consecutive failures back the poll off (×2 per failure, capped
  ×5, `hooks/pollSchedule.ts`); `{ share: true }` dedupes concurrent
  in-flight requests per URL for callers that opt in. Scheduling is a
  recursive `setTimeout`, so overlapping runs no longer pile up.
- The ~2s devbox churn was `ComputeHost` handing the library's
  `ComputeProvider` an inline `clientOptions` literal: a new identity every
  render re-minted the client, and the library read that as a transport
  change and re-fired `/boxes` + `/status`. Memoised; the fleet poll is now
  15s and visibility-gated. Measured with visibility forced on: one pair per
  window instead of four or five.
- Layout+page duplicates: Health summary and Invocations share one poll;
  Ingest layout and pages share theirs; `ProcessFlow` and `InitiativesReport`
  take their data as props. Distillation overview 33 → 22 requests, Health
  24 → 16, Initiatives 18 → 11 on mount (the remaining baseline is one read
  per shell chip; `harness/runs?limit=5` was already cached per session).
- Assessment: `GET /api/assessment/dimension-index` replaces the per-team
  reads under the heatmap (Reports 10 → 4); the scorecard view no longer
  fetches the roster and mounts panes on first visit (open 5 → 2, each
  further tab +1 once, revisits +0).
- Initiative rails: `GET /api/bots/runs?botIds=…` and `GET /api/environments/:id/enter`
  replace the per-row fan-outs; the page reads spend/repo off
  `graph/projects/:id` instead of the whole list.
- Runaway polls stop on terminal state (run log, harness run detail); the
  pairing dialog runs one watcher; Library/Artifacts/Lineage search is
  debounced through `hooks/useDebouncedSearch.ts`; `DiffPage` fetches the
  library once; identity Users and the assessment Configuration/Run panels
  read through `useFetch`.
- Done the next day: `GET /api/observability/cost/summary?windowHours=`
  runs the eight section queries with `Promise.allSettled` and names a
  failing section in `degraded`; `CostPage` reads it once per 30s (was eight
  requests per cycle). The refactor exposed that `routes/cost.ts` never had a
  mock branch — offline the page was eight UnavailableNotices — so the
  sections now derive from the costed bot-run and trace fixtures.

The measurement caveat worth keeping: a Chrome tab driven by automation can
report `visibilityState: hidden`, which now pauses every poll — measure
cadence with visibility forced on, or the "after" numbers flatter the fix.
