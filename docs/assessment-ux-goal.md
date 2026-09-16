# Goal: rebuild the assessor's cockpit on ui-components

Set with `/goal` on 2026-09-15 evening, from two screenshots as Asha Nair
(`u-asha`, assessor): the Feedback page (fifteen identical tall cards, one
per question, labelled "Dim 1") and the Dashboard (three motion cards over a
sparse roster). The brief: audit every assessment page, then make the UX
readable, dense and novel, on library composites, so it can carry a full
assessment and tie into the SDLC and the enterprise.

`scripts/validate-assessment-tenant.sh` stays the judge. This document adds
the UX definition of done the script now checks (section "assessor cockpit
UX"), and the journey logs under `docs/assessment-journeys/<role>/` are
re-audited for every surface a slice touches — the freshness check makes a
stale log a failing line.

## What the audit found (2026-09-15 19:40, every page as u-asha)

| surface | what a person sees | verdict |
|---|---|---|
| Dashboard `/assessment/teams` | three motion cards (2 teams · 2 verified) above a six-row roster whose rows are ~60px tall; certification is one "L3" pill with no claimed/verified split; "Follow-ups" is the only signal of work; cohort → team list is a second page for the same table | rebuild |
| Team scorecard `/teams/TEAM-002` | already MasterDetail + a WorkflowStepper; header strip repeats the certification; rail rows read "Low · L3" — confidence as a word, verified level only, the claim invisible until the pane; the pane says "Claimed Level 5 · Verified up to Level 3" in prose | refine |
| Submissions | StatStrip + DataTable; fine; "Add submissions →" is a link styled as the primary action | keep |
| Feedback `/assessment/feedback` | one Card per question, ~200px each: the same boilerplate sentence 25 times; "Dim 4" instead of the dimension's name; the answer form opens inline and pushes everything down; the only grouping is a bold team name | rebuild |
| Reports | four tiles, a by-cohort table, "Where to start" as full-width cards with three counts stuffed in the right margin; no view of the portfolio by dimension | rebuild |
| Enterprise / Workspace / Prompts / Rules | the three-pane explorer; fine | keep |
| Activity (`/runs`) | a run ledger; fine; the run id column is a 44-char code chip | keep |
| Configuration | read-only form for the assessor with a clear banner; fine | keep |

## Design stance

1. **Two tracks, everywhere a level is shown.** Claimed and verified are the
   product (`docs/assessment-tenant.md`, "two-track certification"). A cell
   that says "L3" hides the claim; a cell that says "L5 → L3" shows the gap
   that all the work is about.
2. **Every list answers "what do I do next".** The server already computes
   the three recommendation kinds (close the claim / advance the practice /
   answer the question). The dashboard row and the report row carry it.
3. **Table-first.** The table is above the fold; one filter row; StatStrips
   only where the numbers are the page (`feedback_table_first_density`).
4. **Library composites, no hand-rolled chrome.** DataTable, Drawer,
   StatStrip, SegmentedControl, Chip, DotMeter, MasterDetail, WorkflowStepper,
   Tabs, DetailSection, MetaLine. The tenant's discipline gate stays at 0
   raw `<div className>` / `<button>` / `style=`.
5. **SDLC and enterprise are data on the page, not links out.** A team's
   repos (`TeamDetail.repos`) anchor the evidence; a dimension names the
   enterprise standard it is measured against; Observed evidence is what
   a pipeline, dashboard or export proves.

## Slices (each: build → verify as every role → re-audit its logs → validate → commit)

1. **Assessor's desk** (Dashboard). One page: a StatStrip (teams · verified at
   target · claims open · questions open), a filter row (motion
   SegmentedControl · status · search) and a dense DataTable — team, motion,
   certification as claimed→verified with a claims-open count, workflow step,
   open questions, **next action**, updated. `?cohort=` still filters. The
   three-card landing and the separate per-cohort list page are gone.
2. **Question queue** (Feedback). A DataTable — team, dimension by name,
   question, raised by, age, status — with status and team filters, and a
   Drawer that holds the full question, the dimension's two tracks, the
   evidence on file, and Record answer / Dismiss / Add evidence.
3. **Portfolio** (Reports). A maturity **heatmap**: teams × 17 dimensions,
   each cell the verified level, a claim-open marker where the claim is
   higher, N/A greyed; by-cohort table; where-to-start as a DataTable with
   the kind as a Chip and the counts as columns.
4. **Scorecard refinements.** Rail rows show claimed→verified and a confidence
   DotMeter; the Certification tab gains an **evidence coverage** strip
   (Attested / Documented / Observed per dimension); the header names the
   team's repos.
5. **Enterprise tie-in.** Dimension detail names the enterprise standard it
   is measured against (Enterprise page documents), with a link into the
   explorer.

## Definition of done (the script checks these)

- Dashboard renders no cohort card grid and exactly one DataTable with a
  "Next action" column; `TeamList.tsx` and `CohortLanding.tsx` are gone.
- Feedback renders a DataTable and a Drawer, no per-question Card.
- Reports renders an element with `data-testid="maturity-heatmap"` whose
  cells carry `data-verified` and `data-claimed`.
- Scorecard rail rows carry `data-claimed` / `data-verified`.
- Every touched surface's journey logs are fresh for all four roles.
- Discipline zeros hold; tsc, node tests and the vite build pass.
