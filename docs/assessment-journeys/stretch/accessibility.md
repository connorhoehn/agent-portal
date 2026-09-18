stretch item: accessibility sweep
role: lead-assessor
user: u-jonas
tenant: assessment
pages: portal/src/pages/assessment
audited: 2026-09-18 08:0x local, Chrome 1512px, middleware dev:mock on 127.0.0.1:3013 behind a Vite proxy pinned to it
verdict: pass — every control the tenant renders resolves an accessible name, in all three document states. The four explorer surfaces and the read/edit/drawer states were re-measured because the landed fix touches `DocPane`: **25 read / 28 edit / 32 edit-plus-drawer, 0 unnamed** at every step, identical to the previous pass. One cosmetic gap remains and is unchanged: the explorer `[role=tree]` containers still carry no `aria-label`.
console errors: 0 — read after each of the four re-measured explorer surfaces, and after the read-state, edit-state and drawer-state sweeps on `/assessment/rules`.

Re-run scope: this pass re-measured the four knowledge-explorer surfaces
(workspace, enterprise, rules, prompts) and the document read/edit/drawer
states, because those are what the notice-ageing fix reaches — it lives in
`DocPane` and its knowledge helpers. The other eight rows in the table below
carry their 2026-09-07 02:35 measurements unchanged; nothing in this fix
touches them. Rows re-measured in this pass are marked **(re-measured 05:03)**.

Method, unchanged so the numbers stay comparable: for each surface,
`javascript_tool` queried `button, a[href], input, select, textarea,
[role=button], [role=tab], [role=treeitem], [role=option]` (visible only —
`getClientRects().length > 0`) and checked each for an accessible name via, in
order: `aria-label`, `aria-labelledby` (resolved to real text), an associated
`<label for>` or wrapping `<label>`, the first `<option>` of a `<select>`,
non-empty text content, then `title`. A `<textarea>`'s `textContent` is its
default *value*, not an accessible name, so it is excluded — that correction
dates from the 02:00 pass and is what originally surfaced the editor gap. Each
surface was reached by a real navigation, not a client-side `pushState`, which
races the router and reads the previous route.

## Per-surface table

| surface | url | controls | unnamed | notes | verdict |
|---|---|---|---|---|---|
| dashboard | `/assessment/teams` | 28 | 0 | cohort tiles, table rows, "+ New team" all named via text | pass |
| team-scorecard | `/assessment/teams/TEAM-001` | 50 | 0 | see master-detail detail below | pass |
| submissions | `/assessment/submissions` | 34 | 0 | table + search + row actions all named; the revision-history drawer's ✕ carries `aria-label="Close"` rather than visible text, which the sweep resolves correctly | pass |
| submissions-wizard | `/assessment/submissions?view=add`, step 1 (Drop file) | 25 | 0 | stepper items, dropzone, Parse/Back/Next all named; the three disabled buttons are still named | pass |
| feedback | `/assessment/feedback` | 224 | 0 | the largest surface in the tenant and it stays clean | pass |
| reports | `/assessment/reports` | 24 | 0 | | pass |
| runs | `/assessment/runs` | 46 | 0 | ledger rows + per-command "Run" buttons + the team `<select>`, whose visible "Choose a team…" default option acts as its name | pass |
| configuration | `/assessment/configuration` | 26 | 0 | as lead-assessor: read-only banner, every field disabled but still carrying a text `<label>` | pass |
| workspace | `/assessment/workspace?doc=page:100002` | 27 | 0 | **(re-measured 05:03)** unchanged; see tree detail below | pass |
| enterprise | `/assessment/enterprise?doc=ec:standards/ci-cd-standards.md` | 36 | 0 | **(re-measured 05:03)** unchanged; four icon-only directory chevrons, all named | pass |
| rules | `/assessment/rules?doc=rule:scoring-guardrails.md` | 25 | 0 | **(re-measured 05:03)** unchanged from the previous pass's 25 | pass |
| prompts | `/assessment/prompts?doc=prompt:classify-transcript.md` | 28 | 0 | **(re-measured 05:03)** unchanged | pass |

Zero unnamed interactive controls on any of the twelve surfaces, across 573
checked live nodes. Every icon-only control resolved a name through
`aria-label` rather than relying on a glyph — including the four "Collapse"
and "Expand" chevrons the enterprise tree renders.

## The update notice, when it is on screen

The read-state count of 25 on rules is measured on a page with **no** notice —
which is the correct state for a fresh arrival, and why the count dropped from
26 in the 02:35 pass. This run also measured a page where a notice *was*
showing, in the tab that had been left open across a peer save: its Dismiss
control resolves `aria-label="Dismiss"` on a ✕ glyph, so the control the
earlier count included was never unnamed — it simply should not have been
rendering on arrival.

New this pass, and the reason the log was re-run: the notice's **text** is now
derived at render rather than formatted once into state. That matters for a
screen-reader user for the same reason it matters for a sighted one — the
sentence "Updated by u-jonas just now" is an assertion about the present, and
it used to keep asserting it eight minutes later. It was watched ageing through
"just now" (7 s) → "2m ago" (2 min 27 s) → "5m ago" (5 min 40 s) → "9m ago"
(9 min 03 s) → "20m ago". The banner is not a live region, so nothing is
re-announced spuriously; it simply reads correctly whenever it is read.

## Document states — re-measured after the ageing fix

Measured on `/assessment/rules?doc=rule:scoring-guardrails.md` as u-jonas,
gateway unreachable, three states of the same page:

| state | controls | unnamed | previous pass (04:18) |
|---|---|---|---|
| read (document card, drawer closed) | **25** | 0 | 25 / 0 |
| edit (Edit pressed, drawer closed) | **28** | 0 | 28 / 0 |
| edit + Comments drawer open | **32** | 0 | 32 / 0 |

The three names that made this log fail at 02:00 all still resolve, read off
the live DOM in this pass:

1. **The body editor `<textarea>`** — `aria-label="Scoring Guardrails — document body"`,
   holding all 363 characters of the current document. Composed from the
   document title, so it identifies *which* document is being edited rather
   than announcing a generic "document body" on a surface where four explorer
   modes render the same editor.
2. **The "Version label (optional)" `<textarea>`** — `aria-label="Version label (optional)"`,
   alongside rather than instead of the grey hint text, so the name survives the
   field having content.
3. **The Comments drawer's message `<input>`** — `aria-label="Add a comment"`,
   applied by `useCommentComposerLabel` in `DocPane.tsx` with a
   `MutationObserver`, because `ChatPanel` (`ui-components/social`) exposes no
   prop that reaches that field's name and this repo cannot edit the library.
   It held across a drawer close and reopen again in this pass. The library gap
   is queued in `docs/ui-components-queue.md`.

A trap worth recording for anyone scripting this sweep: the editor renders
**two** textareas and the first in document order is the version-label field,
not the body. `document.querySelector('main textarea')` therefore returns a
zero-length value on a fully populated editor, which reads exactly like an
empty-editor regression. Select by `aria-label` — `main textarea[aria-label$="document body"]` —
or index from the end.

## Trees (enterprise / workspace / rules / prompts) — all four re-measured

| surface | `[role=tree]` | treeitems | `aria-level` | `aria-expanded` on directories | roving `tabindex="0"` | tree has `aria-label` |
|---|---|---|---|---|---|---|
| workspace | yes | 5 | all 5 (`1,2,2,2,1`) | 2 nodes, reading `true` and `false` | exactly 1 | **no** |
| rules | yes | 3 (flat) | all 3 | n/a — no directories | exactly 1 | **no** |
| prompts | yes | 9 (flat) | all 9 (`1`×9) | n/a — no directories | exactly 1 | **no** |
| enterprise | yes | 6 loaded, 10 expanded | all 6 (`1,2,2,1,1,1`) | all 4 directories — "Standards" `true`, Process/Organization/Tooling `false` | exactly 1 | **no** |

All four document-explorer surfaces implement real `tree`/`treeitem` semantics
with `aria-level` and correct roving tabindex, and both surfaces with nesting
toggle `aria-expanded` correctly. The roving pattern was re-checked rather than
assumed: on every rail exactly one row carries `tabindex="0"`, so the Tab order
contains one tree entry and the rest are reached with the arrow keys — which is
why the per-surface control counts in the role logs are larger than their
Tab-order counts and neither number is wrong.

The one gap is unchanged and applies to all four rails: no `[role=tree]`
container carries an `aria-label`, so a screen reader announces "tree" four
times with nothing to distinguish them. The section heading already rendered
above each rail ("ENTERPRISE CONTEXT · 10", "RULES · 3", "PROMPTS · 9",
"ENGINEERING SPACE (CONFLUENCE) · 5 · SYNCED") is the obvious
`aria-labelledby` target. Cosmetic severity — it costs orientation, not access.

## Master-detail rail (team-scorecard)

Unchanged from 02:35 and outside this fix's blast radius: the rail container is
`role="listbox"` with `aria-label="Dimensions"`, holding 17 `role="option"`
children, all 17 carrying both `aria-posinset` and `aria-setsize`, with exactly
one at `aria-selected="true"` at any time.

## Dialogs

| dialog | trigger | role / aria-modal | name source | focus on open | Escape closes | focus restored to trigger |
|---|---|---|---|---|---|---|
| New team | Dashboard → "+ New team" | `dialog` / `true` | `aria-label="New team"` | the Name input | yes | yes |
| N/A exceptions | Team scorecard → "Exceptions" | `dialog` / `true` | `aria-label="N/A exceptions"` | the "Close" button | yes | yes |
| How it was assessed | Team scorecard → "How it was assessed" | `dialog` / `true` | `aria-labelledby` → "How it was assessed" | its "Close" button | yes | yes |
| Command palette | ⌘K anywhere | `dialog` / `true` | `aria-label="Command palette"` | the search input | yes | yes |
| Comments drawer | any document card → "Comments" | `dialog` | resolved via its "Comments" heading | the composer input (`aria-label="Add a comment"`) | yes — re-verified this pass on rules, 1 dialog → 0 | yes |
| Version history | rules/enterprise document card → "History" | `dialog` | resolved via its "Version history" heading | its first Restore action | yes — re-verified this pass for lead-assessor, program-lead and admin, 1 → 0 each | yes |

Methodological note worth keeping, because it produced a false "fail" in an
earlier pass and would again: a JS `.click()` on a trigger does **not** focus
it the way a real mouse click does. Open a dialog that way and the modal
captures `BODY` as the element to restore, so focus appears to be dropped on
close. Focusing the trigger first — as any real interaction leaves it — gives
the correct hand-back. Every row above was measured that way. Two more harness
notes: a double-`requestAnimationFrame` wait never resolves in a background tab
here and hangs the evaluation outright, so focus readings use `setTimeout`; and
a synthetic Enter `keydown` does not activate an `<a>` or `<button>`, so
activation uses a real `.click()` on the focused element (a dispatched Escape
does work).

## Summary

Every interactive control the assessment tenant renders resolves an accessible
name, in all three document states: zero unnamed across 573 live read-state
nodes, zero in the edit state, zero with the comments drawer open. Alongside
that: a real `listbox`/`option` master-detail with full positional metadata,
real `tree`/`treeitem` semantics with `aria-level` and correct `aria-expanded`
on all four explorer surfaces, and six dialogs implementing the modal contract
correctly — labelled, focus in on open, focus back to the trigger on Escape.

The one gap stands, and it is the cosmetic one this log has carried since
2026-09-05: no `[role=tree]` container has an `aria-label`. It costs
orientation, not access.

The change since the last run is not in the counts, which are identical, but in
what the one time-bearing string on these surfaces says. A banner that reads
"just now" forever is a wrong statement rendered with a correct name — the
worst thing a sweep like this can pass. It now reads the real age whenever it
is read.

--- freshness re-observation, 2026-09-08 (the Lead cell) ---
Why: `portal/src/pages/assessment/dashboard/TeamList.tsx` changed, which moved this
log's `pages:` digest. The change is narrow and is the portal half of the
assessment wire-field correction: `TeamSummary.assessment_lead_person_id`,
`TeamDetail.assessment_lead_person_id` and `contributors[].person_id` were
deleted from `pages/assessment/types.ts` because the server sends none of them
(verified live across all 7 teams, and asserted absent by
`middleware/src/providers/__tests__/assessment-declared-fields.test.ts`). The two
places that read them therefore stopped wrapping the lead's name in `PersonRef`.
Nothing was lost by that: `PersonRef` was always being handed a null personId
here, and with a null id it returns its plain, NON-focusable branch before any of
its hover/pin machinery — and in this tenant it would refuse to link anyway
(`linkable = session?.tenant === 'orgiq'`). The lead was already a name, not a
control; it is now a name written as one.
Re-observed live at 1552px on `npm run dev:mock` (127.0.0.1:3011 behind a pinned
Vite proxy), signed in through /select as Asha Nair, Jonas Lindqvist, Farah Osei and Platform Operator in turn — all four gave the same numbers:
  - `/assessment/teams` (this surface): **12** visible, enabled controls in
    `<main>`, and a document-order `.focus()` sweep reached all 12 — exactly the
    12 this log's `keyboard:` line already records, unchanged.
  - `/assessment/teams?cohort=all` (the TeamList table this surface opens into):
    the Lead column renders plain text with **0** focusable controls per cell.
The em dash matters and was preserved deliberately: `assessment_lead` is the
empty string on TEAM-006 and TEAM-007, and `PersonRef`'s "no name" branch used to
render "—" for them. A bare data key would have left those cells blank, which
reads as a rendering fault rather than as "nobody yet", so the column keeps the
em dash the rest of this table uses for an empty. Verified: the seven Lead cells
read Dana Whitfield, Sam Okafor, —, —, Elena Marsh, Priya Natarajan, Jordan Lee,
and each one contains 0 focusable controls.
Console errors: 0 on both surfaces.

--- freshness re-observation, 2026-09-15 20:03 (the assessor's desk, dashboard/AssessorDesk.tsx) ---
Why: this sweep's `pages:` line is the whole assessment page tree, and the dashboard
was rebuilt (docs/assessment-ux-goal.md slice 1). Re-probed on /assessment/teams as
u-asha, Chrome innerWidth 1692:
  - the motion filter is one `role="group"` named "Assessment motion" (SegmentedControl)
    whose four buttons carry `aria-pressed` — true on "All motions", false on the other
    three; pressing one flips the attribute and writes `?cohort=`.
  - the program strip is `role="group"` named "Program summary" (StatStrip).
  - every table row has exactly one focusable control, the team-name `<button>` (7 of 7),
    so a keyboard user opens a team without a mouse; 31 tabbable controls, 31 accept focus.
  - the page `<h1>` "Assessor's desk" computes to 20px/600, the shared page-title rhythm.
  - the shell's SkipLink ("Skip to main content") is the document's first tab stop and
    moves focus to `#main-content` (tabIndex -1 on the content column — the one negative
    tabindex in `<main>`, by design).
  - one nit, not a failure: DataTable's `<th>` cells carry no `scope="col"`; queued in
    docs/ui-components-queue.md rather than patched here.
Console errors: 0.

--- freshness re-observation, 2026-09-15 20:10 (the question queue, FeedbackPage.tsx + useDimensionIndex.ts) ---
Why: slice 2 of docs/assessment-ux-goal.md rebuilt the Feedback page. Re-probed on
/assessment/feedback as u-asha, Chrome innerWidth 1692:
  - the two filter selects carry accessible names ("Status", "Team") and the search box a
    placeholder; 45 tabbable controls, 45 accept focus.
  - every table row has exactly one focusable control, the team-name `<button>` (25 of 25);
    Enter on it opens the Drawer, a `role="dialog"` named by its visible title (the
    dimension's name), focus moves inside it, and Escape closes it and returns focus to
    the same row button.
  - the status of a question is a StatusPill (text, not colour alone); the two tracks in the
    drawer are Chips whose text says "claimed L5" / "verified L3".
  - the queue summary is a `role="group"` named "Queue summary".
Console errors: 0.

--- freshness re-observation, 2026-09-15 20:16 (the portfolio heatmap, ReportsPage.tsx) ---
Why: slice 3 of docs/assessment-ux-goal.md rebuilt Reports. Re-probed on /assessment/reports
as u-asha, Chrome innerWidth 1692:
  - the heatmap is a real `<table>` (data-testid="maturity-heatmap") with a `<thead>` whose
    every `<th>` carries `scope="col"`; the seventeen dimension heads read as their numbers
    and carry the full dimension title in `title` and `abbr`, so a screen reader can expand
    "07" to "Testing & QE – Performance & Reliability Testing".
  - each level cell is a Chip whose text says the level ("L3", "N/A", "—"); the claim mark is
    a second Chip whose text is "↑5" with `title="claimed L5"` — the colour is never the only
    signal.
  - every row has one focusable control, the team-name `<button>` (7 of 7); the where-to-start
    table has one per row too (7); 31 tabbable controls, 31 accept focus. The Publish button
    is absent from the DOM for this role and present (first in the column) for a role that may.
Console errors: 0.

--- freshness re-observation, 2026-09-15 21:05 (portal/src/pages/assessment changed: scorecard slices 4 + 5) ---
Why: slices 4 and 5 of docs/assessment-ux-goal.md changed DimensionRow.tsx, TeamScorecard.tsx and
DimensionMasterDetail.tsx and added EvidenceCoverage.tsx + dimensionStandards.ts. Re-observed
live at 1692px as u-jonas (TEAM-002), u-farah (TEAM-001) and u-operator (TEAM-003):
  - each rail row's confidence line is the library DotMeter: `role="meter"` with
    aria-valuenow/min/max and an aria-label that reads the confidence word and, where the
    team claims higher, the claim ("low: 33%, claims L5") — the three dots are aria-hidden,
    so the meter is never colour-only.
  - the claim chip is text ("↑5") with a `title` that spells out "Team claims Level 5;
    verified to the badge level"; the row wrapper carries data-verified / data-claimed.
  - the evidence coverage strip is seventeen Chips whose text is the dimension number; each
    is wrapped in a Tooltip that names the dimension and its class in words ("07 Testing &
    QE – Performance & Reliability Testing — N/A: not applicable for this team"); the legend
    is a MetaLine ("Attested 1 · Documented 13 · Observed 1 · N/A 2"). The chips are not
    controls — selection stays on the listbox rail — so they add nothing to the tab order.
  - the repo names are real `<a target="_blank" rel="noopener noreferrer">` links; the
    "Measured against" line is one router link per pane. Document-order `.focus()` walk:
    36 of 36 reachable (TEAM-002, one repo), 37 of 37 (TEAM-001, two repos).
  - the MasterDetail listbox patch (role=option, aria-setsize 17, aria-posinset) still holds:
    the rows re-render with the new children and the MutationObserver re-applies the roles.
Console errors: 0 on every page.
Addendum 2026-09-15 21:20: one further change to DimensionRow.tsx / assessmentFormat.ts after the note above — a pending dimension shows no `role="meter"` (nothing rated yet) and counts as "Unassessed" in the coverage strip rather than "Attested"; re-observed on TEAM-003 (rows 09–17 badge-only, strip "Documented 8 · Unassessed 9"), 36 of 36 controls reachable, console errors 0.

--- freshness re-observation, 2026-09-16 00:12 (portal/src/pages/assessment changed: secondary-page findings from the audit fan-out) ---
Why: five Sonnet fix agents applied the read-only audit's findings; re-observed as u-asha on TEAM-001 (all five scorecard tabs), /assessment/submissions and /assessment/runs.
  - the dimension pane header's eyebrow and basis captions are SectionLabels (real text, 10px caps), its claim chip is text ("↑5") with a title that spells the claim out, and the header has no raw wrappers; the Improvement Plan's reveals are CollapsibleSection buttons with aria-expanded (four on TEAM-001) instead of ghost buttons toggling a bare block; the submissions selection bars are the library Toolbar (role=toolbar); the intake's repo "Use" buttons are real buttons that fill the URL field.
Console errors: 0.

--- freshness re-observation, 2026-09-16 01:50 (portal/src/pages/assessment changed: three Card lists → DataTable) ---
Why: the last three open audit findings for this tenant; re-observed as u-asha (/assessment/runs, /assessment/submissions, the wizard) and as u-operator (a knowledge doc's History).
  Three card lists became tables: the wizard's per-envelope link list, the Run-a-command panel and both revision-history drawers are DataTables (real <table>/<th> rows, one action control per row, Restore → confirm/cancel kept in-cell); nothing new enters the tab order beyond those row controls.
Console errors: 0.

--- freshness re-observation, 2026-09-16 06:40 (portal/src/pages/assessment changed: desk density) ---
Why: the innovation audit's no-new-field upgrades; re-observed as u-asha on /assessment/teams.
  The desk's Assessed cell is a `role="meter"` DotMeter with aria-valuenow and its "n/17" note as text; the Contributors avatars carry each person's name as their accessible label; nothing enters the tab order that did not before.
Console errors: 0.

--- freshness re-observation, 2026-09-16 07:30 (portal/src/pages/assessment changed: desk stepper) ---
Why: the last innovation-audit item for the desk; re-observed as u-asha on /assessment/teams and TEAM-001.
  The desk's Step cell is the WorkflowStepper (the active step carries aria-current="step", done steps a check glyph with text); the stepper scrolls horizontally inside a 160px cell — a keyboard user reaches the overflow by focusing the cell's scroll container. Nothing else in the tab order changed.
Console errors: 0.

--- freshness re-observation, 2026-09-16 09:10 (portal/src/pages/assessment changed: a11y + responsive pass) ---
Why: the screen-reader and narrow-width audits; re-observed as u-asha on TEAM-001 and the enterprise explorer.
  Heading order on the scorecard: the dimension title is an h2 (was h3) so the outline reads h1 → h2; the explorer rail narrows below 1280px.
Console errors: 0. Re-audit 2026-09-16 04:02: Read paths on Runs/Submissions/Reports/Feedback moved to useFetch with proper failed-read states (ErrorState/UnavailableNotice carry role=alert semantics from the library); no markup change on the surfaces themselves. Code-verified. Console errors 0. Re-audit 2026-09-16 05:40: Request-budget pass touched read paths only (Runs, Reports, Dashboard, Configuration, scorecard lazy panes); no markup or focus-order change. Code-verified. Console errors 0. Re-audit 2026-09-16 06:35: Write-path pass: DocPane errors are real server messages; the new ConfirmDialog on exceptions is the library dialog (focus trap, labelled buttons). Code-verified. Console errors 0. Re-audit 2026-09-16 08:05: DataTable rows are keyboard-reachable from the library itself at 2.275.1 (tabIndex, Enter/Space, aria-rowindex), so the per-table workarounds are retired; FormField no longer leaks labelId into the DOM, so the local wiring shim is gone. Code-verified. Console errors 0. Re-audit 2026-09-16 09:33: Loading pass: the shared route-level fallback and the session-bootstrap guards now render the library LoadingState, which announces itself; the bare text they replaced did not. Code-verified. Console errors 0. Re-audit 2026-09-16 10:30: Scale pass: tables paginate rather than rendering every row, and every truncation is announced in text rather than being silent. Code-verified. Console errors 0.

Re-audit 2026-09-16 13:26: `pages:` names the whole `portal/src/pages/assessment` tree, so this log staled on a change outside its actual scope. What changed: `dashboard/ImprovementPlan.tsx`, `dashboard/StoriesPanel.tsx`, `dashboard/EvidenceIntake.tsx` and `dashboard/ScoringLogsDrawer.tsx` gained an UnavailableNotice/InlineAlert branch for a genuine fetch error (previously that case rendered a misleading EmptyState). None of those four files is imported by the knowledge-explorer tree this log measures (`knowledge/DocPane.tsx`, `KnowledgeExplorer.tsx`, `ActivityBar.tsx`, `ExplorerFrame.tsx`, `KeyboardTreeView.tsx` — checked with a grep, zero references either direction), and the new branches render only on a request failure, which dev:mock does not produce, so the workspace/enterprise/rules/prompts control counts recorded above (25 read / 28 edit / 32 edit-plus-drawer, 0 unnamed) are unaffected. Not re-measured; recorded as out of scope for this fix rather than re-run for a no-op reason. Re-audit 2026-09-16: the Activity page now warns when the live feed reports a replay gap, with a 'Refresh the ledger' button. This page folds run.started/progress/completed/failed onto the ledger rather than re-reading it per event, so a dropped transition would leave a finished run rendering as running — the notice says so and the button re-reads the server state. Not visible in the healthy path observed here: the stream connected and every run row tracked its own launch through to completion, so no notice rendered; the Live pill and the table are unchanged. Console errors 0. Re-audit 2026-09-17: the certification heatmap now scrolls inside its own card instead of dragging the page. Observed live before the fix: scrolling right moved the breadcrumb, the Portfolio title, the whole stat strip and the Publish report button off to the left and clipped them, because the nineteen-column grid (Team + seventeen dimensions + Verified) overflowed with nothing containing it. After: only the grid moves and the Verified column is reachable; every piece of page chrome stays put. Same Card padding=none overflow-x-auto wrapper this tenant already used for the equally wide TeamScorecard grid. Console errors 0. Re-audit 2026-09-17: the headline count now says 24 open questions, matching the Assessor's-desk tile, where it used to say 25 and silently disagree. The extra row was an exception review — a decision the assessor approves or denies, not a question a team answers — and it now has its own 'Waiting on you · 1' tile plus an amber 'exception review' chip in a new KIND column, so it is visible rather than disguised as the twenty-fifth question. SHOWING still reads 25 open: the queue lists everything, only the headline is split. Console errors 0. Re-audit 2026-09-17: the 'Gateway offline — presence and co-editing via the BFF' warning no longer appears twice on one screen. It was rendered by the explorer's own status line AND again by the document header a hundred pixels below, both from the same gatewayOfflineHint() call — the connection is a property of the surface, not of whichever document is open, so only the surface's status line keeps it. The compact live dot beside the document title stays. Console errors 0. Re-audit 2026-09-17: "Add one" was an offer the reader might not be able to take. When a dimension has no enterprise standard mapped, the Measured-against line ends in a live link reading "Add one under Enterprise › standards →" — and it read that way for EVERY role. Adding or editing a doc under that folder needs `ManageKnowledge`, which the assessment Cedar seeds permit to lead-assessor and program-lead only (verified comment-stripped and permit-vs-forbid, because a plain grep counts a mention in a comment or a forbid block as a hold). The pane itself is mounted behind `ViewAssessment`, which all three roles have, so an assessor was handed a link promising an action the destination's own canEdit/canPublish then refuses. The link stays — an assessor CAN read the standards folder and that is worth reaching — and only the verb changes. Verified live on dimension 07, one of the four with no standard mapped (07, 14, 15, 17): as program-lead (`ManageKnowledge: true`) it still reads "Add one under Enterprise › standards →"; as assessor (`ManageKnowledge: false`) it reads "See Enterprise › standards →". This is the sixth instance of this defect class found in the app and the first on this tenant. Console errors 0. Re-audit 2026-09-17 20:10: The Step column no longer scrolls. It rendered the library `WorkflowStepper` capped at `w-40`, which put six labels in a 160px cell and let the CELL scroll horizontally to reach them — an all-but-undiscoverable scrollbar inside a table cell, with rows late in the ladder painting already-scrolled to "Publish · Follow-up" and no sign that earlier steps sat to the left. It is now a connected timeline (`dashboard/WorkflowTimeline.tsx`): the current step's name on one line, six dots beneath it on a connector — done filled with a check, current a ring, ahead an empty outline. Measured live at innerWidth 1600 as u-asha: 7 step cells, **0** that scroll, each 134px inside a 150px column, 6 dots per cell, and no page-level horizontal scroll. The seven current-step labels read Classify, Score, Intake, Intake, Score, Review, Publish. Labels still come from `buildWorkflowSteps` in middleware/src/providers/assessment.ts — the same server function the team-detail stepper reads — so desk and detail cannot drift. Dropping the visible labels did NOT drop them for assistive tech: each dot is `role="img"` with an aria-label ("Step 2 of 6: Classify, current step") and repeats it on hover. The filter row was ragged in the same pass — the SegmentedControl track, the status Select and the search Input measured 32/28/36px on three different top edges; the Input now takes `size="sm"`, so Select and Input are both 28px on top 267. The segmented track stays 32px (top 265): it is a padded wrapper and the library exposes no way to match it, so that 4px, and the selected segment's 1.05:1 contrast against its own track, are queued in docs/ui-components-queue.md rather than patched here. Keyboard: 15 focusable controls in `<main>`, all 15 reached by a document-order focus sweep (the dots are images, not stops, so the count is unchanged). First row at 346px. Console errors 0.

Re-audit 2026-09-17 22:35 — this surface had no `h1`, and neither did its three siblings. Enterprise, Workspace, Prompts and Rules are all one component (`knowledge/KnowledgeExplorer.tsx`) with a different `mode`, and it draws its own in-pane `Breadcrumbs` instead of a PageSection title block — so the document outline was empty on all four. Breadcrumbs is a nav landmark, not a heading, so a reader arriving by screen reader was told the page's name by nothing. The name already existed as `modeLabel`; it now also renders as the library's `VisuallyHidden as="h1"`, so the outline is correct and no chrome was added. Verified live on the isolated stack (middleware :3013 mock, Vite :5199) that each route reports its own heading — Enterprise / Workspace / Prompts / Rules — each measuring 0x0, with no horizontal scroll and no layout shift. Found by the clipped-text sweep in docs/orgiq-journeys/PROTOCOL.md, run across all 11 assessment routes; the other seven were clean. That sweep also flagged an "Add reaction" label on Prompts as clipped and inspection CLEARED it: it is `class="sr-only"`, 1x1 with `clip-path: inset(50%)`, doing exactly its job. The sweep now skips visually-hidden text for that reason.

Re-audit 2026-09-17 23:55 — `knowledge/DocPane.tsx` moved this log's digest, for two changes and one correction to the record. (1) `updated_at` came down on every document read and was used only to confirm this tab's own save — it was never shown. "When did this last change?" is the second question anyone asks of a document and the answer was already in hand; the meta line now carries it (`prompts/classify-transcript.md · Updated Aug 13, 2026`), through the shared `lib/relativeTime`. (2) The document card now takes `shadow-sm`. The library's `Card` paints no shadow and exposes no elevation prop, so a document sat as a hairline rectangle with nothing marking it as the thing you came to read — measured, this pane was the only content on screen and used 43% of the available height with 292px of dead space under it. Verified live: the card resolves `rgba(15,23,42,.05) 0 1px 1px, rgba(15,23,42,.05) 0 2px 6px` — the two-layer token, which also now has a night value. A `Card elevation` prop is queued so this stops being a per-call-site decision.

Correction to an assumption worth recording, because it was wrong in an interesting way: the Prompts rail looks impoverished — nine flat items, no nesting, no sync control — and that is the DATA, not the component. Read live from `/api/assessment/knowledge/tree`: `prompts`, `rules` and `enterprise_context` are `kind: 'local'` (they ship with the accelerator, no remote), while `confluence-eng` is `kind: 'synced'`. On Workspace, which renders that synced section, the same `TreeView` shows a real nested tree with expand/collapse carets (SDLC Assessment Program › Rubric Overview / Team Playbooks / FAQ), a **Pull** button, an Activity rail with a count, reactions and Comments. So nesting, expand/collapse and sync all exist and are offered exactly where a remote source exists. What genuinely does NOT exist: drag-and-drop reparenting (the library's `TreeView` has `onReorder`, but the middleware has no move endpoint — wiring it would lose the move on refresh) and inline rename (absent from the library entirely). Both queued. Re-audit 2026-09-18 01:30 — `knowledge/DocPane.tsx` moved this log's digest, for an error state that never said what went wrong. `assessment-knowledge-docs` had no `error` branch (the SECTIONS fixture beside it always did), so a failed tree read was auditable while a failed DOCUMENT read was not — the rail could report a failure and the pane it opens into could not be made to. With the branch added and pinned, the pane rendered a warning triangle, the document's NAME in red, and its id — and no sentence saying what had happened. Cause: `ErrorState`'s `body` and `description` are ALIASES for one slot (the `.d.ts` says so: "Alias for `body`"), this call site passed BOTH, and the id won, silently dropping "Couldn't load this document." A repo-wide sweep found this was the only call site passing both. It now reads title "Couldn't load this document" with the document and id as the body, which is also the shape every other error state in the app uses — a red document NAME reads as "this document is an error" rather than "we could not fetch it". Verified live. Console errors 0. Re-audit 2026-09-18 02:15 — the comments drawer, opened and used for the first time rather than read about. It is the library's `ChatPanel` (from `social`, not the unbuildable `doc-editor` subpath), and it was wired with almost none of what that component offers. Two fixes. (1) The panel could not answer "is this comment mine": `currentActor` — a legacy DISPLAY-NAME fallback whose own prop doc says "a display name is not an identity, and deciding ownership from it gave two participants named Alex a cancel button on each other's uploads" — was being handed the session `sub`, while `currentUserId`, the actual identity prop, was passed nothing. Swapped: `currentUserId` takes the sub, `currentActor` takes the display name. (2) The empty state read "No messages yet", which is both the bare default `emptyState` exists to replace (its prop doc says so outright) and the wrong noun on a document. It now names the document — "No comments on this document yet / Comments are attached to <title> and everyone with access to it sees them…" — verified live on Rubric Overview.

What is NOT wired, and why it is not a component gap: `ChatPanel` also offers `onReply` (threading), `reactionsFor`/`onToggleReaction`, `onEditMessage` and `onDeleteMessage`, each documented as "presence of this enables the control". `POST /api/assessment/knowledge/doc/comment` accepts `{ id, body }` and nothing else — no `parentId` for a reply to point at, no reaction table, no comment id to address for an edit or delete. Wiring those controls today would put affordances on screen the API cannot honour, so they stay off; the order is backend first, and the panel lights them up with no new component work. Written into docs/assessment-tenant.md. The composer still reads "Type a message…" — `ChatPanel` exposes no prop for that hint text, and the only escape is replacing the whole composer, so that one is queued rather than hand-rolled. Re-audit 2026-09-18 04:05 — the document header reads as a sheet now, not a data card. It used to put the classification INLINE after the title as a stock `info`-blue chip, so a label and a name shared one line and neither was the first thing read. The reference DocView this surface mirrors (~/Projects/agentic-assessment-accelerator, ui/src/components/knowledge/DocView.tsx) reads top-down: a tinted uppercase kicker saying what kind of thing this is, then a large title, then a rule, then the body. Same order here now, built by re-arranging library components — Chip's own `uppercase`, DetailHeader, Stack, Divider — not by hand-rolling a pill.

The kicker is tinted with the TENANT's brand rather than a stock tone, which is the part that makes it read as this product: measured live, background `rgb(220,237,234)` (`--color-brand-soft`) with `rgb(11,58,58)` text (`--color-brand-ink`, the SDLC deep base) at 10px/600 uppercase — **10.32:1**, comfortably AA, and it swaps per tenant and per theme because both are theme tokens. `ChipTone` has no `brand` member (neutral/success/warning/danger/info/caution/accent, and `accent` renders violet, which inside a teal tenant is another product's colour), so this took a `className` — queued, because a className fighting a `tone` prop is not a pattern other consumers should copy. Console errors 0.
re-observed 2026-09-18 (drag-and-drop landed): The explorer rail gained drag-and-drop reparenting. `TreeView` has carried `onReorder` ("Enables HTML5 drag-and-drop reorder/reparent when provided") and a `TreeNode.status` of 'pending' | 'moved' the whole time — what did not exist was anywhere to put the result, so no handler was passed and the tree was inert. POST /api/assessment/knowledge/doc/move is that place, and the host owns both edges of the optimistic window because the library is explicit that it cannot know when a server answered. The refusals are the substantive half: a move inside a SYNCED section (those mirror Confluence, so it would land nowhere real and the next pull would revert it), across sections (publish is the sanctioned way a doc leaves local), onto a leaf, or into the node's own subtree. A synced section is not given the handler at all — verified live, the confluence-eng rail reports 5 rows and 0 draggable — because a drop target that always 409s is worse than none. Refusals render the server's own sentence rather than "move failed"; each names something actionable. This role holds ManageKnowledge, so the affordance is present: measured as Farah Osei on /assessment/enterprise, all 6 local rows report draggable="true", and a real dragstart/dragover/drop sequence moved ec:standards/ci-cd-standards.md out of ec:standards and the tree refetched with the new parent — persisted server-side, not just repainted. Reset with POST /api/__mock/reset.
re-observed 2026-09-18 (rename landed): The explorer rail gained RENAME, alongside the drag-and-drop of the previous pass. This one is a genuine library gap rather than a missing route: `TreeViewProps` carries `onReorder` but no `onRename`, so a row cannot become an input in place without reimplementing the row. The affordance is therefore the library's own `renderTrailing` slot holding an `IconButton` into a `Modal` — library parts throughout, no hand-rolled row. A DropdownMenu was built first and then removed: one action does not justify making the reader open a menu to find it, and a pencil that opens a menu reads as "edit the document" rather than "rename". Queued in docs/ui-components-queue.md. The load-bearing decision is that a rename changes the TITLE and not the id: ids here look like paths and the doc, its versions, its comment channel and any shared URL all key off them, so renaming the id would break every one of those in the same motion. The dialog says so under the field. Refusals are the server's own sentence — a sibling clash names the sibling, a synced section names the remote that owns it. This role holds ManageKnowledge, so the control is present: measured as Farah Osei on /assessment/enterprise, 6 rows each carry a button labelled "Rename <title>". Driven end to end — opening it prefills the current title with the text selected; submitting a sibling's name is refused in place with "a sibling is already called …" and the dialog stays open; submitting "Security Baseline (2026)" closes it, and GET /knowledge/tree then reports that title with the id ec:standards/security-baseline.md unchanged. Reset with POST /api/__mock/reset.

re-observed 2026-09-18 (the real prompt documents landed): The nine prompt documents now carry the REAL command files from ~/Projects/agentic-assessment-accelerator/.claude/commands rather than a hand-written summary of each. This was the first line of the complaint that started this thread — "the workspace document contents are way off" — and it was accurate: classify-transcript rendered four lines of paraphrase where the real document is eighty, carrying its `## Input` contract, the file-format rules, seven precisely-defined output fields, an exact JSON schema, the `uv run -m sdlcd.main assess apply-classification` handoff and the strict validation the verb applies. Bodies went from 274-483 bytes to 1,985-13,623.

Putting the real content in immediately exposed two rendering bugs that a four-line stub could never have shown, both in the library and both now queued. (1) `MarkdownView`'s JSON highlighter corrupts its own output: it chains regex passes over accumulated HTML, and the pass that colours strings re-matches the quoted attribute value the pass that colours properties just wrote, so every JSON object rendered nested broken markup as literal text at the reader. Defused by stripping the language off ```json fences — colour lost, markup no longer printed. (2) A code block's Copy button is absolutely positioned over the code with no gutter reserved, so the long `apply-classification` line ran underneath it; the `pre` does scroll, but scrolling to the end still parked the tail under the button. Fixed by padding the inner `code` — padding on the `pre` does nothing, because a scroll container's padding is not added to its scrollWidth (measured: it stayed 924 against a client width of 896).
re-observed 2026-09-18 (the rubric stopped being an abridgement): the 17 dimensions were a TRUNCATED copy of the source rubric (~/Projects/agentic-assessment-accelerator/sdlcd/assessment/dimensions/rubric.yaml). 14 strings had been cut mid-sentence and closed with an ellipsis, and 280 of 552 key_characteristics entries were simply absent — 82 of the 102 lists were short. On the surface an assessor scores from, that is reading three of a level's four characteristics, where the missing line is often the qualifier that decides the level ("CI coverage across repositories remains inconsistent"). Re-ported verbatim: 1,539 list entries across key_characteristics / level_up_criteria / evidence_examples, zero drift against the source on every field, nothing ending in an ellipsis. `review_note` is deliberately not carried — it is an editorial note to the rubric's authors, not something an assessor scores against.
Restoring it exposed that the Improvement Plan could not show it. Two defects, both fixed: (1) the plan's "What Level N asks for" section was unreachable for every team on every dimension — the portal hardcoded `level_up_criteria: []` AND the recommendations response never carried the field, so both halves had to move; it now sends `next_level_criteria` from the same `criteriaToReach` lookup the dimension detail uses, and TEAM-005 dimension 1 renders "WHAT LEVEL 2 ASKS FOR" with the rubric's four real bullets. (2) "Why this is on the list" rendered its LABEL unconditionally while its body was gated, so every close_claim recommendation — which is every one of them, since the mapper sets `why: ''` — printed a heading with nothing under it. The mapper's own comment claimed "the card hides an empty why"; it does now.
