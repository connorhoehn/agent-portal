# Journey audit protocol

One log per (role × surface) under `docs/distillation-journeys/<role>/<surface>.md`,
with its screenshot beside it. `scripts/validate-distillation.sh` reads
these; the field names and values below are what it greps for.

## Sign in (once per role)

Open `http://localhost:5183/select` → **Sign in as** tab → the user's card →
**Sign in** → on the Workspaces tab click the **Org** tile's role row. Confirm
with `fetch('/api/session/me')` that `sub`, `tenant: 'orgiq'` and `role`
are what you expect. Never audit as Demo User. Users: member = `u-theo`,
org-leader = `u-vera` (Org → Org Leader). org-leader holds `ManageBots`
(Compact buttons, Review agree/disagree); member does not — for member the
log's `role-gating` line must state those controls are absent from the DOM.

## Surfaces and URLs

| surface | url | what "the surface" includes |
|---|---|---|
| overview | `/iq/distillation/overview` | stat strip, tier health banners, ingest pressure, sampling verdict; nested rail present with Memory / Knowledge / Operations groups; breadcrumb Build › Distillation › Overview |
| tiers | `/iq/distillation/tiers` | three level cards; each card opens the item list for that level; "Load more" pagination; a filter that yields an empty list |
| artifacts | `/iq/distillation/artifacts` | table with type/status chips, Library link (opens `/iq/library/:id` and that page shows "Distilled from"), filters + search, row drawer: body, facts + evidence, mini-lineage, Open in Library, Open lineage |
| lineage | `/iq/distillation/lineage?focus=<artifact id>` | graph renders with typed nodes + labelled edges, fit-to-view, click node → side panel, Focus here re-centres, keyboard Tab/Enter/Esc; no-focus state shows the picker; bad id → not-found state |
| compactions | `/iq/distillation/compactions` | the compaction flow at the top (4 tier nodes L0/L1/L2/Library, 3 edges labelled with the latest merge; the L0→L1 edge animates while a job runs; clicking a tier node opens Tiers at that level), then history table + filters, job drawer with Produced links, Compact buttons (org-leader) → a new running job appears and completes; `first-row-top` still ≤ 640px with the flow present |
| review | `/iq/distillation/review` | pending queue with evidence; Agree/Disagree + note (org-leader) moves the item to Decided; member sees read-only; the calibration verdict is explained |

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
3b. Density (list surfaces — tiers, artifacts, compactions, review): measure
   `first-row-top` = the top of the first data row (`getBoundingClientRect().top`
   of the first `tbody tr` or list row) at the audit width. Write it in the
   `layout:` line. It must be ≤ 640px, and nothing above the table may be a
   stack of cards carrying only status/decoration — a selector row, a filter
   row and a one-line description are the budget. Above 640px the layout
   verdict is `fail — table below the fold (<n>px)`.
4. Keyboard: from the page's first control, press Tab until focus has visited
   every interactive control (count them vs. `querySelectorAll('a,button,
   input,select,textarea,[tabindex]')` minus hidden); Enter/Space on a tab
   or row acts; Escape closes any drawer/modal/palette you opened.
5. Empty / error state: for the dashboard use TEAM-006/TEAM-007 (unassessed);
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
surface: artifacts
role: org-leader
user: u-vera
url: /iq/distillation/artifacts
audited: 2026-09-05 00:12 local, Chrome 1456px, middleware dev:mock
screenshot: artifacts.jpg
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

## `pages:` and freshness

Freshness and sealing follow [docs/journeys.md](../journeys.md): a log is stale when the rendered contract of a route its `url:` names changed since its walk was sealed (sweep measurements, gate, the assertions of the specs that cover it), and only `scripts/journeys/seal.sh <dir>`, after a walk, seals it. A `pages:` line is optional: it is the basis only for a log that names
no route (a stretch proof, the review).
