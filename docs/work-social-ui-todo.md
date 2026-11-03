# Work / Social UI continuation

Current checklist for this session, updated 2026-11-02. The dated reports below
retain historical evidence; this file carries the open work forward.

**Scope: local development only. The user explicitly said not to use AWS.**
Do not request credentials, run AWS checks or deploy as part of this work.

## Active work

- [x] **WORK-UI-07 — composer inner focus ring (2026-11-03).** Library
  2.500.1 (`e6d7d5a3`) painted a 2 px primary outline inside the message
  editor on focus (`.chat-composer .chat-composer-input:focus-visible`), a
  second box under the composer's own rounded focus surface with the text
  crowded inside it, in every tenant and in the storymaker studio. Library
  2.500.2 (`e6536351`, another session) scopes the rule away from
  RichChatComposer (`:not([data-composer-size])`, and the attribute is always
  set); the portal reached it with the 2.500.3-work.2 prerelease pin (Vite
  cache cleared, portal re-triggered). The storymaker studio already pins
  2.500.2, so a stale `node_modules/.vite` there is the only way it still
  shows. No portal CSS was added; the fix is the library's.
- [x] **WORK-UI-06 — Initiative tab panels and Details pane (2026-11-02, later).**
  A tab names its panel, so the Agents panel dropped its repeated "Agents"
  heading and opens on one row: Runs/Bots/Compute and the window switches,
  the spend/repo meta and the bots action at the far end, then the table. The
  initiative pane's title is the initiative on its own tabs (Discussion, Agent,
  Details) and the record kind on a record tab; "Initiative details" over a
  Details tab is gone. Details is compact: summary (three-line clamp), Sprint /
  Owner / SMEs on wrapping lines (Status is the header's badge), one work
  action whose title is the link, and no Docs / Activity buttons (the page's
  own tabs). `portal/e2e/initiative-agents-pane-compact.spec.ts` walks both
  themes as a clone; evidence `.scratch/initiative-redesign-2026-11-02/`.
- [x] **WORK-UI-05 — Connections controls and person inspector.** Replace the
  nested graph card with the shell's right pane; remove duplicate person copy
  and single-selection Ask actions. Relationship/team facets stay compact,
  Force/Radial stays beside the canvas, and advanced sliders live in settings.
  [Design and verification](connections-layout-2026-11-02.md).
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

- [~] **WORK-DOCS-01 — create a document in an initiative (2026-11-02, slice 1).**
  Work had no document-creation path (the Discussion's /doc Save answered
  409). Now: `work_documents` (schema/work_documents_schema.sql, additive,
  unapplied) with a mock fixture; `GET/POST /api/graph/projects/:id/workspace-documents`,
  `GET/PUT /api/graph/documents/:id` for a page (DispatchAgentRun + initiative
  scope to write); the Docs tab's **New ▾** (Document → an Untitled page that
  opens at once; Presentation → the status-deck dialog); the page renders
  Markdown and a steward writes title/body on it (explicit Save). Jest 3/3,
  Playwright `initiative-files-new-document.spec.ts` 3/3 in both themes inside
  a scoped mock world; evidence `.scratch/work-documents-2026-11-02/`.
  2026-11-03: the Discussion's `/doc` "Save as document" saves into this
  store (orgiq is a `document` save target; the page must belong to the
  discussion's initiative, DispatchAgentRun required), the thread opens an
  announced page on `/iq/documents/:id`; `initiative-doc-save.spec.ts` walks
  it as a clone (jest 44/44 on the tenant artifact suite).
  2026-11-03, whiteboard: **New ▾ Whiteboard** creates a `kind: 'whiteboard'`
  page that opens on the library's Excalidraw canvas (ui-components `/diagram`
  `CollaborativeExcalidraw` in its hosted form over a page-owned Y.Doc; the
  `@excalidraw/excalidraw` 0.18.1 peer is now installed and pre-bundled with the
  realtime Excalidraw adapter in `vite.config.ts`). Strokes save explicitly as
  one base64 Yjs update in `work_documents.scene` (PUT `scene`, 2 MB cap) and
  reload; readers get view mode. One author at a time until the live Y.Doc.
  The whiteboard walk draws a rectangle, saves, reloads and renames it.
  Cloud readiness: `work_documents_schema.sql` is a repeatable manifest entry
  (after `work_item_documents_schema`, also in `seed_run`), the update SQL
  binds strings only, and `work-documents-workspace-postgres.test.ts` runs the
  migration and provider SQL in the labelled disposable PostgreSQL
  (`REAL_WORK_DOCUMENTS_POSTGRES=1`, container
  `orgiq-work-documents-postgres-acceptance`): 8/8 with the link suite. Aurora
  application remains a deploy step (no AWS in this work).
  2026-11-03, page chrome (user review of the whiteboard page): the title
  renames in place from the heading (library `EditableHeading` as the page's
  h1 with `revealOnHover`: the pencil shows on hover or keyboard focus; Enter
  commits), saves are background checkpoints 1.5 s after the last edit with a
  flush on Done / page hide / leaving (no Save button; the library's
  `DocumentSaveStatus` line reads Saving… / Saved / Changes not saved + Retry),
  the whiteboard stage goes full screen through the library's new
  `FullscreenToggle` over `useFullscreen` (Escape or the same button leaves),
  and the meta line sits under the canvas / body instead of between the title
  and the content. Library source commits `c799db44` + `e078dfb8` (ui-components
  main, 2.500.3 changelog section, 11 tests); the portal pins the prerelease
  `2.500.3-work.2` built from a clean archive of `e078dfb8` until the 2.500.3
  release commit exists. `initiative-files-new-document.spec.ts` now walks the
  rename, the checkpoint, full screen and the meta placement (5/5 with the
  member refusal; `initiative-doc-save.spec.ts` 1/1).
  Next slices: the live
  collaborative canvas (generalise `connectDocumentCanvas` from assessment to
  orgiq and mount EditorShell on `/iq/documents/:id`); list these pages in the
  Discussion's Files view; author names on pages (ids today). Creation and
  editing stay behind DispatchAgentRun like the Discussion's comment route, so
  a plain member (the cookie-less demo identity) sees no New ▾ and no pencil;
  opening the store to members is a user decision, not taken.

## Retained technical debt

These are recorded follow-ups, outside the completed local UI changes. They do
not authorize cloud work.

- [x] Fix the shared accent SegmentedControl's dark-theme selected-label contrast
  (4.13:1 in the Connections proposal). ui-components `260e75d6` (2.500.1) paints
  the chosen accent segment with `text-primary-fg` (7.30:1 dark, 4.55:1 light);
  the app pins 2.500.1 and the Connections checks were re-run on it
  ([evidence](connections-layout-2026-11-02.md)).
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
- [x] Integrate the shared audit packaging [source PR](https://github.com/connorhoehnslalom/ui-components/pull/1)
  alongside the other session's composer release: applied to library main as
  `54f0cfa4` under the 2.500.0 build; the pinned 2.500.1 archive ships the skill.
- [x] The initiative journey (five roles) was re-walked on 2026-11-02 after the
  panel/pane redesign and failed on one audit finding at every step; on
  2026-11-03 that finding is owned in `docs/journeys/audit-burndown.tsv`
  (library contract conflict, below), the map's Docs-tab expectation moved
  from "Workspace" to the files toolbar's "Search initiative", and all five
  walks pass. Original finding:
  the Discussion composer's recipient trigger (`…:discussion-recipient`, the
  library `ConversationComposer`'s small default Select) paints 28px right
  padding against the skill's own `control.select-inset-field-sm` profile (6px).
  The library's dist is byte-equivalent across the 2.499.7-audit.0 → 2.500.1
  move and no app class touches it, so this is a library contract conflict
  (fix the composer trigger or the contract upstream); the logs are kept as
  failing walks, not sealed. The five Search walks pass and are sealed.
- [ ] Of twelve pre-existing Playwright failures in the initiative area
  (observed 2026-11-02 after the shared-checkout commit `da67f854`), the stale
  expectations were repaired on 2026-11-03: `initiative-details-pane.spec.ts`
  (the info action opens the pane directly, no hover card; Workspace documents
  is the page's Docs tab; an open dialogue folds the primary rail; a member's
  read-only column has no editor) and `initiative-header-agents.spec.ts`
  (bot missions list last, "No work item"; the meta row may wrap). Both files
  now pass except two cases left as found: the four-pane header expects the
  Search link hidden at that width (header density is another session's) and
  the gap sweep times out clicking a work item's Brief tab. Still open and not
  mine: `pane-header.spec.ts` (the Conversation views Files switch and first
  chat message never appear — the realtime receipts were also unconfirmed in
  the composer that night) and `work-layout-refinement.spec.ts` (Decisions
  list rail 320 vs 264).

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

The app currently pins ui-components 2.500.1. Fix shared behavior in the library,
verify the packed distribution and rendered app, record exact remaining findings,
and commit/push only this session's changes. Other work in the shared checkout
remains independently owned.

[Claude Code handoff](claude-code-handoff-2026-11-02-ui.md) carries the current
architecture, local verification limits and retained debt.
