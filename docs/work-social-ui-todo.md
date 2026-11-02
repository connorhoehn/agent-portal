# Work / Social UI continuation

Current checklist for this session, updated 2026-11-02. The dated reports below
retain historical evidence; this file carries the open work forward.

## Active work

- [x] **WORK-UI-04 — scoped workspace organization.** The Workspace entry on a
  project work item opens `/iq/search?scope=p-llm-platform`, which stacks People,
  Work and successive content sections. Check the entry point and replace the
  concatenated layout with a focused workspace and clear content-type navigation.
  Verified populated, empty and narrow views and preserved the initiative scope.
  One collection per view, ranked All results, and terminal people in scope
  expansion; [validation](scoped-search-2026-11-02.md).
- [x] **WORK-UI-01 / DOC-AUDIT-03 — keyboard focus.** Repair the shared command
  composer's visible focus treatment. Verify compact and ordinary composers on
  Runs, Designs and Decisions with actual keyboard focus walks.
  Fixed in ui-components 2.499.1; actual Tab walks pass before/after typing in
  both themes on all three pages.
- [x] **WORK-UI-02 — selected navigation count contrast.** Fix the shared rail
  count against the selected surface; retain the 4.5:1 requirement and check both
  themes plus selected/unselected states.
  Fixed in ui-components 2.499.1; Findings passes all four light/dark 1440/900px
  rest cases, and the scoped Search deep audit also passes selected rail counts.
- [x] **DOC-AUDIT-02 — command-help alignment.** Reproduce the four 4px runbook
  command-help findings, repair the owner if still present and rerun the audit.
  Closed: shared composer inset profile and runbook spacing repairs; 25 deep
  cases pass with zero findings on ui-components 2.499.4.
- [x] **DOC-AUDIT-01 — proposal/code-diff review.** Separate code-diff geometry
  from ordinary collection tables using an evidenced shared profile and mutation
  fixtures. Repair actual contrast, control and prose issues; rerun proposals.
  Closed: 24 deep cases pass with zero findings; delayed library lookup also
  waits before revealing the contents, preventing a measured section-list jump.
  [Validation and ownership](runbook-review-followup-2026-11-02.md).

## Remaining follow-ups

- [ ] Review the joined Chat transcript's 36px message and 8px action insets;
  define its intended shared row profile before changing spacing or audit rules.
  Reproduce the two unstable live-state measurements with isolated input.
- [ ] Extract reusable source/installed-package audit logic to ui-components;
  keep route, tenant and ratchet policies in this app's adapter.
- [ ] Reconcile inbox ManageDevbox and consult DispatchAgentRun authorization
  vocabulary with role coverage; do not change permissions as a styling fix.
- [ ] Persist canonical IDs for legacy design authors/sign-offs before broadening
  portrait resolution. Missing photos must not borrow a namesake's portrait.
- [ ] Deploy canonical-ID avatar backfills and verify hosted assets on the deploy
  machine. Local fixture coverage is complete; deployment is not claimed.
- [ ] Profile the large entry bundle and refresh affected journey seals after
  final UI revisions. Preserve the existing warning and acceptance thresholds.
- [ ] Validate the gallery with a live multi-client media call; shared-screen
  presentation remains a distinct follow-up to the bounded participant gallery.

## Delivered in this conversation

- [x] Resizable/aligned Work record rails, concise breadcrumbs and right-side
  Design information; exact Today question navigation; compact recorded run
  timing and organized Findings views.
- [x] Initiative search/dividers and empty-state spacing; identity-based portrait
  propagation; aligned Overview, Needs attention, Recent activity and Work rows.
- [x] In-document contents, numbered sections, document typography and section
  navigation for Briefs/runbooks; dedicated Brief preview.
- [x] Composer collapse/expand with retained drafts; bounded hangout gallery and
  right People/Conversation sidebar.
- [x] Contextual Social navigation, compact Calls filters and Contacts headers;
  shared checks for intrinsic filters and query-adjacent Refresh controls.

## Evidence and ownership

- [Work UI findings](work-ui-followup-2026-11-02.md)
- [Document reading and retained debt](ui-document-reading-2026-11-01.md)
- [Runbook review audit closure](runbook-review-followup-2026-11-02.md)
- [Scoped Search and shared focus validation](scoped-search-2026-11-02.md)
- [Portrait and row alignment coverage](initiative-avatar-followup-2026-11-02.md)
- [Work list consistency and transcript candidates](work-list-consistency-2026-11-02.md)
- [Audit ownership decision](ui-audit-ownership-2026-11-02.md)
- [Composer/gallery validation](composer-gallery-2026-11-02.md)
- [Social collection validation](social-collection-controls-2026-11-02.md)

The app currently pins ui-components 2.499.4. Fix shared behavior in the library,
verify the packed distribution and rendered app, record exact remaining findings,
and commit/push only this session's changes. Other work in the shared checkout
remains independently owned.
