#!/usr/bin/env bash
# Definition of done for docs/assessment-documents-parity-goal.md — the
# assessment document pages in the same editor frame as realtime-examples'
# /documents. Exit 0 only when every check passes; every failing line prints.
# Flags: --quick skips the slow suites (middleware jest, the Playwright journey).
#
# The journey needs a stack that can mint document grants — without it the
# page is the reader fallback and the judge would be measuring that:
#   node scripts/social-documents.mjs up           # gateway :28080, platform-api :23001
#   (cd middleware && npm run dev:mock:social)     # the middleware with the document env
#   (cd portal && npm run dev)
# The call half of the two-person journey also needs PLATFORM_API_URL on the
# middleware and an SFU; without them it skips with the reason Call gives.
# The comment import writes platform-api's table when the middleware has
# DOCUMENT_COMMENT_IMPORT_TABLE (+ DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT locally).
# PARITY_BASE_URL points the journey at a portal other than :5183.
set -u
cd "$(dirname "$0")/.."
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }
has()  { grep -qE "$1" "$2" 2>/dev/null; }

K=portal/src/pages/assessment/knowledge
PANE=$K/CanvasDocumentPane.tsx
SHELL=$K/DocumentShell.tsx
FRAME=$K/ExplorerFrame.tsx
EXPLORER=$K/KnowledgeExplorer.tsx
RAIL=$K/DocumentRail.tsx
LIST=$K/DocumentLibrary.tsx
CONVO=$K/DocumentConversation.tsx
LIB=portal/node_modules/@connorhoehnslalom/ui-components/dist

# ─────────────────────────────────────────────────────────────────────────────
section "phase 0 — the real editor is reachable locally"
[ -f scripts/social-documents.mjs ] && ok "scripts/social-documents.mjs exists" || fail "scripts/social-documents.mjs missing (the documented dev:mock + social document env)"
has '"dev:mock:social": "node \.\./scripts/social-documents\.mjs middleware"' middleware/package.json \
  && ok "middleware npm script dev:mock:social" || fail "middleware/package.json has no dev:mock:social script"
for v in DOCUMENT_GRANT_PUBLIC_KEY DOCUMENT_GRANT_ISSUER DOCUMENT_GRANT_KEY_ID DOCUMENT_TENANT_ID DOCUMENT_SESSION_EPOCH_URL DOCUMENT_POLICY_SECRET; do
  n=$(grep -c "$v=\${SOCIAL_" docker-compose.yml)
  [ "$n" -ge 2 ] && ok "compose passes $v to social-gateway and social-platform-api" || fail "docker-compose.yml: $v reaches $n of 2 social services"
done
for v in DOCUMENT_GRANT_PRIVATE_KEY DOCUMENT_GATEWAY_PUBLIC_URL DOCUMENT_PLATFORM_INTERNAL_URL DOCUMENT_POLICY_SECRET; do
  has "$v" scripts/social-documents.mjs && ok "social-documents.mjs sets middleware $v" || fail "social-documents.mjs never sets $v for the middleware"
done
grep -q 'PRIVATE' <(grep -A40 'social-gateway:' docker-compose.yml | grep DOCUMENT_) && fail "a private key reaches a social container" || ok "no private key in the social containers"
if command -v docker >/dev/null 2>&1; then
  docker compose --profile social config --quiet >/dev/null 2>&1 && ok "compose social profile renders" || fail "docker compose --profile social config fails"
fi
has 'social-documents\.mjs' docs/social-calls-local-stack.md && ok "local-stack guide documents the document env" || fail "docs/social-calls-local-stack.md does not document social-documents.mjs"

# ─────────────────────────────────────────────────────────────────────────────
section "portal"
if (cd portal && npx tsc --noEmit >/dev/null 2>&1); then ok "tsc clean"; else fail "portal: tsc errors"; fi
if (cd portal && node --test 'src/pages/assessment/**/__tests__/*.test.ts' >/dev/null 2>&1); then ok "assessment node tests green (the grant is the only edit authority: documentCanvasState.test.ts)"; else fail "portal: assessment node tests failing"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "component discipline ($K)"
RAW_RE='<(div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre)( [^>]*)?className='
FILES=$(find "$K" -name '*.tsx' | sort)
count_in() { local re="$1"; shift; local n=0 c; for f in "$@"; do c=$(grep -oE "$re" "$f" | wc -l | tr -d ' '); n=$((n+c)); done; echo "$n"; }
n_raw=$(count_in "$RAW_RE" $FILES); n_btn=$(count_in '<button[ >]' $FILES); n_sty=$(count_in 'style=\{\{' $FILES)
if [ "$n_raw" = 0 ]; then ok "raw styled elements: 0"; else
  fail "raw styled elements under $K: $n_raw"
  for f in $FILES; do c=$(grep -oE "$RAW_RE" "$f" | wc -l | tr -d ' '); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$K/}"; done
fi
[ "$n_btn" = 0 ] && ok "no raw <button>" || fail "raw <button> under $K: $n_btn"
[ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}} under $K: $n_sty"
grep -rqE "role=[\"']tab|<Tabs\b|TabList" "$K" && fail "a local tab row under $K (the tabs belong to EditorShell)" || ok "no local tab row"

# ─────────────────────────────────────────────────────────────────────────────
section "phase 1 — same frame (EditorShell)"
if [ -d "$LIB" ]; then
  for c in EditorShell DocumentHeader DocumentLifecyclePill WorkspaceDocumentHeaderNotices CanvasDocumentView; do
    grep -qE "export declare (function|const) $c\b" "$LIB/doc-editor.d.ts" && ok "installed doc-editor exports $c" || fail "installed ui-components/doc-editor does not export $c"
  done
else fail "ui-components not installed under portal/node_modules"; fi
has "import \{ EditorShell.*\} from '@connorhoehnslalom/ui-components/doc-editor'" "$SHELL" && ok "DocumentShell frames the page in EditorShell" || fail "$SHELL does not import EditorShell from /doc-editor"
has "DocumentShell" "$PANE" && ok "CanvasDocumentPane renders through DocumentShell" || fail "$PANE does not use DocumentShell"
has "\bDocumentHeader\b.*from '@connorhoehnslalom/ui-components/doc-editor'" "$PANE" && ok "the shared DocumentHeader" || fail "$PANE does not import the shared DocumentHeader"
n_actions=$(grep -o 'variant="actions"' "$PANE" | wc -l | tr -d ' ')
[ "$n_actions" -ge 2 ] && ok "DocumentHeader as variant=\"actions\" in both the live and the reader frame ($n_actions)" || fail "$PANE: DocumentHeader variant=\"actions\" appears $n_actions times (want the live canvas and the reader fallback)"
has 'variant="bar"|header=\{header\}' "$PANE" && fail "$PANE still draws the header inside the canvas" || ok "no header inside the canvas"
for t in editor comments versions history reviews; do
  has "'$t'" "$SHELL" && ok "tab '$t' declared" || fail "$SHELL: tab '$t' missing"
done
for a in 'Take ownership' 'SourcePublishControl' "'Local draft'" 'Edits are a local draft\. Publishing to the source is a separate action\.'; do
  has "$a" "$PANE" && ok "workflow action kept: $a" || fail "$PANE lost: $a"
done
has 'workflowActions=' "$PANE" && ok "workflow actions ride DocumentHeader workflowActions" || fail "$PANE: no workflowActions"
has 'fitHeight="parent"' "$PANE" && has 'toolbarStyle="card"' "$PANE" && has 'showRuler' "$PANE" \
  && ok "canvas: toolbar card + ruler, sized to the shell (fitHeight=parent)" || fail "$PANE: canvas is not the shell surface (fitHeight=\"parent\", toolbarStyle=\"card\", showRuler)"
has "<DocumentHistory" "$PANE" && ! has "DocumentContextPanel" "$K/DocumentHistory.tsx" && ok "Versions is a tab, not a context-column panel" || fail "Versions still docks into the context column"
has "<DocumentReviews" "$PANE" && ! has "DocumentContextPanel" "$K/DocumentReviews.tsx" && ok "Reviews is a tab, not a context-column panel" || fail "Reviews still docks into the context column"
has "DocumentActivityFeed" "$PANE" && ok "History tab reads the persisted section activity (DocumentActivityFeed)" || fail "History tab is not bound to DocumentActivityFeed"
panels=$(grep -oE "\{ id: '[a-z]+', label:" "$FRAME" | grep -oE "'[a-z]+'" | tr -d "'" | sort | tr '\n' ' ')
[ "$panels" = "activity chat outline " ] && ok "ContextColumn keeps Outline, Chat and Activity only" || fail "ExplorerFrame ContextColumn panels are [$panels] (want activity chat outline)"

# ─────────────────────────────────────────────────────────────────────────────
section "versions tab docked"
[ -d "$LIB" ] && awk '/declare interface VersionHistoryPanelProps/,/^}/' "$LIB/doc-editor.d.ts" | grep -q 'docked?: boolean' \
  && ok "installed VersionHistoryPanel takes docked" || fail "installed ui-components VersionHistoryPanel has no docked prop (2.407.16+)"
awk '/<VersionHistoryPanel/,/\/>/' "$K/DocumentHistory.tsx" | grep -qE '^\s*docked( |$|/)' && ok "Versions tab renders the panel docked" || fail "$K/DocumentHistory.tsx does not pass docked to VersionHistoryPanel"

# ─────────────────────────────────────────────────────────────────────────────
section "phase 3 — same rail and list (gaps 9, 10, 12)"
if [ -d "$LIB" ]; then
  grep -qE "heading\?: 'compact' \| 'prominent' \| 'label'" "$LIB/index.d.ts" && ok "installed WorkspaceRail/ExplorerLayout has the label heading" || fail "installed ui-components has no WorkspaceRail heading=\"label\""
  grep -qE "export declare type TreeViewSize = .*'rail'" "$LIB/shared.d.ts" && ok "installed TreeView has size=\"rail\"" || fail "installed ui-components TreeView has no size=\"rail\" (2.407.13+)"
  grep -qE "export declare function StackedRail" "$LIB/index.d.ts" && ok "installed ui-components has StackedRail (the rail's composite since the rail-parity goal)" || fail "installed ui-components has no StackedRail"
  for c in PageHeader FilePickerButton FilterPopover DocumentResultList SearchInput; do
    grep -qE "export declare function $c\b" "$LIB/shared.d.ts" && ok "installed /shared exports $c" || fail "installed ui-components/shared does not export $c"
  done
fi
has 'caption' "$RAIL" && has 'StackedRail' "$RAIL" && ok "rail header is StackedRail's caption (DOCUMENTS n + 28px actions)" || fail "$RAIL: the DOCUMENTS caption is not StackedRail's"
has "title=\{mode === 'workspace' \? 'Documents'" "$EXPLORER" && has "count=\{documentTotal\}" "$EXPLORER" && ok "workspace rail reads DOCUMENTS <count>" || fail "$EXPLORER: the workspace rail is not titled Documents with its count"
[ -f "$RAIL" ] && ok "knowledge/DocumentRail.tsx exists" || fail "$RAIL missing"
has "All documents" "$RAIL" && has "Shared with me" "$RAIL" && ok "views (All documents / Recent / Shared with me) are a StackedRail group" || fail "$RAIL: the Views group is missing"
for v in "'All documents'" "'Recent'" "'Shared with me'"; do has "label: $v" "$RAIL" && ok "view $v" || fail "$RAIL: view $v missing"; done
has "StackedRail" "$RAIL" && ! has "KeyboardTreeView\|TreeView size" "$RAIL" && ok "the tree is StackedRail rows (no TreeView)" || fail "$RAIL: still a TreeView, or no StackedRail"
grep -qE '<(KeyboardTreeView|TreeView|ConversationShelf)[^>]*size="(sm|md)"' "$K"/*.tsx && fail "a sm/md-scale tree or shelf is left under $K" || ok "no sm/md-scale tree or shelf in the rail"
has "sectionFolderId" "$RAIL" && has "moveParentForRail" "$EXPLORER" && ok "sources are folder rows; a drop on a folder moves to that section's root" || fail "sources are not folder rows, or the synthetic folder id can reach the move endpoints"
has "<SectionPresence" "$RAIL" && has "usePresence" "$RAIL" && has "PresenceAvatars" "$RAIL" && ok "per-source presence on the folder row" || fail "$RAIL lost per-source presence"
has "New page" "$RAIL" && has "Pull" "$RAIL" && has "<DropdownMenu" "$RAIL" && ok "source actions: New page / Pull; page ⋯ is a DropdownMenu in the row's menu slot" || fail "$RAIL: source actions or the page row menu are missing"
has "document-rail-shared-empty" "$RAIL" && ok "Shared with me has an honest empty state" || fail "$RAIL: Shared with me has no stated empty state"
for c in PageHeader FilePickerButton DropdownMenu SearchInput FilterPopover FilterChip DocumentResultList; do
  has "<$c\b" "$LIST" && ok "list page uses $c" || fail "$LIST does not render $c"
done
has "DataTable" "$LIST" && fail "$LIST still renders a DataTable (the reference list is DocumentResultList rows)" || ok "no DataTable on the list page"
has 'title="All documents"' "$LIST" && has "label: 'Page'" "$LIST" && has "'Last changed'" "$LIST" && ok "All documents header, New ▾ Page, Last changed sort" || fail "$LIST: header / New ▾ / sort copy missing"
has "/api/assessment/knowledge/doc/create', 'POST', \{ title: uploadTitle\(file.name, markdown\), sectionKey: draftSectionKey, markdown \}" "$EXPLORER" \
  && ok "Upload creates a draft WITH its body" || fail "$EXPLORER: Upload does not post markdown to doc/create"
grep -q "'markdown'" middleware/src/routes/assessment-document-source.ts && grep -q "input.markdown" middleware/src/providers/document-drafts.ts \
  && ok "middleware doc/create accepts markdown" || fail "middleware doc/create does not accept an uploaded body"

# ─────────────────────────────────────────────────────────────────────────────
section "phase 4 (part) — the document conversation (gap 7)"
[ -f "$CONVO" ] && ok "knowledge/DocumentConversation.tsx exists" || fail "$CONVO missing"
has "import \{ ContextComposer \} from '@connorhoehnslalom/ui-components/social/rich-composer'" "$CONVO" && ok "the dock is the library ContextComposer" || fail "$CONVO does not import ContextComposer from /social/rich-composer"
has "context=\{\{ kind: 'document', id: docId, title \}\}" "$CONVO" && ok "document context chip (\"Chat · <title> ×\")" || fail "$CONVO: composer context is not the document"
has "Message this document’s conversation…" "$CONVO" && ok "placeholder: Message this document’s conversation…" || fail "$CONVO: reference placeholder missing"
has "useChat\b.*from '@connorhoehnslalom/realtime-modules/client'" "$CONVO" && has "conversationChannelForDoc" "$CONVO" && ok "useChat on the per-document channel" || fail "$CONVO: not useChat on conversationChannelForDoc"
has "<WrappedChatPanel\b" "$CONVO" && has "ui-components/integrations/realtime'" "$CONVO" && has '<DocumentContextPanel id="chat">' "$CONVO" && ok "the thread is the library WrappedChatPanel (integrations/realtime, 2.407.20) in the context column" || fail "$CONVO: no WrappedChatPanel from integrations/realtime in the Chat context panel"
has "adaptChatMessageForPanel" "$CONVO" && fail "$CONVO: composes its own message adapter — WrappedChatPanel adapts the useChat result itself" || ok "no page-side message adapter"
has "footer: composer" "$SHELL" && ok "the dock is EditorShell's footer" || fail "$SHELL does not pass the composer as the EditorShell footer"
awk '/^export function CanvasDocumentPane/,/^}/' "$PANE" | awk '/useDocumentConversation\(/{c=NR} /<GatewaySocketProvider/{g=NR} END{exit !(c && g && c<g)}' \
  && ok "the conversation joins on the BFF gateway, outside the document-grant socket" || fail "$PANE: useDocumentConversation is not called before (outside) the document GatewaySocketProvider"
grep -q "conversationChannelForDoc" portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts && ok "channel length rule is tested" || fail "no test for conversationChannelForDoc"

# ─────────────────────────────────────────────────────────────────────────────
section "phase 4 — comments on platform-api threads (gap 4)"
MW=middleware/src
COMMENTS_TAB=$K/DocumentComments.tsx
COMMENTS_HOOK=$K/useDocumentComments.ts
MARGIN=$K/useCanvasComments.tsx
MODEL=$K/documentCommentsModel.ts
[ -f "$MW/providers/document-comments.ts" ] && ok "middleware providers/document-comments.ts exists" || fail "$MW/providers/document-comments.ts missing"
for k in comments comment-create comment-update comment-delete; do
  grep -q "kind: '$k'" "$MW/providers/document-workflows.ts" && ok "workflow bridge operation '$k'" || fail "document-workflows.ts has no '$k' operation"
done
grep -q "case 'comments': return \`/comments?limit=200" "$MW/providers/document-workflows.ts" && ok "comments are read 200 at a time and paged" || fail "document-workflows.ts does not page the comments read"
for r in "get('/doc/workflows/comments'" "post('/doc/workflows/comments'" "patch('/doc/workflows/comments/:commentId'" "delete('/doc/workflows/comments/:commentId'"; do
  grep -qF "$r" "$MW/routes/assessment-document-workflows.ts" && ok "BFF route $r" || fail "assessment-document-workflows.ts has no $r"
done
grep -q "fields(raw, \['text', 'parentCommentId', 'anchor', 'scope', 'sectionId'\])" "$MW/providers/document-comments.ts" \
  && ok "the browser cannot name an author, document or grant (fixed field list)" || fail "document-comments.ts accepts unlisted comment fields"
grep -q "scope must be document when supplied" "$MW/providers/document-comments.ts" && grep -q "document scope cannot also specify a section, anchor or parent" "$MW/providers/document-comments.ts" \
  && ok "the dev:mock backend enforces platform-api's scope rules" || fail "document-comments.ts mock backend lost platform-api's scope rules"
grep -q "Only the author may edit comment text" "$MW/providers/document-comments.ts" && ok "author-only edits (mock backend, as upstream)" || fail "document-comments.ts mock backend lets anyone edit"
[ -f "$MW/mock/document-comments.ts" ] && grep -q "key: 'assessment-platform-document-comments'" "$MW/mock/document-comments.ts" && grep -q "key: 'assessment-document-comment-imports'" "$MW/mock/document-comments.ts" \
  && ok "dev:mock platform comments + import ledger are registered fixtures" || fail "$MW/mock/document-comments.ts fixtures missing or unregistered"
grep -q "workflows/comments': 'id=page%3A100002'" "$MW/mock/core/wire/capture.ts" && grep -q '"GET /api/assessment/knowledge/doc/workflows/comments"' "$MW/mock/core/wire/snapshots/wire.json" \
  && ok "wire snapshot witnesses the comments route" || fail "the comments route is not in the wire capture"

section "phase 4 — the one-time import (gap 4)"
IMPORT=$MW/providers/document-comment-import.ts
[ -f "$IMPORT" ] && ok "providers/document-comment-import.ts exists" || fail "$IMPORT missing"
grep -q "CREATE TABLE IF NOT EXISTS assessment_document_comment_imports" schema/assessment_schema.sql && ok "schema: assessment_document_comment_imports ledger" || fail "schema/assessment_schema.sql has no import ledger"
grep -q "commentId: c.id," "$IMPORT" && grep -q "userId: c.author," "$IMPORT" && grep -q "timestamp: isoTimestamp(c.created_at)" "$IMPORT" && grep -q "parentCommentId: parent" "$IMPORT" \
  && ok "import preserves ids, authors, timestamps and replies" || fail "$IMPORT does not preserve id / author / timestamp / reply"
grep -q "ConditionExpression: 'attribute_not_exists(commentId)'" "$IMPORT" && grep -q "ON CONFLICT (document_id) DO NOTHING" "$IMPORT" \
  && ok "idempotent: conditional puts + ledger ON CONFLICT DO NOTHING" || fail "$IMPORT is not idempotent"
grep -q "legacyThreadMoved" "$MW/providers/assessment.ts" && grep -q "code: 'comments_moved'" "$MW/routes/assessment.ts" \
  && ok "legacy comment writes answer 409 once a thread has moved" || fail "legacy comment routes still write after the import"
grep -q "extraTargets" "$MW/providers/assessment.ts" && grep -q "documentCommentTargetIds" "$MW/routes/assessment.ts" \
  && ok "reactions stay in the BFF, keyed by the preserved comment ids (+ new platform ids)" || fail "reactions cannot target platform comments"
grep -q "kc-rubric-01" "$MW/mock/assessment.ts" && ok "dev:mock seeds a legacy thread on page:100002 for the import to carry" || fail "no seeded legacy thread on page:100002"

section "phase 4 — the Comments tab and the margin (gaps 4, 5)"
grep -q "useDocumentComments(node.id, sseEvents)" "$PANE" && ! grep -q "useKnowledgeDocumentThread\|DocumentCommentThread" "$PANE" \
  && ok "the pane reads platform-api threads, not the legacy BFF thread" || fail "$PANE still reads the legacy BFF thread"
[ ! -f "$K/DocumentCommentThread.tsx" ] && [ ! -f "$K/useKnowledgeDocumentThread.ts" ] && ok "legacy thread components removed" || fail "legacy DocumentCommentThread / useKnowledgeDocumentThread still present"
grep -q "/api/assessment/knowledge/doc/workflows/comments" "$COMMENTS_HOOK" && ! grep -qiE "authorization|bearer" "$COMMENTS_HOOK" \
  && ok "comments go through the BFF; no bearer in the browser" || fail "$COMMENTS_HOOK does not use the BFF route, or sends a bearer"
grep -q "import { CommentThreadNode } from '@connorhoehnslalom/ui-components/doc-editor'" "$COMMENTS_TAB" && grep -q "<CardHeader title={group.title} meta={\`\${group.open} open · \${group.threads.length} total\`}" "$COMMENTS_TAB" \
  && ok "Comments tab: library CommentThreadNode in 'n open · m total' cards" || fail "$COMMENTS_TAB is not the reference's grouped CommentThreadNode cards"
grep -q "title: 'On the page'" "$MODEL" && grep -q "title: 'Whole document'" "$MODEL" && ok "groups: On the page / Whole document" || fail "$MODEL groups missing"
grep -q "<ReactionsBar" "$COMMENTS_TAB" && grep -q "actions={<ReactionsBar" "$COMMENTS_TAB" && ok "document and per-thread reactions on the tab" || fail "$COMMENTS_TAB lost reactions"
grep -q "commentImportNotice" "$COMMENTS_TAB" && ok "the tab says when earlier comments have not moved" || fail "$COMMENTS_TAB never reports an unfinished import"
grep -q "CommentHighlight.configure" "$MARGIN" && grep -q "setCommentHighlights" "$MARGIN" && grep -q "createAnchor" "$MARGIN" && grep -q "resolveAnchor" "$MARGIN" \
  && ok "margin: CommentHighlight marks, createAnchor on a selection, resolveAnchor to place" || fail "$MARGIN lost the anchor/highlight wiring"
grep -q "additional: \[highlight\]" "$PANE" && grep -q "gutterItems={margin.gutterItems}" "$PANE" && grep -q "onToggleGutter={toggleGutter}" "$PANE" \
  && ok "the canvas carries the per-document highlight and the gutter cards" || fail "$PANE does not hand the gutter / highlight to CanvasDocumentView"
grep -q "{margin.commentButton}" "$PANE" && ok "Comment on a selection is in the head (readers comment too)" || fail "$PANE: no Comment button in the head actions"

section "phase 4 — participants in the byline (awareness)"
[ -d "$LIB" ] && awk '/declare interface EditorShellProps/,/^}/' "$LIB/doc-editor.d.ts" | grep -q "onFollowParticipant?: (id: string) => void" \
  && ok "installed EditorShell takes participants / onParticipantClick / onFollowParticipant" || fail "installed EditorShell has no participant props"
grep -q "participants={people.participants} onParticipantClick={people.onParticipantClick}" "$PANE" && grep -q "onFollowParticipant={people.onFollowParticipant} followingParticipantId={people.following}" "$PANE" \
  && ok "the pane hands awareness participants to the shell byline" || fail "$PANE does not pass participants to DocumentShell"
grep -q "{...(participants?.length ? { participants } : {})}" "$SHELL" && ok "DocumentShell forwards them to EditorShell" || fail "$SHELL does not forward participants"
grep -q "awareness.on('change'" "$K/useCanvasParticipants.ts" && grep -q "relativePositionToAbsolutePosition" "$K/useCanvasParticipants.ts" \
  && ok "participants from canvas awareness; jump resolves their caret" || fail "useCanvasParticipants is not awareness-driven"
grep -q "<FollowModeBar" "$PANE" && ok "following shows the library FollowModeBar" || fail "$PANE: no FollowModeBar while following"

section "phase 4 — the in-document call (gap 8)"
CALL=$K/useDocumentCall.tsx
grep -q "useInitiativeCallHost" "$CALL" && grep -q "lib/conversationCallModel'" "$CALL" && grep -q "lib/conversationCall'" "$CALL" \
  && ok "reuses the tenant call host, the shared call model and the library ConversationCallDock" || fail "$CALL does not reuse the shared call stack"
! grep -qE "useConversationCall\(|useIncomingConversationCalls\(" "$K"/*.tsx "$K"/*.ts && ok "no second call hook on the page" || fail "a second useConversationCall under $K"
grep -q "<VideoDockSlot docked canAccept" "$CALL" && grep -q "gutterLead={call.dock}" "$PANE" && ok "the call docks in the page margin (VideoDockSlot as gutterLead)" || fail "the call is not a VideoDockSlot in the gutter lead"
grep -q "{...call.headerProps}" "$PANE" && grep -q "onToggleVideoCall" "$CALL" && ok "Call in the shared DocumentHeader" || fail "no Call control on the DocumentHeader"
grep -q "return \`\${prefix}doc:" "$MODEL" && grep -q "documentCallLobby(lobbyPrefix(tenant)" "$CALL" && ok "lobby is <tenant>:doc:<doc>, tenant-prefixed" || fail "document call lobby is not tenant-prefixed <tenant>:doc:<doc>"
grep -q "<InitiativeCallHost><DocumentCallNavigator /><Outlet /></InitiativeCallHost>" portal/src/pages/assessment/AssessmentLayout.tsx \
  && ok "assessment routes mount the call host; Accept opens the document" || fail "AssessmentLayout does not host calls"
grep -q "documentCommentsModel.test.ts" <(ls portal/src/pages/assessment/__tests__/) && ok "model tests: threads, groups, byline, lobby" || fail "no documentCommentsModel node tests"

# ─────────────────────────────────────────────────────────────────────────────
section "accelerator UX preserved (gap 15)"
has "/api/assessment/knowledge/pull" "$RAIL" && has "actions:" "$RAIL" && ok "space-level Pull (a source group action)" || fail "DocumentRail lost the source Pull action / the pull route"
has "onReorder: handleReorder" "$EXPLORER" && has "/api/assessment/knowledge/source/move" "$EXPLORER" && has "railDropPosition" "$RAIL" && has "canDragNode" "$RAIL" \
  && ok "drag of synced pages through the source adapter" || fail "KnowledgeExplorer / DocumentRail lost drag / source move"
has "NewDraftDialog" "$EXPLORER" && ok "New page / child draft" || fail "KnowledgeExplorer lost NewDraftDialog"
has "onRename: setRenaming \} : \{\}\)\}" "$EXPLORER" && grep -q "mode !== 'prompts' && canDo('ManageKnowledge') ? { onRename" "$EXPLORER" \
  && grep -q "if (id.startsWith('prompt:')) {" middleware/src/providers/assessment.ts && grep -q "status: 409, reason: 'prompts cannot be renamed" middleware/src/providers/assessment.ts \
  && ok "prompt rename stays refused (no Rename on prompt rows; the server 409s)" || fail "prompt rename is offered or accepted"

# ─────────────────────────────────────────────────────────────────────────────
section "decision 6 — one editor frame on every document page"
DS=middleware/src/lib/document-session.ts
grep -q "function demoIdentity" "$DS" && grep -q "process.env\['NODE_ENV'\] === 'production' || !demoFallbackAllowed()" "$DS" && grep -q "demoIdentity(sub, reference.epoch) ?? await getUser" "$DS" \
  && ok "the demo persona holds a document-session epoch outside production (so it gets a canvas grant)" || fail "$DS: the demo persona still has no document-session epoch — its grant call 503s into the reader"
grep -q "demo persona" middleware/src/routes/__tests__/internal-document-grants.test.ts && grep -q "the demo persona included" middleware/src/routes/__tests__/assessment-canvas.test.ts \
  && ok "tests: the demo grant (dev only) and a read grant for every signed-in reader" || fail "no tests for the demo persona's grant"
grep -q "canvasSourceEditable(source) && await isAllowed(session, 'ManageKnowledge')" middleware/src/routes/assessment-canvas.ts \
  && ok "the canvas route grants every assessment session; edit only for a role that may" || fail "assessment-canvas.ts does not derive edit from canvasSourceEditable + ManageKnowledge"
awk '/^  if \(grant\) return/{g=NR} /grantError \? <Stack/{f=NR} END{exit !(g && f && g<f)}' "$PANE" \
  && ok "the reader (\"Document collaboration is unavailable\") renders only on a grant error" || fail "$PANE: the reader is not confined to a grant failure"

section "decision 7 — editing by default"
! grep -qE "'Edit draft'|'Done editing'|'Edit document'|setEditing" "$PANE" && ok "no Edit draft / Done editing step" || fail "$PANE still has an explicit Edit draft step"
grep -q "const editable = canEdit && doc.synced && online;" "$PANE" && ok "a role that may edit types straight into the page" || fail "$PANE: editable still waits on a toggle"
grep -q "transaction.getMeta(ySyncPluginKey)" "$PANE" && grep -q "setDrafting(true)" "$PANE" && grep -q "data-testid=\"document-draft-chip\"" "$PANE" \
  && ok "the first local change starts the draft (chip → Local draft; remote changes ignored)" || fail "$PANE: the draft chip does not follow the first local change"
! grep -q "mode !== 'prompts'" "$K/documentCanvasState.ts" && grep -q "prompt:" middleware/src/providers/document-editability.ts \
  && ok "prompts edit through a draft (the grant is the authority)" || fail "prompts are still read-only for editors"
grep -q "source.id.startsWith('prompt:')" middleware/src/providers/document-canvas.ts && grep -q "never projects that draft as a publication" middleware/src/providers/__tests__/document-canvas.test.ts \
  && ok "a prompt draft never becomes a source publication (projection refuses prompts; tested)" || fail "a prompt's canvas draft can be projected for publication"
grep -q "Edits are a draft of this prompt. The published prompt changes only through its promotion path." "$PANE" && ok "prompt pages say the published prompt moves through promotion" || fail "$PANE: prompts do not explain their draft"

section "decision 8 — agent edits from the dock, on by default"
AE=$K/useDocumentAgentEdit.tsx
AEM=$K/documentAgentEditModel.ts
[ -d "$LIB" ] && grep -qE "export declare function ProposedEditStrip\b" "$LIB/doc-editor.d.ts" && awk '/declare interface EditorShellProps/,/^}/' "$LIB/doc-editor.d.ts" | grep -q "proposal?: ReactNode" \
  && ok "installed doc-editor exports ProposedEditStrip and EditorShell.proposal (2.407.34+)" || fail "installed ui-components has no ProposedEditStrip / EditorShell proposal slot"
grep -q 'defaultMode="agent"' "$CONVO" && grep -q "disabledModes={\['terminal'\]}" "$CONVO" && ! grep -qE "disabledModes=\{\[[^]]*'agent'" "$CONVO" \
  && ok "the dock's Agent mode is enabled and the default; Terminal stays off" || fail "$CONVO: Agent mode is not enabled + default (defaultMode=\"agent\", only terminal disabled)"
grep -q "if (mode === 'agent') return agentEdit.send(message.text);" "$CONVO" && grep -q "conversation.send(message.text)" "$CONVO" \
  && ok "Agent sends go to the drafter; Chat stays a mode on the conversation" || fail "$CONVO: onSend does not route agent → drafter and chat → conversation"
grep -q "DOCUMENT_EDIT_AGENT_ID = 'orgiq-assessment-drafter'" "$AEM" && grep -q "mode: typeof DOCUMENT_EDIT_MODE" "$AEM" && grep -q "selection: DocumentSelection | null" "$AEM" \
  && ok "the request is the drafter's document command: id, title, text, selection + range" || fail "$AEM: the drafter request lost its document context"
grep -q "useAgentStream" "$AE" && grep -q "documentEditInvokeUrl(DOCUMENT_EDIT_AGENT_ID)" "$AE" && grep -q "payload: requestRef.current" "$AE" \
  && ok "the instruction streams through POST /api/agents/:id/invoke with the command as payload" || fail "$AE does not invoke the drafter through the invoke route with a payload"
grep -q "import { ProposedEditStrip } from '@connorhoehnslalom/ui-components/doc-editor'" "$AE" && grep -q "insertContentAt" "$AE" && grep -q "resolveApplyTarget" "$AE" \
  && ok "the reply is a library ProposedEditStrip; Apply writes at the anchor through the canvas editor" || fail "$AE: no library strip, or Apply does not write through the editor at the anchor"
grep -q "^export function publishDocumentEditor" "$AE" && ok "publishDocumentEditor is the pane's editor hand-off" || fail "$AE does not export publishDocumentEditor"
grep -q "publishDocumentEditor(" "$PANE" && ok "CanvasDocumentPane publishes its editor" || fail "$PANE does not call publishDocumentEditor from onEditorReady"
grep -q "{ proposal }" "$SHELL" && grep -q "useDocumentAgentEdit(node.id" "$PANE" && grep -q "proposal: agentEdit.strip" "$PANE" && grep -q "agentEdit={agentEdit}" "$PANE" \
  && ok "the strip sits in the editor frame (EditorShell proposal slot)" || fail "the strip is not in the editor frame yet: $PANE must call useDocumentAgentEdit(node.id, title) beside useDocumentConversation, pass agentEdit={agentEdit} to DocumentComposerDock and proposal: agentEdit.strip in the frame (DocumentShell already forwards it)"
[ -f portal/src/pages/assessment/__tests__/documentAgentEditModel.test.ts ] && ok "model tests: request, reply, proposal, apply target" || fail "no documentAgentEditModel node tests"
grep -q "key: 'document-agent-edits'" middleware/src/mock/document-agent-edits.ts && grep -q "documentEditReply(structuredInput ?? message)" middleware/src/mock/responses.ts \
  && grep -q "selectMockResponse(payload.message, payload.structuredInput)" middleware/src/providers/agentcore.ts \
  && ok "dev:mock streams the drafter's edit envelope from a registered fixture" || fail "dev:mock has no registered document-edit fixture on the streaming path"
grep -q "an agent-mode instruction lands in the canvas as a proposed edit" portal/e2e/assessment-documents-parity.spec.ts \
  && ok "journey test: instruction → proposed edit → Apply → text in the canvas" || fail "no agent-edit journey in the parity spec"

# ─────────────────────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "middleware (document routers)"
  if (cd middleware && npm test -- --testPathPattern 'document-agent-edits|assessment-canvas|assessment-document|assessment-knowledge-comments|document-workflows|document-source|document-canvas|internal-document|document-versions|document-mapping|document-drafts|document-comments|document-comment-import' >/dev/null 2>&1); then
    ok "jest: canvas / workflow / source / comments routers green"; else fail "middleware: document router jest failures"; fi

  section "journey (Playwright, 1672×941, configured canvas)"
  BASE=${PARITY_BASE_URL:-http://localhost:5183}
  if curl -fsS -o /dev/null --max-time 5 "$BASE/"; then
    if (cd portal && PARITY_BASE_URL="$BASE" node_modules/.bin/playwright test e2e/assessment-documents-parity.spec.ts --reporter=line >/tmp/assessment-documents-parity-journey.log 2>&1); then
      ok "journey passed against $BASE (tabs, canvas editable on open with toolbar + ruler, first change → Local draft; demo user on a prompt: canvas + ruler, no fallback, editor role → toolbar + draft, rename 409; rail, views, list, dock → Chat round trip; agent instruction → proposed edit → Apply in the canvas; two people: byline, imported + new + anchored comments, resolve, call ring/accept; no page errors)"
    else
      fail "journey failed against $BASE — see /tmp/assessment-documents-parity-journey.log"
      tail -25 /tmp/assessment-documents-parity-journey.log | sed 's/^/      /'
    fi
  else fail "no portal at $BASE (start the document stack; see the header of this script)"; fi
  for s in parity-journey-reader parity-journey-edit-draft parity-journey-prompt-demo-reader parity-journey-prompt-demo-editor parity-journey-comments parity-journey-history parity-journey-reviews parity-journey-versions parity-journey-rail-dock parity-journey-chat parity-journey-list parity-journey-byline parity-journey-comments-threads parity-journey-comments-anchored parity-journey-call parity-journey-agent-proposal parity-journey-agent-applied; do
    [ -s "docs/design/documents-parity/$s.png" ] && ok "screenshot $s.png" || fail "missing docs/design/documents-parity/$s.png"
  done
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS"; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
