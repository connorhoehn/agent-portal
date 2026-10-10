#!/usr/bin/env bash
# Definition of done for docs/search-workspace-goal.md. Exit 0 only when every
# check passes. Flags: --quick skips the slow suites (jest, vite build).
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

PAGES=portal/src/pages/search
PAGE=$PAGES/SearchPage.tsx

# ─────────────────────────────────────────────────────────────────────────────
section "middleware"
if jg_mw_tsc >/dev/null 2>&1; then ok "tsc clean"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest src/routes/__tests__/search src/routes/__tests__/saved-searches src/providers/__tests__/search src/providers/__tests__/saved-searches src/lib/__tests__/search-context src/routes/__tests__/agents-search-context >/dev/null 2>&1); then ok "jest (search suites) green"; else fail "middleware: search jest failures"; fi
fi

section "portal"
if jg_portal_tsc >/dev/null 2>&1; then ok "tsc clean"; else fail "portal: tsc errors"; fi
if (cd portal && node --test 'src/pages/search/__tests__/*.test.ts' >/dev/null 2>&1); then ok "node tests green"; else fail "portal: search node tests failing"; fi
if [ "$QUICK" = 0 ]; then
  if jg_vite_build >/dev/null 2>&1; then ok "vite build"; else fail "portal: vite build failed"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "component discipline ($PAGES)"
source scripts/lib/discipline.sh  # the one raw-element counter (brace-aware), shared with validate-component-discipline.sh
PAGE_FILES=$(find "$PAGES" -name '*.tsx' | sort)
n_raw=$(dc_count_raw $PAGE_FILES)
n_btn=$(dc_count_re '<button[ >]' $PAGE_FILES)
n_sty=$(dc_count_re 'style=\{\{' $PAGE_FILES)
if [ "$n_raw" = 0 ]; then ok "raw styled elements: 0"; else
  fail "raw styled elements in search pages: $n_raw (must be 0 — RecordResultList / CitedRecordList / Stack / Inline / Chip…)"
  for f in $PAGE_FILES; do c=$(dc_count_raw "$f"); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$PAGES/}"; done | sort -rn
fi
[ "$n_btn" = 0 ] && ok "no raw <button>" || fail "raw <button> in search pages: $n_btn (use Button/IconButton)"
[ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}} in search pages: $n_sty"
n_css=$(find "$PAGES" -name '*.css' | wc -l | tr -d ' ')
[ "$n_css" = 0 ] && ok "no page-local .css" || fail "page-local stylesheet(s) under $PAGES: $(find "$PAGES" -name '*.css' | tr '\n' ' ')"
grep -rqE "from ['\"]@xyflow/react" "$PAGES" && fail "a search page imports @xyflow/react directly (use RecordGraph / OrgGraph)" || ok "no direct @xyflow/react import"
grep -rqE "from ['\"]d3-force" "$PAGES" portal/src/components 2>/dev/null && fail "portal still imports d3-force (the force layout belongs to the library)" || ok "no d3-force import in the portal"
grep -q '"d3-force"' portal/package.json && fail "portal/package.json still depends on d3-force" || ok "d3-force dropped from portal dependencies"

# ─────────────────────────────────────────────────────────────────────────────
section "library ownership (docs/search-workspace-goal.md ownership map)"
for c in ExplorerLayout RailSection RailNavList RecordResultList CitedRecordList RecordGraph OrgGraph; do
  grep -qE "\b$c\b" "$PAGE" 2>/dev/null && ok "SearchPage uses $c" || fail "SearchPage.tsx does not use $c"
done
grep -q "SubNavLayout" "$PAGE" 2>/dev/null && fail "SearchPage.tsx still uses SubNavLayout (the Search rail is ExplorerLayout + RailNavList)" || ok "no SubNavLayout"
grep -q "RichChatComposer" "$PAGES/SearchComposer.tsx" 2>/dev/null && ok "composer is RichChatComposer" || fail "SearchComposer.tsx is not on RichChatComposer"
# 2.439: the one composer is the library ConversationComposer (ContextComposer underneath; AgentComposerDock before 2.407).
grep -qE "<(ConversationComposer|AgentComposerDock)\b" "$PAGES/SearchComposer.tsx" 2>/dev/null && ok "SearchComposer hosts the library composer (ConversationComposer)" || fail "SearchComposer.tsx does not host the library composer (the initiative composer shell, decision 6)"
# AgentComposerDock is deprecated since ui-components 2.407.0 in favour of ContextComposer (same shell); accept either.
grep -qE "<(ConversationComposer|AgentComposerDock|ContextComposer)\b" portal/src/pages/projects/InitiativeComposer.tsx 2>/dev/null && ok "InitiativeComposer hosts the library composer shell (ConversationComposer)" || fail "InitiativeComposer.tsx does not host the library composer shell (one composer shell for both pages)"
grep -qE "hideModeMenu|fixedMode" "$PAGES/SearchComposer.tsx" 2>/dev/null && fail "SearchComposer hides the Agent ⌄ mode menu (hideModeMenu/fixedMode)" || ok "Agent ⌄ mode menu visible on Search"
{ [ -f "$PAGES/searchWorkflows.ts" ] && [ -f "$PAGES/__tests__/searchWorkflows.test.ts" ] && grep -q "searchWorkflows" "$PAGES/SearchComposer.tsx"; } 2>/dev/null && ok "Workflow ⌄ rows are pure searchWorkflows (tested)" || fail "searchWorkflows.ts + test missing or unused by SearchComposer"
{ [ -f "$PAGES/connectionsModel.ts" ] && [ -f "$PAGES/__tests__/connectionsModel.test.ts" ] && grep -q "connectionsView" "$PAGE"; } 2>/dev/null && ok "Connections view chosen by connectionsView() (tested)" || fail "connectionsModel.connectionsView or its test is missing, or SearchPage does not use it (decision 8)"
grep -q "focusIds" "$PAGE" 2>/dev/null && ok "a people selection focuses OrgGraph (focusIds)" || fail "SearchPage.tsx never passes focusIds to OrgGraph — a person selection must draw the org graph around that person"
for gone in portal/src/pages/ExplorePage.tsx portal/src/components/org-graph portal/src/components/multi-entity-graph "$PAGES/SearchConnections.tsx" "$PAGES/SearchEvidence.tsx" "$PAGES/searchConnections.css"; do
  [ -e "$gone" ] && fail "legacy still present: $gone (ported to the library — delete it)" || ok "gone: ${gone#portal/src/}"
done
# The exports must resolve from the installed package, not from a local copy.
LIB=portal/node_modules/@connorhoehnslalom/ui-components
if [ -d "$LIB/dist" ]; then
  for c in RecordResultList CitedRecordList RecordGraph OrgGraph Highlight AgentComposerDock RecordGraphCard; do
    grep -qE "export .*\b$c\b" "$LIB/dist/index.d.ts" "$LIB/dist/shared.d.ts" 2>/dev/null && ok "installed library exports $c" || fail "installed ui-components does not export $c (release + bump the pin)"
  done
  grep -qE '"github:connorhoehnslalom/ui-components#[0-9a-f]{40}"' portal/package.json && ok "portal pins ui-components by full sha" || fail "portal/package.json ui-components pin is not a full 40-char github sha"
else fail "ui-components not installed under portal/node_modules"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "information architecture"
grep -qE 'path="search" element=\{<Page element=\{<SearchPage' portal/src/App.tsx && ok "/iq/search mounted" || fail "App.tsx: /iq/search is not mounted on SearchPage"
n_redirect=$(grep -cE 'path="(search|invoke|explore|graph)" element=\{<Page element=\{<LegacySearchRedirect' portal/src/App.tsx)
[ "$n_redirect" -ge 4 ] && ok "legacy search/invoke/explore/graph paths redirect ($n_redirect)" || fail "App.tsx: only $n_redirect legacy paths redirect through LegacySearchRedirect (need search, invoke, explore, graph)"
grep -q "export function searchMigration" "$PAGES/searchModel.ts" 2>/dev/null && [ -f "$PAGES/__tests__/searchModel.test.ts" ] && ok "legacy URL migration is pure and tested" || fail "searchModel.searchMigration or its test is missing"
grep -qE "path: '/iq/search'" portal/src/components/shell/portalCommands.ts && ok "palette knows /iq/search" || fail "portalCommands.ts has no /iq/search entry"
grep -qE "path: '/iq/search'" portal/src/components/shell/Layout.tsx && ok "shell rail targets /iq/search" || fail "Layout.tsx rail does not target /iq/search"
grep -q "ScopeHeader" "$PAGE" 2>/dev/null && ok "crumbs on ScopeHeader" || fail "SearchPage.tsx has no ScopeHeader"
grep -q 'variant="inline"' "$PAGE" 2>/dev/null && ok "one header row: ScopeHeader variant=inline (decision 9)" || fail "SearchPage.tsx does not use ScopeHeader variant=\"inline\" — crumbs, title, tabs and controls belong on one row (decision 9)"
# Decision 9 amendment (2026-10-07): a long trail takes its own row — the
# library Breadcrumbs, never collapsed (no maxItems) — over the inline header.
if grep -q 'data-testid="search-trail"' "$PAGE" 2>/dev/null; then
  grep -E '<Breadcrumbs[^>]*data-testid="search-trail"' "$PAGE" | grep -q 'maxItems' && fail "the search trail collapses crumbs (maxItems) — it must read whole (decision 9 amendment)" || ok "two-row form: the trail row never collapses"
else fail "SearchPage.tsx has no search-trail row for long trails (decision 9 amendment)"; fi
grep -q '<SidePane' "$PAGE" 2>/dev/null && grep -q 'onClose={closePane}' "$PAGE" && grep -q 'readPaneState' "$PAGE" && ok "Ask about selection opens the shell's right pane (library SidePane, page-owned, the pane URL contract)" || fail "SearchPage.tsx does not host Ask about selection in the library SidePane (page-owned, readPaneState) (decision 9 amendment)"
grep -qE "\bSearchInput\b" "$PAGE" 2>/dev/null && fail "SearchPage.tsx still draws a hero SearchInput — the composer issues queries (decision 9)" || ok "no hero search field; the composer issues queries"
grep -q "RecordGraphCard" "$PAGE" 2>/dev/null && ok "Answer view carries RecordGraphCard" || fail "SearchPage.tsx does not use RecordGraphCard in the Answer view (decision 9)"
for tab in results answer connections; do grep -q "'$tab'" "$PAGE" 2>/dev/null || fail "SearchPage.tsx has no '$tab' tab"; done
ok "Results / Answer / Connections tabs named"
grep -q "Search entire workspace" "$PAGE" 2>/dev/null && ok "scoped header offers 'Search entire workspace'" || fail "SearchPage.tsx has no 'Search entire workspace' for a scoped search"
grep -rqE "/iq/search\?[^'\"\`]*scope=" portal/src/pages/ProjectDetailPage.tsx portal/src/pages/projects 2>/dev/null && ok "initiative pages link into a scoped search" || fail "no initiative page links to /iq/search?scope=<id>"
grep -q "See all" "$PAGE" 2>/dev/null || grep -q "See all" "$LIB/dist/index.js" 2>/dev/null && ok "grouped results carry 'See all'" || fail "no 'See all N' on grouped results"

# ─────────────────────────────────────────────────────────────────────────────
section "middleware contract"
ROUTER=middleware/src/routes/search.ts
grep -qF "'/'" "$ROUTER" && grep -qF "'/records'" "$ROUTER" && ok "GET / and GET /records mounted" || fail "routes/search.ts lacks '/' or '/records'"
grep -qE "sort" "$ROUTER" && grep -qE "relevance|recent" "$ROUTER" && ok "sort=relevance|recent validated" || fail "routes/search.ts does not validate a sort param (relevance | recent)"
grep -q "matchReason" middleware/src/providers/search.ts && ok "records carry matchReason" || fail "providers/search.ts: no matchReason on records"
grep -q "highlights" middleware/src/providers/search.ts && ok "records carry highlights" || fail "providers/search.ts: no highlights on records"
grep -q "matchReason" middleware/src/providers/__tests__/search.test.ts 2>/dev/null && ok "matchReason is tested" || fail "providers/__tests__/search.test.ts does not assert matchReason"
[ -f schema/search_workspace_schema.sql ] && grep -q "search_workspace_schema.sql" schema/load_schema.py && ok "schema registered" || fail "schema/search_workspace_schema.sql missing or not registered"
TESTS=middleware/src/routes/__tests__
missing=0
for pair in "search:searchRouter:/api/search" "saved-searches:savedSearchesRouter:/api/saved-searches"; do
  file=${pair%%:*}; rest=${pair#*:}; var=${rest%%:*}; base=${rest#*:}
  while IFS= read -r path; do
    [ "$path" = "/" ] && pat="" || pat=$(printf '%s' "$path" | sed -E 's#:[A-Za-z_]+#[^/?'"'"'"]+#g')
    if ! grep -rqE "${base}${pat}([?'\"/\`]|$)" "$TESTS"; then printf '      untested: %s%s\n' "$base" "$path"; missing=$((missing+1)); fi
  done < <(grep -oE "${var}\.(get|post|put|patch|delete)\('[^']+'" "middleware/src/routes/$file.ts" | sed -E "s/.*\('//; s/'$//" | sort -u)
done
[ "$missing" = 0 ] && ok "every mounted search route has a test" || fail "$missing mounted search routes have no test"

# ─────────────────────────────────────────────────────────────────────────────
section "journey audit (docs/search-journeys)"
JDIR=docs/search-journeys
ROLES=(member org-leader)
SURFACES=(results answer connections people scoped)
jmissing=0; jbad=0
for r in "${ROLES[@]}"; do for s in "${SURFACES[@]}"; do
  f="$JDIR/$r/$s.md"
  if [ ! -f "$f" ]; then jmissing=$((jmissing+1)); continue; fi
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
  grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
  grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
  grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
  case "$s" in results|scoped)
    frt=$(grep -ioE 'first-row-top[^0-9]*[0-9]+' "$f" | grep -oE '[0-9]+' | head -1)
    { [ -n "$frt" ] && [ "$frt" -le 640 ]; } || bad="$bad first-row-top(${frt:-missing})";;
  esac
  shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
  { [ -n "$shot" ] && [ -f "$JDIR/$r/$shot" ]; } || bad="$bad screenshot"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
  [ -n "$bad" ] && { jbad=$((jbad+1)); printf '      %s/%s:%s\n' "$r" "$s" "$bad"; }
done; done
[ "$jmissing" = 0 ] && ok "all 10 role×surface logs present" || fail "$jmissing of 10 journey logs missing (roles: ${ROLES[*]}; surfaces: ${SURFACES[*]})"
[ "$jbad" = 0 ] && ok "every present log passes all fields" || fail "$jbad journey logs fail a required field"
# Freshness (docs/journeys.md): a log is stale when the rendered contract of
# a route it walked changed since its walk was sealed (until 2026-10-08 this
# compared every log's mtime against the newest search page: any edit to any
# search file staled all ten).
if [ -d "$JDIR" ]; then
  source scripts/lib/journeys.sh
  jr_freshness "$JDIR" $(find "$JDIR" -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' 2>/dev/null | sort)
  jr_report
fi

section "docs"
[ -f docs/search-workspace.md ] && ok "docs/search-workspace.md exists" || fail "docs/search-workspace.md missing"
n_design=0; for p in results answer connections people-connections scoped-results; do [ -f "docs/design/search-$p-mockup.png" ] && n_design=$((n_design+1)); done
[ "$n_design" = 5 ] && ok "five design panels under docs/design" || fail "only $n_design of 5 search mockups under docs/design"
grep -qE "search-results-mockup|docs/design/search-" docs/search-workspace.md 2>/dev/null && ok "docs/search-workspace.md names the design files" || fail "docs/search-workspace.md does not reference docs/design/search-*.png"

# ─────────────────────────────────────────────────────────────────────────────
printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
echo "${#FAILS[@]} CHECK(S) FAILING:"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
