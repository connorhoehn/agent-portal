stretch item: accessibility sweep
role: lead-assessor
user: u-jonas
tenant: assessment
pages: portal/src/pages/assessment
audited: 2026-09-07 05:03 local, Chrome 1560x757, middleware dev:mock on 127.0.0.1:3011 behind the Vite proxy (`curl localhost:5183/api/health` → `{"service":"orgiq-middleware"}`) — re-run after the fix that stopped the cross-tab save notice freezing its age
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
Console errors: 0. Re-audit 2026-09-16 04:02: Read paths on Runs/Submissions/Reports/Feedback moved to useFetch with proper failed-read states (ErrorState/UnavailableNotice carry role=alert semantics from the library); no markup change on the surfaces themselves. Code-verified. Console errors 0. Re-audit 2026-09-16 05:40: Request-budget pass touched read paths only (Runs, Reports, Dashboard, Configuration, scorecard lazy panes); no markup or focus-order change. Code-verified. Console errors 0. Re-audit 2026-09-16 06:35: Write-path pass: DocPane errors are real server messages; the new ConfirmDialog on exceptions is the library dialog (focus trap, labelled buttons). Code-verified. Console errors 0. Re-audit 2026-09-16 08:05: DataTable rows are keyboard-reachable from the library itself at 2.275.1 (tabIndex, Enter/Space, aria-rowindex), so the per-table workarounds are retired; FormField no longer leaks labelId into the DOM, so the local wiring shim is gone. Code-verified. Console errors 0.
