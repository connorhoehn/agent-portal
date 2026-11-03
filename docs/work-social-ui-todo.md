# Work / Social UI continuation

Current checklist for this session, updated 2026-11-02. The dated reports below
retain historical evidence; this file carries the open work forward.

**Scope: local development only. The user explicitly said not to use AWS.**
Do not request credentials, run AWS checks or deploy as part of this work.

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

## Follow-up verification

- [x] Joined Chat transcript row profile and unstable live-state checks.
  Shared 36px message / 8px action anatomy is explicit and mutation-tested;
  final deep audit passes 33 cases in both themes at 900/1440px.
- [x] Reusable source/installed-package audit extracted to ui-components.
  Same-tree output parity, source fixtures and installed archive checks pass;
  app route, tenant and ratchet policies remain local.
- [x] Inbox consult and review action vocabulary follows existing capabilities.
  DispatchAgentRun answers consults; ManageDevbox reviews queue actions. Role
  tests pass; backend permissions are unchanged.
- [x] Canonical design identities in the active provider and fixtures. Signed
  authors/signers retain IDs; grouping and portraits never infer identity from
  a name. Additive SQL columns are prepared.
- [x] **PEOPLE-03 — local portraits:** all 80 locally served asset hashes pass.
  A prepared ID-only migration for 59 people and 12 unlinked accounts passes
  disposable PostgreSQL preservation/idempotence tests and remains unapplied.
  AWS work is excluded by the user's instruction. Assessment contributor JSON
  has no canonical IDs and remains documented identity debt.
- [x] Profile the large entry bundle without changing warning thresholds.
  Initial script: 4,485,082 bytes; gzip 1,345,718 bytes. Terminal, graph, document
  editor and camera-effects imports are candidate split points.
- [x] Refresh affected journey seals after final UI revisions. All 26 affected
  walks pass and are sealed: Search, Decisions and Sprints across five roles,
  plus eleven runbook journeys. Rail/cascade/type measurements share the same
  current source digest. Separate Assessment breadcrumb failures stay visible.
- [x] Live two-client gallery acceptance passes with real local media transport,
  synthetic camera/microphone devices and isolated cloned users. Covers audio/
  video delivery, camera transitions, right sidebar and bounded gallery sizes.
  Shared-screen presentation remains a distinct follow-up.


See [the continuation verification](work-social-ui-verification-2026-11-02.md)
for exact local evidence and limits. The local UI checklist is complete;
the follow-ups below remain explicitly open.

## Retained technical debt

These are recorded follow-ups, outside the completed local UI changes. They do
not authorize cloud work.

- [ ] The durable Design provider is not wired. Historical rows need trusted
  canonical IDs; unlinked signers need a schema representation before migration.
- [ ] Assessment contributor JSON lacks canonical IDs. Its separate in-progress
  UI work also has three missing-breadcrumb findings; preserve that ownership.
- [ ] Split the measured large entry bundle at appropriate terminal, graph,
  document-editor and camera-effects boundaries; keep warning thresholds intact.
- [ ] Extend gallery acceptance to shared screens, WAN reconnects and real
  hardware permissions.
- [ ] Refresh the 66 stale historical Work journey logs after their corresponding
  changes settle and map the missing `orgiq:admin` role. Targeted seals do not
  certify the entire 125-journey catalog.
- [ ] Integrate the shared audit packaging [source PR](https://github.com/connorhoehnslalom/ui-components/pull/1)
  alongside the other session's composer release. This app pins the independently
  verified archive that already contains the skill.

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

- [Continuation verification](work-social-ui-verification-2026-11-02.md)
- [Work UI findings](work-ui-followup-2026-11-02.md)
- [Document reading and retained debt](ui-document-reading-2026-11-01.md)
- [Runbook review audit closure](runbook-review-followup-2026-11-02.md)
- [Scoped Search and shared focus validation](scoped-search-2026-11-02.md)
- [Portrait and row alignment coverage](initiative-avatar-followup-2026-11-02.md)
- [Work list consistency and transcript candidates](work-list-consistency-2026-11-02.md)
- [Audit ownership decision](ui-audit-ownership-2026-11-02.md)
- [Composer/gallery validation](composer-gallery-2026-11-02.md)
- [Social collection validation](social-collection-controls-2026-11-02.md)

The app currently pins ui-components 2.499.7-audit.0. Fix shared behavior in the library,
verify the packed distribution and rendered app, record exact remaining findings,
and commit/push only this session's changes. Other work in the shared checkout
remains independently owned.

[Claude Code handoff](claude-code-handoff-2026-11-02-ui.md) carries the current
architecture, local verification limits and retained debt.
