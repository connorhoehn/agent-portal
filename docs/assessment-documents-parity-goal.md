# Goal: assessment document pages use the same editor as realtime-examples' `/documents`

`scripts/validate-assessment-documents-parity.sh` is the only judge
(`--quick` skips middleware jest and the Playwright journey). Run it after
every slice and treat each failing line as the next task. The plan and its
gap table are in [assessment-documents-parity-plan.md](assessment-documents-parity-plan.md);
this file is the definition of done and the backlog.

The user's requirement (2026-09-29): the assessment workspace page
(`/assessment/workspace?doc=page%3A100002`) "needs to have the same type of
document editor as http://localhost:15174/documents and they should all look
the same with the same ui-components and layouts and backend style of
`/documents/<id>?type=Meeting+Notes`".

Rules every goal carries apply: no hand-rolled HTML in pages; a primitive the
library lacks goes into ui-components first; build to the middleware's
response shapes; the accelerator's navigation / draft / publish UX survives
(the plan's gap 15).

## Shipped (asserted by the validator)

### Phase 0 — the real editor shows up locally

- `scripts/social-documents.mjs` keeps a local Ed25519 grant key pair in
  `.scratch/social-documents/` and starts the `social` profile's Redis,
  DynamoDB, gateway (:28080) and platform-api (:23001) with the **public** key,
  tenant, issuer, policy secret and the middleware's session-epoch callback.
- `docker-compose.yml`: `social-gateway` and `social-platform-api` take
  `DOCUMENT_TENANT_ID / GRANT_ISSUER / GRANT_KEY_ID / GRANT_PUBLIC_KEY /
  SESSION_EPOCH_URL / POLICY_SECRET` from `SOCIAL_DOCUMENT_*` (empty by
  default, so the calls profile is unchanged) and reach the host through
  `host.docker.internal`.
- `cd middleware && npm run dev:mock:social` is `dev:mock` plus
  `DOCUMENT_GRANT_ISSUER/PRIVATE_KEY/KEY_ID`, `DOCUMENT_POLICY_SECRET`,
  `DOCUMENT_GATEWAY_PUBLIC_URL`/`INTERNAL_URL` and
  `DOCUMENT_PLATFORM_INTERNAL_URL=http://127.0.0.1:23001`. No middleware
  source changed.
- Guide: [social-calls-local-stack.md](social-calls-local-stack.md), "Assessment
  documents on this profile". Exit condition met: `POST
  /api/assessment/knowledge/canvas` for `page:100002` returns a grant, the
  workflow lifecycle proxies through, and the page renders `CanvasDocumentView`.

### Phase 1 — same frame (portal only, no storage change)

- `knowledge/DocumentShell.tsx` frames every document state — connecting, live
  canvas, reader fallback — in the library `EditorShell` (`/doc-editor`): kind
  mark, title, lifecycle pill, the page's path inline ("Documents / SDLC
  Assessment Program"), save state, and tabs **Editor / Comments / Versions /
  History / Reviews**. Versions and Reviews are disabled (not hidden) while the
  collaborative workspace is unavailable.
- Head actions are the shared `DocumentHeader` as `variant="actions"`,
  `actionsLayout="menu"` (the example's "… ⋯" head; owner, mode and lifecycle
  actions live in ⋯). The accelerator actions stay as `workflowActions`: the
  Synced / Local draft chip, Take ownership, Review & publish
  (`SourcePublishControl`), Edit draft / Done editing. Lifecycle errors render
  through `WorkspaceDocumentHeaderNotices` above the page.
- The canvas is the shell surface with the example's settings: toolbar as the
  white card, ruler on, zoom in the toolbar overflow (no status bar), narrow
  page margin, `fitHeight="parent"`.
- Comments tab: the existing BFF thread + document reactions. Versions tab:
  `VersionHistoryPanel` over the gateway (save / preview / restore unchanged).
  History tab: `DocumentActivityFeed`, the same persisted section activity the
  rail's Activity panel reads — not an in-memory bus. Reviews tab:
  `DocumentReviewPanel`.
- `ExplorerLayout` + `ContextColumn` stay, with Outline and Activity only;
  "Show outline" is a ⋯ menu item.
- Preserved: per-source sections, Pull, New page / child draft, drag of
  synced pages through the source adapter, local draft → preview diff →
  explicit Publish, prompts read-only.
- Journey: `portal/e2e/assessment-documents-parity.spec.ts` (u-farah, who
  lands as lead-assessor — no tenant/role switch) at 1672×941; screenshots
  `docs/design/documents-parity/parity-journey-*.png`.

### Versions tab docked

- `DocumentHistory.tsx` passes `docked` to the library `VersionHistoryPanel`
  (ui-components 2.407.16+, verified against the installed `doc-editor.d.ts`),
  so the Versions tab fills the tab instead of sliding in over the window.

### Phase 3 — same rail and list (gaps 9, 10, 12)

- **Rail** (`knowledge/DocumentRail.tsx`, composed as realtime-examples'
  `explorer/DocumentExplorer.tsx`): the frame's rail header is the library's
  `label` heading — "DOCUMENTS 5" (`ExplorerLayout railHeading="label"` +
  `railCount`, i.e. `WorkspaceRail heading="label"`, the 11px rail-group
  scale since 2.407.13) — with `+` New page and a ⋯ (All documents, Refresh
  library). Under it the plain `ConversationShelf size="rail"` views **All
  documents / Recent / Shared with me**, then ONE `TreeView size="rail"` whose
  root rows are the **sources as folders** (Workspace drafts, Engineering Space
  (Confluence), …) with their document count, every page carrying the page
  glyph and a compact age ("9d"). Enterprise / Rules / Prompts use the same
  rail under their own label.
- Accelerator behaviour rides the folder rows: the folder's ⋯ holds **New
  page** (local) and **Pull now** (synced); its trailing slot holds the
  section's **presence** (`PresenceAvatars` over `usePresence`) and the
  **Pull** control, which marks the folder `pending` while a pull is in
  flight and reports a refusal or a silent pull as a rail `Banner`. A page's
  ⋯ holds Open, Rename… (local) and Add child draft…. **Drag** keeps the
  per-section rules: a drop never leaves its section, a synced source's root
  pages stay put, and a drop on a source folder is a move to that section's
  root (`moveParentForRail`, so the synthetic `section:` id never reaches the
  move endpoints).
- **Recent** is the eight most recently changed documents by the tree's own
  `updated_at` — the same for every viewer, because the tree carries no
  per-person read history. **Shared with me** says plainly that assessment
  documents are shared by role and source space, not person to person; it is
  a view with an honest empty state, not a fabricated list.
- **List page** (`knowledge/DocumentLibrary.tsx`, composed as the reference's
  `DocumentListPage`): `PageHeader` "All documents" + count chip, **Upload**
  (`FilePickerButton`, `.md/.markdown/.txt`) and **New ▾** (`DropdownMenu`,
  Page), one `SearchInput` with a `FilterPopover` (Source, Type as
  `FilterChip`s), "n results · Last changed ▾", and `DocumentResultList`
  rows (page glyph, title, source / location, age; ⋯ Open, Copy link). The
  rows are the loaded tree, so search is over names and locations.
- **Upload** makes one Workspace draft per file, titled by its first `#`
  heading. The draft is created **with** its body
  (`POST /api/assessment/knowledge/doc/create` now takes an optional
  `markdown`, at most 64K characters; the portal refuses a file over 48 KB before reading it), so the canvas seeds from it on first open; a
  create-then-save would change the source under the pending import and be
  refused.

### Phase 4 (part) — the document conversation (gap 7)

- `knowledge/DocumentConversation.tsx`: the **composer dock** is the
  library `ContextComposer` (`/social/rich-composer`) with
  `context={{ kind: 'document' }}` — "Chat ⌄ · ● <title> × · Message this
  document’s conversation… · Send" — as the `EditorShell` footer on the
  Editor tab (`DocumentShell composer`). Agent and Terminal are shown off
  with their reasons; nothing here runs an agent on a document.
- The conversation is a **gateway chat channel on the BFF's own realtime
  gateway** (`/ws`, the HS256 realtime token), joined once per page with
  realtime-modules `useChat` **outside** the canvas's document-grant socket.
  Channel `assessment:doc:<docId>` (`conversationChannelForDoc`), hashed to
  `assessment:doc:h:<cyrb53>` when the id is longer than the chat service's
  50-character cap or is not a slug (`draft:<uuid>`, `ec:` paths).
- The thread is a **Chat** panel in the context column: the library's
  `WrappedChatPanel` from `@connorhoehnslalom/ui-components/integrations/realtime`
  (ui-components 2.407.20, the scope-agnostic entry — it takes the `useChat`
  result and adapts the thread itself; the page composes no message adapter),
  with its own Chat-only `ContextComposer`; a send from the dock opens it. Offline gateway → Chat
  is shown off with the reason, never a composer that swallows messages.
- No middleware change: the BFF gateway's chat channels are not
  tenant-scoped (`lib/realtime-gateway.ts`).
- Journey: the second test in `portal/e2e/assessment-documents-parity.spec.ts`
  — rail header, views, source folders, the dock's chip and placeholder, a
  message round-tripping to the Chat panel, Recent / Shared with me, and the
  list page's header, Upload, New, filter and search; screenshots
  `parity-journey-rail-dock.png`, `parity-journey-chat.png`,
  `parity-journey-list.png`.

### Phase 4 (rest) — comments on platform-api threads, the byline, calls (gaps 4, 7, 8)

**Comments are platform-api's document comments** (recommendation C), the
threads realtime-examples' editor reads: document-wide (`scope: 'document'`)
and anchored roots, replies, resolve / reopen.

- **Through the BFF, never a browser-held platform credential.**
  `GET/POST /api/assessment/knowledge/doc/workflows/comments?id=<source id>`
  and `PATCH/DELETE …/comments/:commentId` (`routes/assessment-document-workflows.ts`
  → `providers/document-comments.ts`) call platform-api with the BFF's own
  document grant (`comment` operation, every assessment reader) through the
  fixed-operation bridge (`providers/document-workflows.ts`: `comments`,
  `comment-create`, `comment-update`, `comment-delete`; reads page 200 at a
  time). The browser names only the source id; a body naming an author,
  document or grant is a 400. Display names come from the identity store
  (a grant carries no email, so platform-api would print `u-farah`).
  Author-only edits and the owner rule on delete stay platform-api's.
- **`dev:mock` without a platform-api** serves the same routes from a
  registered fixture in platform-api's item shape
  (`mock/document-comments.ts`, `assessment-platform-document-comments`),
  under platform-api's own rules and error strings, so the tab works offline.
  The wire capture witnesses the route on `page:100002`.
- **One-time import of the legacy thread** (`providers/document-comment-import.ts`,
  ledger `assessment_document_comment_imports` in `schema/assessment_schema.sql`,
  its fixture `assessment-document-comment-imports` under `dev:mock`). Runs
  lazily on a document's first comments read, create, resolve or delete — a
  document never opened has no platform identity to import into. Ids, authors,
  timestamps (Aurora `timestamptz` text normalised to ISO UTC), edits and the
  reply edge are preserved; roots become document-wide threads (never an
  invented anchor); a removed comment is carried only as a wordless tombstone
  when live replies hang off it. It writes platform-api's `document-comments`
  table directly with conditional puts — the public POST would mint new ids,
  stamp "now" and take the author from the grant — named by
  `DOCUMENT_COMMENT_IMPORT_TABLE` (+ `DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT`
  for DynamoDB-local); unset, the tab says how many earlier comments have not
  moved and nothing is written. After the import the legacy comment write
  routes answer **409 `comments_moved`**. `dev:mock` seeds a legacy thread on
  `page:100002` (`kc-rubric-01` + reply) for it to carry.
- **Reactions mapping.** platform-api has no reactions on document comments,
  so reactions stay in `assessment_knowledge_reactions`, keyed by the same
  comment ids the import preserved; the reaction routes also accept the
  document's platform comment ids (`documentCommentTargetIds`). Document
  reactions sit at the top of the Comments tab, thread reactions on each
  thread (`CommentThreadNode actions`).
- **Comments tab** (`knowledge/DocumentComments.tsx`, as the reference's
  `renderShellTab('comments')`): one `Card` per group — **On the page**
  (anchored) / **Whole document** — with "n open · m total", each thread the
  library `CommentThreadNode` (reply, resolve, reopen, quote header), a
  whole-document composer, the open count on the tab.
- **The margin** (`knowledge/useCanvasComments.tsx`, as the reference's
  `useCanvasGutterItems` + `CanvasCommentComposer`): threads as
  `CanvasDocumentView gutterItems` beside the text their anchor resolves to
  (`resolveAnchor` / `pmRangesFromPlain`), document-wide ones stacked below the
  last heading; the per-document `CommentHighlight` extension paints the
  ranges (`additional` in `createCanvasExtensions`); **Comment** in the head
  takes the selection's anchor at click (`createAnchor`) and posts it — in the
  head, not the canvas toolbar, because a reader has no toolbar and commenting
  is not editing. The margin shows/hides with the gutter toggle (remembered).
- Replaced: `DocumentCommentThread.tsx` and `useKnowledgeDocumentThread.ts`.

**Participants in the shell byline** (`knowledge/useCanvasParticipants.ts`):
everyone else on the canvas from its awareness (one entry per person across
tabs) as `EditorShell participants`; `onParticipantClick` scrolls to their caret
(their awareness `cursor.head` resolved through the editor's ySync binding);
`onFollowParticipant` follows it, with the library `FollowModeBar` under the
ruler. Props verified against the installed `doc-editor.d.ts`.

**In-document call** (`knowledge/useDocumentCall.tsx`): the tenant's one call
host (`projects/InitiativeCallHost`, now mounted around the assessment routes
by `AssessmentLayout`), the realtime token, the shared call model
(`lib/conversationCallModel` `callAvailability`, `lobbyPrefix`) and the library
dock (`lib/conversationCall` `ConversationCallDock`) — no second call stack.
The lobby is **`<tenant>:doc:<doc>`** (`assessment:doc:page:100002`; long ids
hashed like the chat channel), one per document; it rings the others on the
page (awareness). **Call** / **Leave call** is the shared `DocumentHeader`'s
call control; the live call docks in the page margin
(`VideoDockSlot` as `CanvasDocumentView gutterLead`). The invite carries the
document's URL, so Accept on any assessment page opens it
(`AssessmentLayout` `DocumentCallNavigator`; only in-app `/assessment/…?doc=`
paths). An unavailable call says why when pressed.

**Journey:** the third test in `portal/e2e/assessment-documents-parity.spec.ts`,
two contexts (u-farah lead-assessor, u-jonas assessor): each other in the
byline; the imported thread with its author and reply; a whole-document
comment reaching the other tab; Jonas (a reader) comments on a selection, both
see the mark and card, the row is stored anchored and authored by him; Farah
resolves it and Jonas sees the banner; Farah calls, Jonas's toast → Accept,
both docked with "2 people". The call half skips with Call's own reason on a
stack without platform-api. Screenshots `parity-journey-byline.png`,
`-comments-threads.png`, `-comments-anchored.png`, `-call.png`.

**Known limits.** `CommentThreadNode` has no edit/delete (the BFF routes
support both; the reference offers neither); only thread-root reactions are
shown (reply reactions stay stored); no @-mention list in threads yet; the
library's `useDocumentComments` cannot be used until its transport seam ships
(below), so `useDocumentComments.ts` is that transport meanwhile.

## Backlog (not asserted yet — add a check when a slice ships)

1. **Toolbar in the shell's toolbar slot.** `CanvasDocumentView` draws its own
   toolbar and ruler and offers no way to hand them to a frame (the
   presentation editor has `renderFrame`). realtime-examples renders it the
   same way today, so the page already matches the reference; a
   `renderFrame`-style split is a library change if the slot is wanted.
2. **Phase 2 — one pane assembly** in ui-components
   (`integrations/realtime-modules`): extension list, image provider,
   recovery, save state; consumed by both apps.
3. **Library comments transport.** ui-components branch
   `feat/document-comments-transport` (commit `f721810b`, unreleased) gives
   `useDocumentComments` `baseUrl` / `commentsPath` / `fetcher` and
   `addDocumentComment`; once released and pinned, replace
   `knowledge/useDocumentComments.ts` with it (`commentsPath` →
   `/api/assessment/knowledge/doc/workflows/comments?id=…`, `fetcher` with
   `credentials: 'include'`, and the platform `documentId` as its id so live
   `doc:comment_*` events match). `useDocumentReviews` needs the same seam.
4. **Local env for the import.** `scripts/social-documents.mjs` should export
   `DOCUMENT_COMMENT_IMPORT_TABLE=document-comments` and
   `DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT=http://127.0.0.1:8000` for
   `dev:mock:social` (outside this slice's files); until then the tab reports
   the earlier comments as not moved on that stack.
5. **Phase 5 — document types** (optional; otherwise record the omission).
