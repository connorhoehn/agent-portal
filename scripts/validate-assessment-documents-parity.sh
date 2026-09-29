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
if (cd portal && node --test 'src/pages/assessment/**/__tests__/*.test.ts' >/dev/null 2>&1); then ok "assessment node tests green (prompts stay read-only: documentCanvasState.test.ts)"; else fail "portal: assessment node tests failing"; fi

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
for a in 'Take ownership' 'SourcePublishControl' "'Edit draft'" 'Edits are a local draft\. Publishing to the source is a separate action\.'; do
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
  grep -qE "size\?: 'sm' \| 'md' \| 'rail'" "$LIB/social.d.ts" && ok "installed ConversationShelf has size=\"rail\"" || fail "installed ConversationShelf has no size=\"rail\""
  for c in PageHeader FilePickerButton FilterPopover DocumentResultList SearchInput; do
    grep -qE "export declare function $c\b" "$LIB/shared.d.ts" && ok "installed /shared exports $c" || fail "installed ui-components/shared does not export $c"
  done
fi
has 'railHeading="label"' "$FRAME" && has 'railCount' "$FRAME" && ok "rail header is the DOCUMENTS n label (railHeading=label + railCount)" || fail "$FRAME: rail header is not railHeading=\"label\" with railCount"
has "title=\{mode === 'workspace' \? 'Documents'" "$EXPLORER" && has "count=\{documentTotal\}" "$EXPLORER" && ok "workspace rail reads DOCUMENTS <count>" || fail "$EXPLORER: the workspace rail is not titled Documents with its count"
[ -f "$RAIL" ] && ok "knowledge/DocumentRail.tsx exists" || fail "$RAIL missing"
has 'ConversationShelf compact plain size="rail"' "$RAIL" && ok "views are a plain rail-scale ConversationShelf" || fail "$RAIL: views are not ConversationShelf compact plain size=\"rail\""
for v in "'All documents'" "'Recent'" "'Shared with me'"; do has "label: $v" "$RAIL" && ok "view $v" || fail "$RAIL: view $v missing"; done
n_rail=$(grep -o 'KeyboardTreeView size="rail"' "$RAIL" | wc -l | tr -d ' ')
[ "$n_rail" -ge 2 ] && ok "the tree and the Recent list are TreeView size=\"rail\" ($n_rail)" || fail "$RAIL: TreeView size=\"rail\" appears $n_rail times (want the sources tree and Recent)"
grep -qE '<(KeyboardTreeView|TreeView|ConversationShelf)[^>]*size="(sm|md)"' "$K"/*.tsx && fail "a sm/md-scale tree or shelf is left under $K" || ok "no sm/md-scale tree or shelf in the rail"
has "sectionFolderId" "$RAIL" && has "moveParentForRail" "$EXPLORER" && ok "sources are folder rows; a drop on a folder moves to that section's root" || fail "sources are not folder rows, or the synthetic folder id can reach the move endpoints"
has "<SectionPresence" "$RAIL" && has "usePresence" "$RAIL" && has "PresenceAvatars" "$RAIL" && ok "per-source presence on the folder row" || fail "$RAIL lost per-source presence"
has "label: 'New page'" "$RAIL" && has "label: 'Pull now'" "$RAIL" && has "rowMenu=\{rowMenu\}" "$RAIL" && ok "folder ⋯: New page / Pull now; page ⋯ via rowMenu" || fail "$RAIL: folder/page row menus missing"
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
section "accelerator UX preserved (gap 15)"
has "<SectionPullControl" "$RAIL" && has "/api/assessment/knowledge/pull" "$RAIL" && ok "space-level Pull (on the source folder row)" || fail "DocumentRail lost SectionPullControl / the pull route"
has "onReorder: handleReorder" "$EXPLORER" && has "/api/assessment/knowledge/source/move" "$EXPLORER" && has "onReorder: props.onReorder, canDragNode, canDropNode" "$RAIL" \
  && ok "drag of synced pages through the source adapter" || fail "KnowledgeExplorer / DocumentRail lost drag / source move"
has "NewDraftDialog" "$EXPLORER" && ok "New page / child draft" || fail "KnowledgeExplorer lost NewDraftDialog"
has "mode !== 'prompts'" "$K/documentCanvasState.ts" && ok "prompts read-only" || fail "documentCanvasState no longer keeps prompts read-only"

# ─────────────────────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "middleware (document routers)"
  if (cd middleware && npm test -- --testPathPattern 'assessment-canvas|assessment-document|document-workflows|document-source|document-canvas|internal-document|document-versions|document-mapping|document-drafts' >/dev/null 2>&1); then
    ok "jest: canvas / workflow / source routers green"; else fail "middleware: document router jest failures"; fi

  section "journey (Playwright, 1672×941, configured canvas)"
  BASE=${PARITY_BASE_URL:-http://localhost:5183}
  if curl -fsS -o /dev/null --max-time 5 "$BASE/"; then
    if (cd portal && PARITY_BASE_URL="$BASE" node_modules/.bin/playwright test e2e/assessment-documents-parity.spec.ts --reporter=line >/tmp/assessment-documents-parity-journey.log 2>&1); then
      ok "journey passed against $BASE (tabs, canvas, Edit draft toolbar + ruler; rail, views, list, dock → Chat round trip; no page errors)"
    else
      fail "journey failed against $BASE — see /tmp/assessment-documents-parity-journey.log"
      tail -25 /tmp/assessment-documents-parity-journey.log | sed 's/^/      /'
    fi
  else fail "no portal at $BASE (start the document stack; see the header of this script)"; fi
  for s in parity-journey-reader parity-journey-edit-draft parity-journey-comments parity-journey-history parity-journey-reviews parity-journey-versions parity-journey-rail-dock parity-journey-chat parity-journey-list; do
    [ -s "docs/design/documents-parity/$s.png" ] && ok "screenshot $s.png" || fail "missing docs/design/documents-parity/$s.png"
  done
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS"; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
