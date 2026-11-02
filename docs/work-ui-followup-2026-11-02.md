# Work UI follow-up

## Delivered behavior

- Today uses the provider's pending question and an explicit internal action.
  **Open question** routes to `/iq/work?consult=<id>` and opens that exact prompt,
  including questions outside the first pending page. Answered/expired links
  explain their state. Runs and budgets have their own destinations; categories
  without an action do not invent a generic workspace link.
- Run timing sits below the title, before the summary tabs. The shared
  WorkflowStepper draws a compact connected track with recorded timestamps.
  Queue `done`, failed, cancelled, skipped, live and review states are distinct;
  missing milestones say Not recorded/Not yet. Tools belong under Outputs;
  unavailable activity is explained in Activity. Technical details are visible.
- Findings is the initial view; failed runs have their own URL-backed tab
  (`?view=failed`). Status filters sit above the grouped findings. Primary text
  uses the shared 14px scale, descriptions wrap, and actions move below the text
  in narrow columns. Table audits target the failed-runs view explicitly.
- Designs/Decisions use a wider, resizable 320px record rail with aligned group
  and row text. The existing shell folds the primary navigation on deep records;
  opening the details pane folds the list temporarily, and its toggle can restore
  it. Design initiative context, affected initiatives, people and gates live in
  the shell's right information pane instead of inside the discussion.
- Shared breadcrumbs stay on one line with ellipsis and full accessible labels.
  Designs no longer repeats Design / Designs / All designs. The shared audit
  rejects adjacent duplicate levels, wrapped trails and silent text clipping.

Shared owner: ui-components 2.490.0, installed from its packed archive. Storybook
covers compact/failed timing, record-rail alignment, narrow breadcrumbs,
standalone information sections and stable segmented tabs.

## Verification

Evidence is retained in `.scratch/today-timing-2026-11-02/`. Browser checks use
isolated cloned sessions and block business writes; no jobs, findings, questions,
design approvals or AWS resources were changed by those checks.

- Shared source/demo type checks and build pass; 11,267 tests pass, 2 are skipped.
- Portal: 1,827 unit tests pass; production build and component-discipline checks pass.
- Middleware: all 3 Today route tests and the type check pass.
- Live browser checks cover exact-question navigation, recorded timing, all
  four connected milestones, visible technical details, Findings tab behavior,
  Design details, rail alignment and page containment in light/dark at 900/1440.
- The audit skill's mutation fixtures and skill validator pass. All 11 route
  selection/inventory checks pass, including table-specific query views.
- Two Storybook browser cases cover the shared components in both themes; nine
  live application/browser cases pass. The final two Today/timing cases were
  rerun after adding out-of-page and already-answered question checks and pass.
  Theme activation is explicitly asserted.

The strict deep-audit sweeps report no resting-state failures and no
unclassified composer policies: 17 Run cases retain one focus finding, 26
Design cases retain one focus finding, and 25 Findings cases retain 17 instances
of the same navigation-count contrast finding. Reports are
`audit-run-verified/`, `audit-design-final/`, and
`audit-findings-final-confirmed/` under the evidence directory. These sweeps
remain nonzero until the debt below is repaired.

These checks do not refresh journey seals or verify deployed AWS behavior.
The earlier backlog and deploy-machine obligations remain separate.

## Initiative spacing follow-up

The initiative rail now places search first, separates search, views and results
with the shared Divider, and uses the same order on list and record routes.
The My initiatives empty state no longer adds 36px on top of the pane's standard
20px inset. The All initiatives breadcrumb also stops repeating the collection
level; returning from a record still preserves list filters.

Evidence: `.scratch/initiative-spacing-2026-11-02/`. Direct browser measurements
cover My initiatives in light/dark at 1440/900px: the empty-state gap is 20px,
search precedes the view links, and both section dividers are visible. Search
and navigation through the populated list to a record were also verified.
The seven navigation tests, portal type check and component-discipline gate pass.
The final strict deep audit (`audit-final/`) covers 32 Initiatives cases with
zero findings and no unclassified composer policies; the initial report is
retained in `audit/` and records the 24 duplicate-breadcrumb instances resolved.
These are app composition changes using existing library APIs; no new library
release or Storybook variant is required. Existing debt below remains open.

## Technical debt

- **WORK-UI-01 — composer focus indicator.** Run and Designs deep audits retain
  the existing keyboard-focus finding on their contenteditable command inputs.
  This extends DOC-AUDIT-03 in `ui-document-reading-2026-11-01.md`; repair the
  shared focus treatment and verify both compact and ordinary composers.
- **WORK-UI-02 — active navigation count contrast.** The Findings navigation
  count measures 4.46:1 in light mode against the selected tint, below 4.5:1.
  Fix the shared rail count token and verify neighboring selected/unselected
  states; the threshold has not been relaxed.
- **WORK-UI-03 — consult authorization vocabulary.** The inbox's existing
  ManageDevbox gate/read-only explanation differs from the consult API's
  DispatchAgentRun permission. This change preserves those authorization rules;
  reconcile them separately with role coverage.
- **UI-AUDIT-OWNERSHIP-01 — source-check extraction.** The reusable AST and
  package verification rules should move into ui-components with a consumer
  adapter. See `ui-audit-ownership-2026-11-02.md` for the reviewed boundary.
- Existing document audit debt, legacy name-only design authors, deployed avatar
  backfill, large portal bundle and journey freshness work remain open in the
  earlier handoff. A clean resting layout is not a clean whole application audit.
