# Search journey audit protocol

One log per (role × surface) under `docs/search-journeys/<role>/<surface>.md`,
with its screenshot beside it. `scripts/validate-search-workspace.sh` reads
these; the field names and values below are what it greps for. The design
being judged is the five panels in `docs/design/search-*-mockup.png`; the
contract is `docs/search-workspace.md`; the goal is
`docs/search-workspace-goal.md`.

## Sign in (once per role)

Against the `dev:mock` middleware (`AUTH_DEMO_MODE=true`), either open
`http://localhost:5183/select` → **Sign in as** → the user's card → **Sign
in** → the **Org** tile's role row, or `POST /api/session/login` with the
user id and then `POST /api/session/tenant` / `/role` — whichever the walker
uses, confirm with `GET /api/session/me` that `sub`, `tenant: 'orgiq'` and
`role` are what you expect and write that line into the log. Never audit as
Demo User. Users: member = `u-theo` (Theo Chang), org-leader = `u-vera`
(Vera Green, Org → Org Leader). Both hold `Search`; org-leader additionally
holds `ViewOrgChart`-dependent surfaces where the seed says so — the People
panel's person records are permission-filtered, so a role without
`ViewOrgChart` sees no People group and the log's `role-gating` line must
say so.

## Surfaces and URLs

| surface | url | what "the surface" includes |
|---|---|---|
| results | `/iq/search?q=Who%20can%20help%20finish%20Auth%20Migration%3F&tab=results` | two-rail frame (shell rail · SEARCH rail · content); SEARCH rail rows with counts, More types ▾, SAVED and RECENT groups, `+` new search; crumbs Org › Search; hero query field with clear + submit; Workspace ▾ scope chip and + Filter; Results N / Answer / Connections tabs with Relevance ▾ sort; groups People / Initiatives / Work / Knowledge / Decisions with counts and "See all N →"; rows with checkbox, avatar or kind mark, meta line, status dot, chevron; the hint line; selection → "Ask about selection →" |
| answer | same query, `tab=answer` | the transcript: You / Org Assistant, cited people rows with `[n]`, "Work to coordinate", numbered Sources chips, "View these connections →", the footnote; the docked composer (Agent ▾, context chips, Send) |
| connections | same query, `tab=connections` | Force / Radial / Hierarchy, type filter, "N records · M connections", labelled edges, selection check on a node, "N selected · Clear · Ask about selection →", legend, zoom − % + Fit ⛶, the collapsed assistant strip with Expand conversation |
| people | `/iq/search?type=person&tab=connections` | the org graph: "N people · M edges", Force / Radial, find a person or skill, Top-K and Min strength sliders, department chips with counts, Rare skills, the Departments + Relationships legend, person selection → detail card, two selected → connection path |
| scoped | `/iq/search?scope=p-design-system-api&q=component%20contracts&tab=results` (reach it from the initiative page's "Search in this initiative" and say so) | "In: Design System API ×" chip + "Search entire workspace", the query as an editable title, highlighted terms in rows, "Open work item ↗" / "Open initiative ↗", "N results in Design System API", "Ask about these results ↗ · View connections ↗" |

## Graph acceptance (connections, people)

Judge the graphs by these rules, not by taste:

- **At open**, every drawn record is inside the canvas when the whole graph
  fits at a readable zoom (≥ 70% for the record graph, ≥ 90% for the org
  graph). When it cannot, the view centres on the selection: every
  SELECTED record's full box (avatar, name, status) must be inside the
  canvas, and "Fit to view" must then show everything (any zoom). Records
  outside the canvas in that fallback are not a defect; a clipped selected
  record always is.
- **After a canvas resize** (the answer strip opening, the conversation
  expanding, the person card opening) the same rule holds at the new size:
  the selection stays whole; the legend and the zoom / Fit controls stay
  visible and clickable.
- **Overlays**: at the opening view on the full canvas, and after "Fit to
  view", no node's avatar or name sits under the legend, the zoom controls
  or the person card. In the selection-centred fallback on a shortened
  canvas (answer strip open, conversation expanded) the SELECTED records
  must be clear of the overlays; an unselected record behind an overlay
  there counts the same as one beyond the canvas edge, which the rule
  above already allows.
- **Readability**: name labels ≥ 9px at the automatic fit. Below that is a
  defect only if the automatic fit chose it while a larger fit satisfying
  the rules above was possible.

## Per surface

1. Navigate, wait for data. Collect `console.error` and `pageerror` BEFORE
   the surface, then after every interaction on it. Count only errors.
   Vite HMR overlay errors from another agent's in-flight edit are not the
   page's — wait and reload.
2. Screenshot at the full window (≥1440px wide), saved beside the log as
   `docs/search-journeys/<role>/<surface>.jpg` (or `.png`; name it in the
   `screenshot:` line exactly).
3. Measure the layout and write the numbers: no horizontal scroll
   (`document.documentElement.scrollWidth <= innerWidth`); the shell rail and
   the SEARCH rail share one type scale (item label px / row pitch px on
   each); the SEARCH rail's left edge sits flush with the content column
   (≤ 8px); exactly one `<main>`; the page body does not scroll while the
   results pane does.
3b. Density (results, scoped): `first-row-top` = the top of the first result
   row (`getBoundingClientRect().top`) at the audit width. Write it in the
   `layout:` line. It must be ≤ 640px, and nothing above the list may be a
   stack of cards carrying only status — the hero field, one chip row and
   the tab row are the budget.
4. Keyboard: from the query field, Tab until focus has visited every
   interactive control (count them vs. `querySelectorAll('a,button,input,
   select,textarea,[tabindex]')` minus hidden); Space on a row's checkbox
   selects; Enter on a row opens; Escape closes any menu you opened. On the
   graphs, a node is reachable and selectable from the keyboard.
5. Empty / error state: results — search `zzznoexist` and write what the
   empty state says; scoped — clear the scope and confirm the chip and
   footer change; connections — a type filter that leaves no records shows
   the empty canvas copy; people — a role without `ViewOrgChart` (if any in
   the seed) or `?type=person` with no people permission.
6. Role-gating: list the controls this role CAN use and the ones hidden for
   it, and confirm the hidden ones are absent from the DOM.
7. Write the log. If something is wrong, `verdict: fail — <what>` and keep
   going; do not fix pages mid-audit (a page edit stales every log). Collect
   defects in `docs/search-journeys/<role>/DEFECTS.md`.

## Log format

```
surface: results
role: member
user: u-theo (Theo Chang) — GET /api/session/me: sub u-theo, tenant orgiq, role member
url: /iq/search?q=…&tab=results
audited: 2026-09-28 17:40 local, headless Chromium (Playwright) 1672×941, middleware dev:mock :3001, portal vite :5183, ui-components 2.402.0
screenshot: results.jpg
pages: portal/src/pages/search/SearchPage.tsx,portal/src/pages/search/SearchComposer.tsx
verdict: pass
console errors: 0
layout: pass — <numbers>; first-row-top: <n>px
keyboard: pass — <n> controls reachable by Tab; Space selects a row, Enter opens it, Escape closes the sort menu
empty-state: pass — <what rendered>
role-gating: <can / cannot, and that hidden controls are absent from the DOM>
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links, gaps against the mockup>
```

`verdict`, `console errors`, `layout`, `keyboard`, `empty-state` and
`screenshot` are required; the words TODO, unverified and placeholder
anywhere in the file make it not count. Every log is judged stale the moment
any `.tsx` under `portal/src/pages/search/` is newer than it.
