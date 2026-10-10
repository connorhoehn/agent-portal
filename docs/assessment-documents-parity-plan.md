# Assessment documents: parity with the realtime-examples editor

Research checkpoint: 2026-09-29. Read-only; no code changed. Answers the user's
direction that the assessment workspace document page
(`http://localhost:5183/assessment/workspace?doc=page%3A100002`) "needs to have
the same type of document editor as http://localhost:15174/documents and they
should all look the same with the same ui-components and layouts and backend
style of `/documents/<id>?type=Meeting+Notes`".

Prior art, still binding:
[backend integration map](document-backend-integration-2026-09-19.md),
[workspace reuse research](document-workspace-reuse-research-2026-09-20.md)
(including its "Preserve the accelerator UX" table),
[assessment tenant](assessment-tenant.md) "Workspace page", and the
[component queue](ui-components-queue.md) "Document toolkit adoption".

Revisions inspected: aws-agentcore `3c28e45b` (dirty tree), portal
ui-components `b2b99edb` (2.407.10), portal/middleware realtime-modules
`d84d9612` (0.98.3), realtime-examples `ee1d019b`, platform-api `348f95d`.

**Short version.** The two pages already share more than they look like they
do: the same paper canvas (`CanvasDocumentView`), the same shared
`DocumentHeader`, the same realtime gateway (Yjs over `document-grant-v1`) and
the same platform-api lifecycle/review routes (through a BFF proxy). What
differs is (a) the **frame** — realtime-examples wraps the surface in the
library's `EditorShell` (crumbs, title row, Editor/Comments/Versions/History
tabs, toolbar slot, floating composer dock) while assessment puts the header
inside the canvas and moves comments/versions/reviews into a `ContextColumn`;
(b) **comments** — examples use platform-api anchored threads, assessment uses
its own Aurora `assessment_knowledge_comments`; (c) the **list/rail** —
examples use a "DOCUMENTS n" rail with folders/Recent/Shared + Upload/New ▾ over
`useDocumentSearch`/`useDocumentFolders`, assessment uses a section-per-source
tree over `/api/assessment/knowledge/tree`; and (d) **document types** — the
`?type=Meeting+Notes` field/section template model has no assessment
equivalent. Recommendation: keep the current backend split (platform-api +
gateway for content and workflows, BFF-owned source mapping and draft/publish),
move comments onto platform-api, and adopt `EditorShell` as the frame.

## Screenshots (Playwright, 1672×941)

| File | What |
| --- | --- |
| [examples-documents-list.png](design/documents-parity/examples-documents-list.png) | realtime-examples `/documents?as=hank` — All documents |
| [examples-document-editor-meeting-notes.png](design/documents-parity/examples-document-editor-meeting-notes.png) | `/documents/cffb0961-…?type=Meeting+Notes` — Editor tab, typed field block (Meeting Title / Date / Meeting Type / Attendees / Facilitator) above Agenda / Discussion Notes / Action Items / Decisions Made |
| [examples-editor-tab-comments.png](design/documents-parity/examples-editor-tab-comments.png), [-versions](design/documents-parity/examples-editor-tab-versions.png), [-history](design/documents-parity/examples-editor-tab-history.png) | the other three tabs |
| [examples-document-editor.png](design/documents-parity/examples-document-editor.png) | `?type=page` document (Sprint notes) for comparison |
| [orgiq-assessment-workspace-doc.png](design/documents-parity/orgiq-assessment-workspace-doc.png) | `/assessment/workspace?doc=page%3A100002` as u-jonas (lead-assessor grant, landed as assessor) |

Two things the screenshots show that are environment, not design:

- The assessment page is in its **degraded reader fallback**. `POST
  /api/assessment/knowledge/canvas` returns 503 "Document collaboration is
  unavailable" because the running `dev:mock` middleware has no
  `DOCUMENT_GRANT_*` / `DOCUMENT_GATEWAY_*` env (`providers/document-canvas.ts:12-24`
  throws "not configured"). With them set, the same page renders
  `CanvasDocumentView` with toolbar and ruler (see the 2026-09-20 evidence
  screenshots). Any parity judge must run with the document env configured, or
  it is measuring the fallback.
- Both realtime-examples editor screenshots carry "The document status could
  not be loaded. Document not found" — the lifecycle `GET
  /api/documents/:id/lifecycle` 404s on platform-api `:13001` for these seed
  documents. That is an upstream data gap in the reference stack, not something
  to copy.

Local topology observed: realtime-examples runs in Docker Desktop Kubernetes
(gateway `:18080`, platform-api `:13001`, DynamoDB, Redis, MQ, event catalog);
this repo's `social` compose profile runs a separate platform-api on
`127.0.0.1:23001` with its own DynamoDB on `:8000`. They are two different
platform-api data sets.

## 1. What realtime-examples' documents pages are made of

All paths under `realtime-examples/frontend/src` unless noted.

**List page** (`/documents`), `components/doc-editor/DocumentListPage.tsx`
(636 lines) inside `components/doc-editor/explorer/DocumentExplorer.tsx`
(1,408 lines).

- Rail: library `ContextColumn`, `RailSection`, `TreeView`, `PresenceAvatars`,
  `FileKindMark`, `ViewportFillRegion`, plus `ExplorerLayout`,
  `RailSectionHeader`, `ConversationShelf` (`explorer/DocumentExplorer.tsx:85-111`)
  — the same primitives the assessment explorer already uses. (The library also
  exports `WorkspaceRail`, whose `label` variant draws a "DOCUMENTS 137" header,
  but the explorer does not import it.) Views (`:950-952`):
  All documents / Recent / Shared with me; group-by folders/types/status
  (`:189-191`); FOLDERS tree with counts, drag
  reorder via `positionBetween` + `useDocumentFolders` (realtime-modules
  `src/client/documents/folders.ts:254`); TRASH; MANAGE → Templates, Data types.
- Main: `PageHeader` "All documents 54", `FilePickerButton` Upload
  (`.md,.markdown,.txt`, `:418-427`), New ▾ (Page / Presentation / Diagram /
  From a template…, `:395-437`, `NewDocumentModal` from `/doc-editor`),
  `SearchInput` + `FilterPopover`, rows from `DocumentResultList`, "Last changed ▾" sort — all
  `@connorhoehn/ui-components/shared` (`DocumentListPage.tsx:40-55`). Data from
  realtime-modules `useDocumentSearch` (`src/client/documents/useDocumentSearch.ts:59`)
  → platform-api `GET /api/document-search?sort=updated&limit=30`.
- Bottom: `AllDocumentsComposerDock.tsx` — the rich `ContextComposer`
  ("Add documents, then /workflow…", Workflow ▾).
- Right edge: a collapsed `ContextColumn` workbench (`explorer/DocumentWorkbench.tsx`).

**Editor page** (`/documents/:id?type=…`),
`components/doc-editor/DocumentEditorPage.tsx` (3,506 lines, app-local).

- Frame: library `EditorShell` (`/doc-editor`, ui-components
  `src/components/doc-editor/EditorShell.tsx`) — crumb trail, title row,
  tab row, toolbar
  slot, surface as tabpanel, floating composer dock. Tabs are host-owned
  (`DocumentEditorPage.tsx:666-692`, `renderShellTab` `:2397-2463`). Tab ids in
  `editorShellBinding.ts:83-84` are `brief | editor | comments | versions | history`.
  The running build shows Editor / Comments / Versions / History (screenshots);
  the current source labels them Brief / Page / Discussion / Versions / Activity
  (`:119-123`), so the labels are in flux. Comments → local `SectionComments`;
  Versions → local `VersionHistoryPanel` over WebSocket `listSnapshots` /
  `saveVersion` / `restoreSnapshot` (`hooks/useVersionHistory.ts`), stored by the
  gateway's `DdbSnapshotStore` (`crdt-snapshots`); History/Activity → an
  in-memory activity bus, **not persisted**. `WorkspaceDocumentHeaderNotices`,
  `DocumentLifecyclePill` (`:80`).
- Header actions: `components/doc-editor/DocumentHeader.tsx` is a 16-line
  adapter over the **shared** `DocumentHeader` from `/doc-editor` ("document
  chrome is shared with assessment"), `variant="actions"` inside the shell.
  Share (`DocumentShareDialog`), Call, info, overflow.
- Surface: `components/doc-editor/canvas/CanvasDocumentPane.tsx` (1,295 lines)
  over library `CanvasDocumentView` (toolbar + ruler + paginated paper) with
  the canvas extension assembly, comment/suggestion gutter and image upload.
- Dock: `ContextComposer` from `/social/rich-composer` with a document chip
  ("Chat · <title> ×", `:73`); `DocumentChatPanel.tsx` (1,168 lines) for the
  document conversation; `VideoDockSlot` + `FloatingDockBar` (`:9`) and
  `CALL_DOCK_DRAG_TYPE` from `/video` for an in-document call;
  `FollowModeBar`, `VideoHistoryPanel`, `AttachmentsPanel`.
- Right rail: collapsed `ContextColumn` workbench (`explorer/DocumentWorkbench.tsx`,
  library `Workbench`), tabs `comments | activity | details`
  (`editorShellBinding.ts:140`); side panels register through
  `explorer/documentAside.ts`. No graph rail in the editor was found.
  `DocumentActivityCard` (ui-components `src/components/social/DocumentActivityCard.tsx`)
  is rendered inside `ChatPanel`, i.e. how a document appears in chat, not a
  page panel.
- App hooks the page imports (`:21-58`): `useRooms`, `useConversations`,
  `useDocumentShare`, `usePeopleDirectory`, `useVersionHistory`,
  `useDocumentTypes` (`loadTypes`, `refreshTypesFromServer`),
  `useMyMentionsAndTasks`, `useVideoSessions`, `useDocumentLifecycle`,
  `useDocumentTransform`, `useDocumentsDomainOptional`
  (`providers/DocumentsDomainProvider.tsx`), `HangoutDomainProvider`.

**Backend calls observed opening the Meeting Notes document** (network capture):
platform-api `:13001` — `GET /api/documents/:id/{comments,lifecycle,reviews,run-drafts,work,sections/_macro/items}`,
`GET /api/document-types`, `/api/items/mine`, `/api/reviews/mine`,
`/api/video/sessions/document/:id`, `/api/rooms`, `/api/profiles/:user`,
`/api/deck/row-summaries`; gateway `:18080` — `/api/chat/conversations`,
`/api/calls/active`, `/api/presence/channel/general`, plus WebSocket frames
`crdt documentList` (carries each document's `type`, e.g. `"type":"Meeting Notes"`),
CRDT subscribe/snapshot, awareness and document events.

**`?type=Meeting+Notes`.** `DocumentEditorRoute` (`app/App.tsx:1169-1289`) reads
`type` (falling back to the document's metadata `type` from the gateway
`documentList`); `presentation` routes to a different page, anything else to
`DocumentEditorPage`. The page resolves the type **by name** from a
localStorage cache then `GET /api/document-types` (`DocumentEditorPage.tsx:1513-1583`),
writes `documentType` into the document metadata and adds one section per
type field. "Meeting Notes" is data: seeded by
`realtime-examples/scripts/seed-document-types.mjs:54-67` into platform-api's
`document-types` DynamoDB table (versioned schemas,
`repositories/DocumentTypeRepository.ts`). The editor renders the fields as a
property block (Text / Date / Number / Yes-no) with sections as headings.
Typed instances (`/api/typed-documents`) are a plain fetch hook; no
typed-documents *subscription* is used anywhere in the frontend. Templates and Data types are the MANAGE rows in the rail:
routes `/documents/templates` (library `DocumentTypesPage` from
`@connorhoehn/ui-components/doc-types`, lazy-loaded at `app/App.tsx:90`, mounted
`:664`) and `/documents/data-types` (app-local
`components/field-types/FieldTypesPage`, `app/App.tsx:91`, `:667`), both inside
`DocumentSettingsFrame`.

REST hooks are app-local copies in `frontend/src/hooks/`: `useDocumentComments`,
`useDocumentLifecycle`, `useDocumentReviews`, `useDocumentItems` call
`${PLATFORM_API_URL}/api/documents/:id/{comments,lifecycle,reviews,sections/:s/items}`
with the user's bearer token; `useTypedDocuments` calls `/api/typed-documents`;
`useDocumentTypes`, `useCustomFieldTypes` back the type/field model. ui-components
2.407 exports parallel `useDocumentComments` / `useDocumentTypes` /
`useTypedDocuments` / `useDocuments` (`src/hooks/`), but its comments hook reads a
build-time `SOCIAL_API_URL` (`src/utils/socialApi`) with no base-URL option,
so it cannot be pointed at a BFF proxy today. platform-api route files:
`src/routes/documentComments.ts`, `documentLifecycle.ts`,
`documentReviewRequests.ts`, `sectionReviews.ts`, `sectionItems.ts`,
`documentTypes.ts`, `typedDocuments.ts`, `documentSearch.ts`,
`documentRevisions.ts`, `documentWork.ts` (DynamoDB repositories, e.g.
`repositories/DocumentCommentRepository.ts`). Yjs content, snapshots and named
versions live in the gateway (CRDT service + snapshot store), which the Versions
tab reaches over the WebSocket (`useVersionHistory`). Image/file uploads go to
the gateway's `PUT/GET /api/uploads/:id` (`src/server.ts:2764-2770`), and the
list's Upload parses Markdown/text into a new page over the CRDT socket
(`app/App.tsx:988-1010`). Providers: `WebSocketProvider` → `IdentityProvider` →
`GatewayBridgeProvider` → presence/chat/notifications bridges (`app/App.tsx:475-529`),
then `DocumentsDomainProvider` (`providers/DocumentsDomainProvider.tsx`) in
`AppLayout`. Dev identity: `?as=hank` makes `hooks/useAuth.ts` mint an unsigned
dev JWT (`sub: dev-hank`) used as the platform-api bearer when
`VITE_DEV_BYPASS_AUTH=true`.

## 2. What the assessment workspace page is made of today

`portal/src/pages/assessment/WorkspacePage.tsx` is one line:
`<KnowledgeExplorer mode="workspace" />`. The explorer is shared with
Enterprise, Rules and Prompts. `doc=` is read in `KnowledgeExplorer.tsx`
(`useSearchParams`) and selects a node from `GET /api/assessment/knowledge/tree`.

| Layer | File | Composites / hooks |
| --- | --- | --- |
| Frame | `knowledge/ExplorerFrame.tsx` | library `ExplorerLayout`, `ContextColumn` (panels Outline / Comments / Activity / Versions / Reviews, `:61-66`), `ViewportFillRegion` |
| Rail | `knowledge/KnowledgeExplorer.tsx:342-420` | `RailSection` "Views" + `ConversationShelf` (All documents), one `RailSectionHeader` per source section, `KeyboardTreeView` (wraps library `TreeView`) with `onReorder`, section presence (`usePresence`), `SectionPullControl` |
| List | `knowledge/DocumentLibrary.tsx` | `DetailHeader`, `Toolbar`, `Input`, `Select`, `DataTable` over the already-loaded tree |
| Editor | `knowledge/CanvasDocumentPane.tsx` | `CanvasDocumentView`, shared `DocumentHeader`, `DocumentOutline`, `DocumentImageProvider`, `useDocumentImageUpload`; realtime-modules `GatewaySocketProvider` (`authProtocol="document-grant-v1"`), `useYjsDoc`, `useCanvasDocument`, `useFileUpload`, `createCanvasExtensions` (same extension set as the example) |
| Lifecycle | `knowledge/useDocumentWorkflow.ts` | shared `DocumentHeader` `lifecycleActions` from server `availableActions` |
| Versions | `knowledge/DocumentHistory.tsx` | `VersionHistoryPanel`, `useVersionHistory` over the gateway channel |
| Reviews | `knowledge/DocumentReviews.tsx` | `DocumentReviewPanel` |
| Comments | `knowledge/DocumentCommentThread.tsx`, `useKnowledgeDocumentThread.ts` | social toolkit thread, `ReactionsBar` |
| Draft/publish | `knowledge/SourcePublishControl.tsx`, `NewDraftDialog.tsx` | `DiffViewer` preview, explicit Publish |
| Reader fallback | `knowledge/DocumentReader.tsx` | `MarkdownView`, `DocumentOutline`, `DocumentStatusBar` |

Middleware routes backing it:

- `routes/assessment.ts:632-822` — `GET /knowledge/tree`, `GET/PUT /knowledge/doc`,
  `/doc/versions`, `/doc/version`, `/doc/restore`, `/doc/move`, `/doc/rename`,
  `/doc/publish`, `/pull`, comments/reactions CRUD, `/presence`.
- `routes/assessment-canvas.ts` — `POST /knowledge/canvas`: resolves the source,
  mints an Ed25519 document grant (`createDocumentGrant`), seeds the gateway once
  from Markdown (`createCanvasSeed`, `seedCanvasOverGateway`), returns
  `{documentId, gatewayUrl, token, expiresAt, canEdit, …}`.
- `routes/assessment-document-workflows.ts` → `providers/document-workflows.ts`
  — fixed proxy to platform-api `/api/documents/:uuid/{lifecycle,transitions,ownership,review-requests,reviews,sections/:id/items}`
  with the BFF grant as bearer (`DOCUMENT_PLATFORM_INTERNAL_URL`); `/versions`
  and `/versions/restore` go to the gateway (`providers/document-versions.ts`).
  Contract: `middleware/docs/document-workflow-bridge.md`.
- `routes/assessment-document-source.ts` → `providers/document-source.ts` —
  `/doc/create`, `/source/{asset,preview,publish,pull,move}` against the
  accelerator's source adapter (`ASSESSMENT_SOURCE_URL`).
- `routes/internal-document-grants.ts` — session-epoch callback the gateway and
  platform-api call to check revocation.

Storage today:

| Data | Where |
| --- | --- |
| Source mirror (Confluence pages, local docs) | Aurora `assessment_knowledge_{sections,nodes,docs,doc_versions}`; mock fixture `knowledgeDocsFixture` (`middleware/src/mock/assessment.ts:9428`) under `dev:mock` |
| Source ID → canonical document UUID, migration state, owner | Aurora `assessment_document_mappings` (`schema/assessment_schema.sql:242`), `providers/document-mapping.ts` |
| Rich content (Yjs binary) and named versions | the realtime gateway's snapshot store (DynamoDB in the examples stack) |
| Completed drafter proposals and Apply/Discard decisions | Aurora `assessment_document_proposals`; registered `assessment.document-proposals` fixture under mock mode. Draft metadata is separate from canonical content; versioned claims prevent two tabs applying one proposal. Source-scoped read-by-id resolves retained notification targets, including terminal states and rows beyond the active-list cap, under current identity/source access and canonical write-policy controls. Notification links open and focus that proposal in the Editor tab; terminal/read-only targets show a content preview. Retry handles lookup failures; source navigation clears the target and old responses cannot replace a newer target or decision. The additive schema is not deployed. |
| Lifecycle, review requests, section items | platform-api |
| Comments and reactions | Aurora `assessment_knowledge_comments` / `_reactions` (BFF) |

Ready proposal revisions use the same metadata row, through source-scoped
`POST /doc/proposals/:proposalId/revision`. Version CAS preserves the original
target and author while a same-actor/body retry recovers a lost response without
another event. The installed `Revise…` form supplies feedback and the prior draft
to the drafter; Stop/failure restores the original and failed saves retain a
retryable candidate. No canonical content write occurs. The implementation is
covered by provider, direct handler and model/client tests; the prepared browser
cases await an environment that permits localhost binding.

Accelerator UX that must survive (from the 2026-09-20 research and
`assessment-tenant.md`): per-source sections with source badge and count;
space-level **Pull** and **New page** with preselected parent; hover row
actions; drag before/after/inside including synced sections through the source
adapter; **local draft → preview diff → explicit Publish** for synced pages
("Edits are a local draft. Publishing to the source is a separate action.");
prompts read-only; the Activity view per synced section; no AI suggestions in
navigation chrome; Cedar gating (`ViewAssessment`, `ManageKnowledge`).

## 3. Gap list

| # | Element | realtime-examples has | assessment has | Action | Owner | Storage change |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Page frame | `EditorShell`: crumbs + title row + Editor/Comments/Versions/History tabs + toolbar slot + composer dock | Header drawn inside the canvas; comments/versions/reviews as `ContextColumn` panels | Adopt `EditorShell` inside the existing `ExplorerLayout` (omit its `explorer`/`workbench`); map Reviews to a fifth tab or keep it in the column (decision) | portal | no |
| 2 | Header | shared `DocumentHeader` `variant="actions"` in the shell title row: Share, Call, info, ⋯ | shared `DocumentHeader` bar with Local draft chip, reactions, Outline, Comments, Take ownership, Publish, Edit draft | Same component, move to `variant="actions"`; keep Publish / Edit draft / Take ownership as `workflowActions` | portal | no |
| 3 | Canvas + toolbar + ruler | `CanvasDocumentView` via local `CanvasDocumentPane` | `CanvasDocumentView` via local `CanvasDocumentPane` (same extensions) | Already shared; extract the two pane assemblies into one library wrapper (queued since 2026-09-20) | library | no |
| 4 | Comments tab | platform-api anchored threads (`/api/documents/:id/comments`), gutter marks, resolve | BFF Aurora document-level threads + reactions, no anchors | Decision: migrate to platform-api threads (`scope:'document'` already exists upstream; needs a one-time import preserving ids/authors/timestamps/replies/reactions) or keep BFF threads behind the same Comments tab | platform-api + middleware | **yes** if migrated |
| 5 | Versions tab | `VersionHistoryPanel` full-pane tab | same panel in the context column | Move into the tab; no backend change | portal | no |
| 6 | History tab | in-memory activity bus (not persisted) | persisted per-section Activity in the rail | Bind the tab to the existing persisted section activity; do not copy the in-memory bus | portal | no |
| 7 | Document chat dock | `ContextComposer` with document chip; `DocumentChatPanel` | none on the doc (explorer comments only) | Adopt `ContextComposer` + chip; decide whether document chat = comments or a gateway conversation | library/portal | maybe (gateway conversation per doc) |
| 8 | In-document call | `VideoDockSlot`, `FloatingDockBar`, Call button, `/api/video/sessions/document/:id` | none | Adopt once the social profile is the assessment's platform-api; realtime token exists | portal | no (platform-api tables) |
| 9 | Rail | "DOCUMENTS n" header, All/Recent/Shared, group-by, FOLDERS, TRASH, MANAGE — built from `ExplorerLayout`/`RailSection`/`TreeView`/`ConversationShelf` | same primitives: Views + per-source sections with Pull, presence, drag | Match the header, Recent/Shared rows and row density; keep sources as top-level folders with their Pull/New page. The header row is app-composed in the example — lift it to the library if both need it | portal (library if lifted) | no |
| 10 | List page | `PageHeader` + Upload + New ▾ + search/filter + result rows + composer dock | `DataTable` + source/type selects | Adopt the same shared composites; list stays on `/knowledge/tree` (or `useDocumentSearch` if platform-api becomes the index) | portal | no |
| 11 | Document types / templates | `?type=`; `/api/document-types`; property block; Templates + Data types pages | classification only (`CLASSIFICATION_LABEL`) | Decision: define assessment types (e.g. Rubric page, Playbook, Enterprise context) in platform-api, or omit | platform-api/portal | yes (new type rows) |
| 12 | Upload | `FilePickerButton` → new document from file | image insert only | Add Upload on New draft destinations | middleware | yes (new drafts) |
| 13 | Share dialog | `DocumentShareDialog` | none | Omit or bind to Cedar-read access only — the dialog is not an ACL | decision | no |
| 14 | Canvas availability in dev | always on | 503 under `dev:mock` | Ship a `dev:mock` document env pointing at the social profile, or a documented mock canvas mode | middleware | no |
| 15 | Draft/publish, Pull, drag of synced pages | not present | present | Preserve; not a gap to close | — | — |

**Status 2026-09-29 (evening).** Rows 1–3, 5–7, 9, 10, 12 and 14 have
shipped (see the goal doc). Row 4 shipped as recommended: comments are
platform-api threads through the BFF grant, with a one-time import that keeps
ids / authors / timestamps / replies and reactions left in the BFF keyed by
those ids. Row 8 shipped on the tenant's existing call host (lobby
`<tenant>:doc:<doc>`, docked in the page margin). Row 11 remains a decision;
13 omitted (the share dialog is not an ACL).

## 4. Phased plan

**Phase 0 — make the real editor show up locally.** Add a documented
`dev:mock` + `social` profile env (`DOCUMENT_GRANT_ISSUER/PRIVATE_KEY/KEY_ID`,
`DOCUMENT_GATEWAY_PUBLIC_URL`, `DOCUMENT_PLATFORM_INTERNAL_URL=http://127.0.0.1:23001`).
Exit: `POST /api/assessment/knowledge/canvas` for `page:100002` returns a grant
and the page renders `CanvasDocumentView`, not the reader fallback.

**Phase 1 — same frame (portal only, no storage change).** Replace the
header-inside-canvas composition with `EditorShell`: tabs Editor / Comments /
Versions / History (+ Reviews if we keep it as a tab), the shared
`DocumentHeader` as `variant="actions"`, toolbar and ruler in the shell's
toolbar slot. Keep `ExplorerLayout` + `ContextColumn` for Outline and
Activity. Keep every accelerator action as `workflowActions`. The shell's
props already cover the read-only cases: `onTitleChange` is optional (no rename
for a synced page), `tabs` is caller-supplied (a Reviews tab is just a fifth
entry), `saveState`, `statusPill`, `participants` and `headActions` map onto
what the pane computes today (`EditorShell.tsx:63-115`). If `EditorShell`
still cannot express "reader because synced source, draft on Edit" or a read-only
tab set, that is a library change first, per the component-discipline rule.

**Phase 2 — one pane assembly.** Move the canvas extension list, image
provider, recovery and save-state wiring shared by both
`CanvasDocumentPane.tsx` files into ui-components
(`integrations/realtime-modules`), then consume it in both apps. This removes
the schema-divergence risk the 2026-09-20 research flagged.

**Phase 3 — same rail and list.** The example's "DOCUMENTS n" rail header,
All / Recent / Shared views, sources as folders (each keeping Pull, New page,
presence, drag), and the list page composed from `PageHeader`, Upload, New ▾,
`SearchInput`/`FilterPopover`, `DocumentResultList` rows. Yes, the assessment rail should
adopt it — "all look the same" is the user's stated requirement — but TRASH,
Templates and Data types appear only if Phase 5 adopts types.

**Phase 4 — comments and chat.** Decide comments authority (below), then
adopt `ContextComposer` with the document chip and, optionally,
`VideoDockSlot` calls through the realtime token.

**Phase 5 — document types (optional).** Only if the user wants typed
assessment documents; otherwise record it as an explicit omission.

### Backend: platform-api vs Aurora-behind-the-same-contract

The editor's content and workflow backend is **already** platform-api + the
gateway; the BFF only maps IDs, mints grants and proxies. So the real question
is only the remaining BFF-owned pieces (comments, reactions, source mirror,
list).

| Option | For | Against |
| --- | --- | --- |
| A. Everything on platform-api (comments, list via `document-search`, types) | Identical "backend style" to the reference; library hooks (`useDocumentComments`, `useDocumentSearch`, `useDocumentTypes`) work unchanged; anchored comments | Migration of existing Aurora comments/reactions (platform-api reactions exist only for room posts, `routes/reactions.ts`; none on document comments); library `useDocumentComments` reads a build-time `SOCIAL_API_URL`, not a BFF path; tenant isolation is grant-scoped only — upstream storage is single-tenant |
| B. Keep Aurora for assessment records behind the same client contract | No data migration; Cedar and tenancy stay where they are; mock floor keeps working | Two comment implementations; library hooks need a transport/baseUrl seam; "same backend style" is only at the UI boundary |
| C. (Recommended) Hybrid, as today, moving comments only | Content, versions, lifecycle, reviews, calls already upstream; source mirror and draft/publish stay in the BFF where the accelerator semantics live | Comments migration still needed; BFF proxy stays for workflows |

**Recommendation: C.** Keep the source mirror, mapping, list tree and
draft/publish in the BFF (they encode accelerator behaviour platform-api does
not have), keep content/versions/lifecycle/reviews upstream as they are, and
move comments to platform-api. The two upstream blockers the 2026-09-20
research named are now fixed at platform-api `348f95d`:
`routes/documentComments.ts:115-122` accepts `scope: 'document'` (unanchored),
and both create and list call `documentReadGate().assertCanRead` and pass
`documentId` into `getCommentsForSection` (`:109`, `:180`). What remains is the
import and the reactions mapping. Give library hooks an
injectable base URL / fetcher so the portal calls them through the BFF with the
document grant, never the user's bearer in the browser.

Identity: the canvas already uses the BFF-minted Ed25519 document grant; the
HS256 realtime token (`GET /api/session/realtime-token`,
`routes/session.ts:169`) is for gateway chat/presence and video sessions.
Calls and chat (gaps 7-8) should use that token; document operations stay on
the document grant.

### Judge

Add `docs/assessment-documents-parity-goal.md` and
`scripts/validate-assessment-documents-parity.sh` in the existing pattern
(`--quick`, every failing line printed). Mechanical checks:

- `CanvasDocumentPane.tsx` (or its successor) imports `EditorShell` and the
  shared `DocumentHeader`; no local tab row; component-discipline gate green
  for `portal/src/pages/assessment/knowledge/`.
- Tabs present in source: `editor`, `comments`, `versions`, `history`.
- Rail shows the "DOCUMENTS n" header and All/Recent/Shared views; list uses
  `PageHeader` + `DocumentResultList` + Upload + New.
- Draft/publish still wired: `SourcePublishControl` present; "Edit draft" copy
  present; prompts still read-only (existing tests).
- A Playwright journey at 1672×941 against the configured canvas: tabs visible,
  toolbar + ruler visible, no "Document collaboration is unavailable", no page
  errors; screenshots written to `docs/design/documents-parity/`.
- Middleware jest for the canvas/workflow/source routers green.

## Not found

- A library export equal to the example's current editor page: the library's
  `DocumentEditorPage` and `DocumentListPage` are older contracts; the running
  example uses its app-local pages over `EditorShell` (3,506 and 636 lines).
- A typed-documents subscription or `useDocumentEvents` in the example
  frontend; document list/presence come over the CRDT socket (`hooks/useDocuments.ts`).
- A graph rail on the example's editor page.
- Any assessment use of document types, templates, Upload-to-new-document,
  document chat dock, or in-document calls.
- Reactions on platform-api document comments: `routes/reactions.ts` is
  mounted only at `/rooms/:roomId/posts/:postId`. Migrating
  `assessment_knowledge_reactions` needs an upstream addition or they stay in the BFF.
