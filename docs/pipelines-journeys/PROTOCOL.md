# Journey audit protocol — the pipelines tenant

Adapted from `docs/assessment-journeys/PROTOCOL.md`: same log fields, same
freshness rule, same measuring traps, different surfaces and cast. One log
per (role × surface) under `docs/pipelines-journeys/<role>/<surface>.md`,
with its screenshot beside it. `scripts/validate-pipelines-tenant.sh` reads
these; the field names and values below are what it greps for. The goal is
`docs/pipelines-tenant-goal.md`.

Walk with headless Playwright or a curl jar — never the user's shared Chrome
tab (it holds their cookies; a persona switch there hijacks their session).

## Sign in (once per role)

Open `http://localhost:5183/select` → **Sign in as** → the user's card →
**Sign in**; the cast holds a grant only in Pipelines, so it lands on
`/pipelines/runs` without a chooser stop. Confirm with
`fetch('/api/session/me')` that `sub`, `tenant: 'pipelines'` and `role` are
what you expect before auditing anything. Never audit as Demo User.
Users: author = `u-ines`, operator = `u-kofi`, pipeline-admin = `u-dara`,
admin = `u-operator` (enter the Pipelines workspace as admin).

## Surfaces and URLs

| surface | phase | url | what "the surface" includes |
|---|---|---|---|
| runs | P0 | `/pipelines/runs` | the DataTable of Runs, status + kind + context-tenant filters, a row opened, browser Back |
| run-detail | P0 | `/pipelines/runs/<id>` (a bot-sourced run) | `pipeline-run` header with `context` (tenant, kind, source) and `sourceStatus`; `pipeline-steps` via `RunTimeline`; `pipeline-artifacts`; `pipeline-events` receiving at least one frame without refresh |
| artifacts | P0 | `/pipelines/artifacts` | DataTable of artifacts (kind, run, step), one opened |
| agents | P0 | `/pipelines/agents` | read-only list of the agent producers each tenant registered |
| bots | P0 | `/pipelines/bots` | read-only list of bot producers |
| commands | P0 | `/pipelines/commands` | read-only list of assessment commands |
| configuration | P0 | `/pipelines/configuration` | pipeline-admin only; other roles: what they see instead |
| definitions | P2 | `/pipelines/definitions` | catalog, a definition opened, versions; New/Edit for author only |
| runbooks | P2 | `/pipelines/runbooks` | RUNBOOK definitions with their last dry-run; a promotion refused without a completed run |
| approvals | P2 | `/pipelines/approvals` | pending steps; Approve/Reject for operator and pipeline-admin, absent for author |

Plus one cross-tenant slice log, `slice/bot-detail.md`, walked as `u-nora`
(sme, orgiq) at `/admin/bots/<a maintenance bot>`: the cron firing rendered as
Run → Steps → Artifact → Events. Extra required fields:
`run-rendered: yes`, `steps-rendered: <n>` (≥ 3), `artifact-rendered: yes`,
`events-streamed: yes`.

## Per surface

1. Navigate, wait for data. Collect console errors (not warnings) BEFORE the
   surface and after every interaction on it. A Vite HMR overlay from
   another agent's in-flight edit is not the page's — wait and reload.
2. Screenshot at ≥1440px wide and save it as
   `docs/pipelines-journeys/<role>/<surface>.jpg`.
3. Measure the layout and write the numbers: no horizontal scroll
   (`document.documentElement.scrollWidth <= innerWidth`); the content
   column's left edge and width (the shell `<main>`'s content box:
   `main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingLeft)`);
   for run-detail, the timeline fills the content width and the selected
   step carries `aria-current` or `aria-selected`.
4. Keyboard: Tab from the first control until focus has visited every
   interactive control (count against the really-visible set, trap 1
   below); Enter/Space on a row acts; Escape closes any drawer or popover.
5. Empty / error state: runs filtered to nothing; `/pipelines/runs/does-not-exist`
   (404 state); the gated control seen by the role that lacks it (author on
   Approve, operator on Configuration). Write what rendered.
6. Role-gating: list the controls this role CAN use and the ones hidden for
   it; confirm the hidden ones are absent from the DOM (not just disabled)
   unless the page deliberately shows them disabled with a reason. The
   separation of duties in the goal doc's Cedar table is what to check:
   author never sees Approve / Cancel / Configuration, operator never sees
   New definition / Configuration.
7. Write the log. If something is wrong, `verdict: fail — <what>` and keep
   going; do not fix pages mid-audit (a page edit can stale every log that
   names it). Collect defects in `docs/pipelines-journeys/<role>/DEFECTS.md`.

## Log format

```
surface: run-detail
role: operator
user: u-kofi
url: /pipelines/runs/job-000123
pages: portal/src/pages/pipelines/RunDetailPage.tsx,portal/src/components/runs/RunTimeline.tsx
audited: 2026-09-30 10:12 local, Chromium 1456px (Playwright headless), middleware dev:mock
screenshot: run-detail.jpg
verdict: pass
console errors: 0
layout: pass — content col left 198px w 1258px; timeline 1258px; no horizontal scroll
keyboard: pass — 14 controls reachable by Tab, Enter opens a step, Escape closes the drawer
empty-state: pass — /pipelines/runs/does-not-exist renders "Run not found" with a link back to Runs
role-gating: can approve the awaiting step and cancel; New definition and Configuration absent from rail, palette and DOM
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links>
```

`verdict`, `console errors`, `layout`, `keyboard`, `empty-state`,
`role-gating`, `screenshot` and `pages` are required; the words TODO,
unverified and placeholder anywhere in the file make it not count.

## Isolation logs

Under `docs/pipelines-journeys/isolation/`. The tenant must be invisible to
every role with no grant in it, and its own roles must see nothing of the
others.

**Inbound** — `<role>.md` for `member sme program-owner org-leader
hr-admin` (users `u-theo u-nora u-mia u-vera u-rachel`, per
`docs/orgiq-journeys/PROTOCOL.md`), `assessor lead-assessor program-lead`
(`u-asha u-jonas u-farah`) and, once `social` is in `session.ts` `TENANTS`,
`participant moderator community-admin` (the social goal's cast):

```
role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
pipelines-tile-visible: no        # /select: which tiles, which role rows
pipelines-nav-visible: no         # rail + palette: 0 anchors toward /pipelines
direct-route-result: redirect     # /pipelines/runs and /pipelines/runs/<id> → where
api-status: 403                   # GET /api/pipelines/runs, /runs/<id>, /runs/<id>/steps
events-status: 403                # GET /api/pipelines/runs/<id>/events (the SSE door, separately)
screenshot: member.jpg
verdict: pass
```

**Outbound** — `<role>-outbound.md` for `author operator pipeline-admin`:

```
role: author
user: u-ines
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
other-nav-visible: no             # rail + palette: 0 anchors toward /iq, /admin, /assessment, /social
iq-route-result: redirect         # /iq/projects, /admin/bots/<id>, /iq/runs
iq-api-status: 403                # /api/runs (the orgiq façade), /api/bots
assessment-route-result: redirect
assessment-api-status: 403        # /api/assessment/teams, /api/assessment/pipeline-runs
social-route-result: redirect     # required once social is registered
social-api-status: 403            # required once social is registered
verdict: pass
```

## `pages:` and freshness

Freshness and sealing follow [docs/journeys.md](../journeys.md): a log is stale when the rendered contract of a route its `url:` names changed since its walk was sealed (sweep measurements, gate, the assertions of the specs that cover it), and only `scripts/journeys/seal.sh <dir>`, after a walk, seals it. A `pages:` line is optional: it is the basis only for a log that names
no route.

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

