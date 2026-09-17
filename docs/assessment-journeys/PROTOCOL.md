# Journey audit protocol

One log per (role × surface) under `docs/assessment-journeys/<role>/<surface>.md`,
with its screenshot beside it. `scripts/validate-assessment-tenant.sh` reads
these; the field names and values below are what it greps for.

## Sign in (once per role)

Open `http://localhost:5183/select` → **Sign in as** tab → the user's card →
**Sign in** → back on the Workspaces tab click the **Assessment** tile's role
row. Confirm with `fetch('/api/session/me')` that `sub`, `tenant: 'assessment'`
and `role` are what you expect before auditing anything. Never audit as Demo
User. Users: assessor = `u-asha`, lead-assessor = `u-jonas`, program-lead =
`u-farah`, admin = `u-operator` (enter the Assessment workspace as admin).

## Surfaces and URLs

| surface | url | what "the surface" includes |
|---|---|---|
| dashboard | `/assessment/teams` | the assessor's desk: the program StatStrip, the motion SegmentedControl (`?cohort=`), status + search filters, the team DataTable with its two-track certification and next-action columns, a row opened, browser Back |
| team-scorecard | `/assessment/teams/TEAM-001` | all five tabs (`?tab=`), one dimension selected in the master-detail; the rail rows carry `data-verified` / `data-claimed` and a confidence meter, the Certification tab opens with the evidence coverage strip (Attested / Documented / Observed per dimension), the header names the team's repos as links, and the dimension pane says which enterprise standard it is measured against (or that none is on file) with a link into the explorer |
| submissions | `/assessment/submissions` | list, filters, a row opened |
| submissions-wizard | `/assessment/submissions` → New submission | all four steps (drop → preview → fetch links → run prompt) |
| feedback | `/assessment/feedback` | the question queue: status + team + search filters, the DataTable (dimension by name), a row opened in its Drawer (two tracks, evidence on file, the answer form); Record answer / Dismiss for a role that may |
| reports | `/assessment/reports` | the portfolio: the rollup strip, the maturity heatmap (teams × 17 dimensions, a column head hovered, a team opened), where-to-start as a table, by cohort, Publish for a role that may |
| runs | `/assessment/runs` | ledger, launcher, a launched run appearing and completing without refresh |
| configuration | `/assessment/configuration` | program-lead only; other roles: what they see instead |
| workspace | `/assessment/workspace` | tree rail, document pane, activity aside, connection pill |
| enterprise | `/assessment/enterprise` | same frame |
| rules | `/assessment/rules` | same frame |
| prompts | `/assessment/prompts` | same frame |

## Per surface

1. Navigate, wait for data. `read_console_messages` with `onlyErrors: true`
   and `clear: true` BEFORE the surface, then again after every interaction on
   it. Count only errors (not warnings). Vite HMR overlay errors from another
   agent's in-flight edit are not the page's — wait and reload.
2. Screenshot at the full window (≥1440px wide) with `save_to_disk: true`,
   then copy the file to `docs/assessment-journeys/<role>/<surface>.jpg`.
3. Measure the layout with `javascript_tool`, and write the numbers:
   - every page: `document.documentElement.scrollWidth <= innerWidth` (no
     horizontal scroll); `main`/content column left edge and width.
   - explorer pages (workspace/enterprise/rules/prompts): rail
     `getBoundingClientRect().left` minus the content column's left ≤ 8px.
     The content column is the shell `<main>`'s CONTENT box — measure it as
     `main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingLeft)`.
     The library's `SubNavLayout` pads that `<main>` by 24px with no opt-out
     (queued in `docs/ui-components-queue.md`), so every page's content,
     explorer rails included, starts 24px right of the shell rail; "flush"
     means flush with where content starts, not with the shell rail's border.
     document pane width ÷ content width ≥ 0.55; the page body does not scroll
     vertically while the rail does (`document.scrollingElement.scrollHeight
     <= innerHeight` with the rail `scrollHeight > clientHeight` when it has
     enough rows).
   - master-detail (team-scorecard): rail + detail fill the content width;
     the selected row carries `aria-current` or `aria-selected`.
4. Keyboard: from the page's first control, press Tab until focus has visited
   every interactive control (count them vs. `querySelectorAll('a,button,
   input,select,textarea,[tabindex]')` minus hidden); Enter/Space on a tab
   or row acts; Escape closes any drawer/modal/palette you opened.
5. Empty / error state: for the dashboard use TEAM-006/TEAM-007 (unassessed) and a search that matches nothing;
   for team-scorecard load `/assessment/teams/TEAM-999` (404); for a gated
   control use the role that lacks it (assessor on reports Publish,
   configuration); for the wizard cancel at step 1. Write what rendered.
6. Role-gating: list the controls this role CAN use and the ones that are
   hidden for it, and confirm the hidden ones are absent from the DOM (not
   just disabled) unless the page deliberately shows them disabled with a
   reason.
7. Write the log. If something is wrong, `verdict: fail — <what>` and keep
   going; do not fix pages mid-audit (a page edit invalidates every log's
   freshness). Collect defects in `docs/assessment-journeys/<role>/DEFECTS.md`.

## Log format

```
surface: team-scorecard
role: lead-assessor
user: u-jonas
url: /assessment/teams/TEAM-001?tab=plan
audited: 2026-09-05 00:12 local, Chrome 1456px, middleware dev:mock
screenshot: team-scorecard.jpg
verdict: pass
console errors: 0
layout: pass — content col left 198px w 1258px; rail left 198px (0px from edge), pane 1010px = 80%; no horizontal scroll; body scrollHeight 836 ≤ 836
keyboard: pass — 23 controls reachable by Tab, Enter opens a dimension, Escape closes the drawer
empty-state: pass — TEAM-999 renders "Team not found" with a link back to the dashboard
role-gating: can score dimensions, approve exceptions, publish; cannot edit configuration (Configuration absent from rail and palette)
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links>
```

`verdict`, `console errors`, `layout`, `keyboard`, `empty-state` and
`screenshot` are required; the words TODO, unverified and placeholder anywhere
in the file make it not count.

## `pages:` (required)

Every log carries a `pages:` line naming the files and/or directories its
surface actually renders from, comma-separated — e.g.
`pages: portal/src/pages/assessment/SubmissionsPage.tsx,portal/src/pages/assessment/submissions`.
Freshness is judged per surface against those entries, so an edit to the
knowledge explorer stales the workspace logs, not all sixty-three. A log
with no `pages:` line is judged against the newest edit anywhere under
`portal/src/pages/assessment`, so leaving it off makes a log stale sooner,
never later. Name FILES, not the tenant directory, and leave shared children
(the layout, `Text.tsx`, format modules) out — naming them puts every log
back under a global rule. Find the entries from the route in
`portal/src/App.tsx` and the page component's imports.

## Measuring a surface from the console — two traps that invent defects

Both of these produced a confident false positive during the 2026-09-17 sweep,
each costing a near-miss "fix" to code that was already right. Neither is
obvious from the numbers alone, so check for them before reporting a layout
defect found by script rather than by eye.

**1. `offsetParent !== null` is not visibility.** An element with
`visibility: hidden` still has an `offsetParent`, so a naive tabbable-filter
counts it — and since the browser correctly refuses to focus it, the walk then
reports controls that "refuse focus". xyflow keeps a hidden node-measurement
layer, so any graph surface trips this. Walk the ancestors for
`visibility`/`display` as well:

```js
function reallyVisible(e) {
  if (e.offsetParent === null) return false;
  const cs = getComputedStyle(e);
  if (cs.visibility !== 'visible' || cs.display === 'none') return false;
  for (let a = e.parentElement; a; a = a.parentElement) {
    const ac = getComputedStyle(a);
    if (ac.visibility === 'hidden' || ac.display === 'none') return false;
  }
  return true;
}
```

**2. `getBoundingClientRect()` inside an `overflow-x: auto` container reports
UNCLIPPED positions.** A child scrolled out of view still reports the rect it
would occupy if the container were infinitely wide, so comparing a child's
`right` against its cell's `right` "proves" an overlap that the browser is in
fact clipping. The assessor's desk Step column is the live example: its
`WorkflowStepper` is a 160px `<ol class="overflow-x-auto">` whose six steps lay
out to 454px, and the rects for steps 3-6 land on top of the next four columns
— while the browser clips them and scrolls the one cell, exactly as that call
site's comment says it does. Before concluding "this overflows onto its
neighbour", walk up from the element and check whether any ancestor has
`overflowX` of `auto`/`scroll`; if one does, it is clipping, not colliding.
