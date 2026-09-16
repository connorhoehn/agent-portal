# URL-state and deep-link audit — 2026-09-16

**Lens.** Which of a page's user-chosen state lives in the URL, and which
lives in `useState` where a refresh drops it, Back does not restore it, and
the view cannot be sent to a colleague. Every routed page in both tenants
was traced to the line that holds each piece of state.

## What was found

The pattern is proven and already right where it is used —
`pages/work/FindingsPage.tsx` (`?sweep=`/`?q=`/`?finding=`),
`pages/observability/InvocationsPage.tsx`, `pages/distillation/TiersPage.tsx`
(debounced), `pages/assessment/DashboardPage.tsx` (`?tab=`/`?cohort=`) — and
every URL-backed filter in the app correctly uses `replace`, so nobody has
polluted history with a keystroke per character. The problem is coverage, not
correctness: there is no shared helper, so each page decides for itself, and
roughly half decided `useState`.

**Two real bugs, not just gaps.**

- The per-team Report button builds `/assessment/reports?team=<id>`
  (`dashboard/TeamScorecard.tsx`), and the Reports page never reads a query
  param. The link silently lands on the portfolio rollup — it has always
  looked like it worked.
- A drawer-URL write bug, duplicated: Library and Distillation Artifacts both
  read the open item from the route on mount and never write it back on
  click. The first render honours a deep link; every click after that is
  invisible to the URL.

**Where state is lost.** Local compute holds the selected machine and run in
component state and re-auto-selects the first machine on every mount, so a
refresh mid-investigation moves you somewhere else. `windowHours` is private
state on eight observability pages, so "the last six hours of drift" is not a
link. The initiative detail page's tab is local, so a link to the decisions
tab always opens Work. Explore — the richest page in the app — keeps its
whole selection locally and accepts `?focus=` one way only. The advanced
invocation search reads the URL once and writes nothing back, unlike its
sibling one file over. Roughly a dozen list pages hold search and status
filters locally.

**Not found:** `window.location` used for in-app navigation, and filter
writers pushing history per keystroke. One link build skips
`encodeURIComponent` on the Scores compare page while the fetch below it does
not.

## Resolution

See the commit carrying this document. The shared helper is
`portal/src/lib/useUrlState.ts`; per-page parameters are recorded in the
journey logs' re-observations for the surfaces touched.
