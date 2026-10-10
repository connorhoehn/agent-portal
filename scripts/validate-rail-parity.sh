#!/usr/bin/env bash
# Judge for docs/rail-parity-goal.md — every second rail is the concise
# stacked rail (`StackedRail`), the Org tenant's family.
#
#   ./scripts/validate-rail-parity.sh           # everything, incl. the headless measurement
#   ./scripts/validate-rail-parity.sh --quick   # static checks only
#
# Exit 0 only when every check passes; every failing line is printed.
set -u
cd "$(dirname "$0")/.."
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done
FAILS=()
# Logs land in RAIL_PARITY_LOG_DIR (default /tmp) so concurrent lanes can keep
# their own copies.
LOGDIR=${RAIL_PARITY_LOG_DIR:-/tmp}
mkdir -p "$LOGDIR"
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }
has()  { grep -qE "$1" "$2" 2>/dev/null; }

RAIL=portal/src/pages/assessment/knowledge/DocumentRail.tsx
GOAL=docs/rail-parity-goal.md
DTS=portal/node_modules/@connorhoehnslalom/ui-components/dist/index.d.ts

section "library — StackedRail is installed"
if [ -f "$DTS" ] && has "export declare function StackedRail" "$DTS"; then ok "StackedRail exported by the installed ui-components"; else fail "installed ui-components has no StackedRail export ($DTS)"; fi

section "assessment documents rail composes StackedRail"
has "StackedRail" "$RAIL" && ok "$RAIL imports StackedRail" || fail "$RAIL: no StackedRail"
for banned in "WorkspaceRail" "KeyboardTreeView" "TreeView size=\"rail\"" "ConversationShelf"; do
  has "$banned" "$RAIL" && fail "$RAIL: still composes $banned (the card-panel family)" || ok "$RAIL: no $banned"
done
for kept in "pull" "New page" "usePresence" "onDrag|draggable|onReorder"; do
  has "$kept" "$RAIL" && ok "$RAIL keeps: $kept" || fail "$RAIL lost: $kept (decision 2)"
done

section "social chat workspace — the chat-rail variant (decision 6)"
WS=portal/src/pages/social/SocialChatWorkspace.tsx
SOCIAL_PAGES="channels:ChannelsPage dms:DmsPage teams:TeamsPage rooms:RoomsPage calls:CallsPage recordings:RecordingsPage"
if [ -f "$WS" ]; then
  has "data-shell-flush" "$WS" && ok "$WS: page root is data-shell-flush" || fail "$WS: no data-shell-flush (the shell keeps its 24px ring and crumbs)"
  has "<ConversationRail" "$WS" && ok "$WS composes the library's ConversationRail" || fail "$WS: no ConversationRail"
  has "PageHeader" "$WS" && fail "$WS: a PageHeader sits above the rail" || ok "$WS: no PageHeader above the rail"
  for c in "sectionOrder=\"dms-first\"" "ActivePeopleGrid" "TeamChannelTree" "SocialRoomsSection" "shelf=\{"; do
    has "$c" "$WS" && ok "$WS: $c" || fail "$WS lacks $c"
  done
else fail "$WS missing"; fi
for pair in $SOCIAL_PAGES; do
  f="portal/src/pages/social/${pair#*:}.tsx"; r="${pair%%:*}"
  has "<SocialChatWorkspace route=\"$r\"" "$f" && ok "$f renders the chat workspace (route $r)" || fail "$f does not render <SocialChatWorkspace route=\"$r\">"
done

section "Communication — the Social plane in orgiq/assessment/pipelines, chat-rail frame + trail (docs/social-tenant-design.md §4.6)"
CP=portal/src/pages/communication/CommunicationPlane.tsx
if [ -f "$CP" ]; then
  for c in "data-shell-flush" "<SocialChatWorkspace" "SocialPlaneContext" "<SectionContent" "communication-no-social"; do
    has "$c" "$CP" && ok "$CP: $c" || fail "$CP lacks $c"
  done
else fail "$CP missing"; fi

section "goal doc records the adoption"
for row in "ui-components release: \`?[0-9]+\.[0-9]+\.[0-9]+" "aws-agentcore \`DocumentRail.tsx\`: [0-9a-f]{7,}" "realtime-examples \`DocumentExplorer.tsx\`: [0-9a-f]{7,}" "social chat workspace .*/social/channels.*x=200"; do
  has "$row" "$GOAL" && ok "recorded: $row" || fail "$GOAL: not recorded yet: $row"
done

section "layout cascade — two rails, crumbs first, the list a flush rail (docs/layout-cascade.md)"
CASCADE_DOC=docs/layout-cascade.md
[ -f "$CASCADE_DOC" ] && ok "$CASCADE_DOC records the contract" || fail "$CASCADE_DOC missing"
has "flush list rail stacked beside the section rail" "$CASCADE_DOC" && ok "$CASCADE_DOC: rule 5 is the flush list rail" || fail "$CASCADE_DOC: rule 5 does not say the list is a flush list rail beside the section rail"
SC=portal/src/components/shell/SectionContent.tsx
{ has "<ScopeHeader" "$SC" && has "PageHeader" "$SC" && has "export function SectionHeader" "$SC" && ! has "<ExplorerLayout" "$SC"; } \
  && ok "$SC: trail → title → body (SectionHeader); the list rail is the library ListRailLayout, not a local ExplorerLayout" \
  || fail "$SC: not the crumbs → title → body cascade (SectionHeader), or it composes its own ExplorerLayout list rail again"
# The list never floats: the bordered, rounded in-content list pane is retired.
floating=$(grep -rlE "SECTION_LIST_PANE" portal/src --include='*.tsx' --include='*.ts' | sort)
[ -z "$floating" ] && ok "no bordered list pane (SECTION_LIST_PANE) anywhere" || fail "a list still floats in a bordered pane: $(echo $floating)"
# Every list page draws the shared list rail, never its own ExplorerLayout.
for f in portal/src/components/shell/StackedCatalogLayout.tsx portal/src/pages/distillation/KnowledgeTab.tsx portal/src/pages/distillation/ReviewTab.tsx portal/src/pages/promotions/PromotionsPage.tsx portal/src/pages/distillation/ActivityTab.tsx; do
  has "<ListRailLayout" "$f" && ok "$f composes ListRailLayout (the library list rail)" || fail "$f does not compose ListRailLayout (the shared list rail)"
  has "<ExplorerLayout" "$f" && fail "$f composes its own ExplorerLayout (use ListRailLayout)" || ok "$f: no ExplorerLayout of its own"
done
# Distillation: no repository button in the content header; the repository
# is a facet in each list rail's filter popover (distillation-redesign-spec §1).
DM=portal/src/pages/distillation/DistillationModule.tsx
{ has "repoFacet" "$DM" && ! has "distillation-repo" "$DM" && ! has "controls=\{" "$DM"; } \
  && ok "$DM: the repository is a rail filter facet, not a header control" || fail "$DM: the repository selector is still a content-header control"
grep -lE "scope\.controls" portal/src/pages/distillation/*.tsx portal/src/pages/promotions/*.tsx >/dev/null 2>&1 \
  && fail "a distillation page still hangs scope.controls in its header" || ok "no distillation page hangs a repository control in its header"
grep -qE "EmptyState[^>]*Explore distillation|title=\"Browse \\$\{" portal/src/pages/distillation/DistillationModule.tsx portal/src/components/shell/StackedCatalogLayout.tsx \
  && fail "a section landing is still a bare placeholder" || ok "section landings show content, not a placeholder"
# No page composes its own breadcrumb row: the trail comes from the shell row,
# SectionContent, or a shell layout. Ratchet on the pages that still do.
CASCADE_PAGE_CRUMBS_BUDGET=4
page_crumbs=$(grep -rlE "<Breadcrumbs\b|<ScopeHeader\b" portal/src/pages --include='*.tsx' | wc -l | tr -d ' ')
[ "$page_crumbs" -le "$CASCADE_PAGE_CRUMBS_BUDGET" ] && ok "pages composing their own trail: $page_crumbs (budget $CASCADE_PAGE_CRUMBS_BUDGET)" \
  || { fail "pages composing their own trail: $page_crumbs > budget $CASCADE_PAGE_CRUMBS_BUDGET"; grep -rlE "<Breadcrumbs\b|<ScopeHeader\b" portal/src/pages --include='*.tsx' | sed 's/^/      /'; }
# Rule 8: on a deep page the primary rail gives way, never the section rail —
# one rule, the library rail model (ui-components railDepth / useRailFold /
# SubNavLayout collapsed, tested there), declared and read by Layout.tsx; no
# local copy of the rule, and no app.css reaching into the library's DOM
# (audit J7: no !important, no test-id selectors for the fold).
LAYOUT=portal/src/components/shell/Layout.tsx
{ has "railDepth" "$LAYOUT" && has "useRailFold" "$LAYOUT" && has "collapsed=\{primaryRail.folded\}" "$LAYOUT" && has "data-primary-rail" "$LAYOUT" \
  && [ ! -f portal/src/components/shell/railCollapseModel.ts ] && [ ! -f portal/src/components/shell/useShellRails.ts ]; } \
  && ok "rail collapse priority is the library rail model, declared in Layout.tsx (railDepth → useRailFold → SubNavLayout collapsed)" \
  || fail "rail collapse rule: Layout.tsx must declare railDepth + useRailFold + SubNavLayout collapsed, with no local railCollapseModel/useShellRails"
grep -q '!important' portal/src/app.css && fail "portal/src/app.css carries !important (audit J7)" || ok "portal/src/app.css: no !important"
grep -qE 'data-primary-rail|shell-rail-toggle' portal/src/app.css && fail "portal/src/app.css folds the primary rail itself (the library SubNavLayout collapsed owns it)" || ok "portal/src/app.css: the fold is the library's"
# The pane model (audit H4): one right pane, the library SidePane; no local pane model or global signal.
{ [ ! -f portal/src/components/shell/conversationPaneModel.ts ] && [ ! -f portal/src/components/shell/shellPaneSignal.ts ] \
  && ! grep -rqE "PageConversationPane|publishShellPaneOpen|\?selection=<kind>" portal/src --include='*.tsx' --include='*.ts'; } \
  && ok "the right pane is the library SidePane (no conversationPaneModel / shellPaneSignal / PageConversationPane)" \
  || fail "a local pane model is back (conversationPaneModel / shellPaneSignal / PageConversationPane)"
pane_keys=$(grep -rnE "localStorage\.(get|set)Item\(['\"][^'\"]*\.pane\." portal/src --include='*.ts' --include='*.tsx' | wc -l | tr -d ' ')
[ "$pane_keys" -eq 0 ] && ok "no page-local pane storage keys (*.pane.*)" || fail "page-local pane storage keys: $pane_keys (the library pane model remembers the pane)"
has "paneFolded" portal/src/pages/projects/InitiativesExplorer.tsx && fail "InitiativesExplorer folds the section rail itself (paneFolded) — the shell folds the primary rail first" || ok "no page folds its section rail ahead of the primary rail"
[ -f portal/e2e/route-inventory.ts ] && [ -f portal/e2e/layout-cascade.spec.ts ] && ok "route inventory + sweep spec present" || fail "portal/e2e/route-inventory.ts or layout-cascade.spec.ts missing"
# One route inventory (audit 2026-10-07 T4): the sweeps and this judge's
# measurement read portal/e2e/route-inventory.ts; no second list may appear.
inv_forks=$(grep -lE "staticInventory|readFileSync\([^)]*components/shell|matchAll\(/\\bpath:" portal/e2e/*.spec.ts 2>/dev/null | xargs grep -L "from './route-inventory'" 2>/dev/null)
[ -z "$inv_forks" ] && ok "every route sweep reads portal/e2e/route-inventory.ts" || fail "a spec builds its own route list:$(echo $inv_forks | sed 's#portal/e2e/##g')"

section "type scale — 20 title / 14 headings+body / 12 meta down every page (portal/e2e/type-scale-sweep.spec.ts)"
TS_SPEC=portal/e2e/type-scale-sweep.spec.ts
TS_BURN=portal/e2e/type-scale-burndown.tsv
# The ceiling: 674 at the 2026-10-07 adoption, 599 after the 2026-10-08 prune; it only goes down, and the burn-down's dates move it to zero.
TYPE_SCALE_BASELINE_BUDGET=599
[ -f "$TS_SPEC" ] && has "route-inventory" "$TS_SPEC" && ok "$TS_SPEC sweeps the route inventory" || fail "$TS_SPEC missing or not driven by route-inventory.ts"
if [ -f "$TS_BURN" ]; then
  TS_V=$(node portal/e2e/burndown.ts check "$TS_BURN")
  ts_count=$(printf '%s\n' "$TS_V" | awk '/^TOTAL / {print $2}')
  if printf '%s\n' "$TS_V" | grep -q '^INVALID '; then fail "$TS_BURN has malformed rows"; printf '%s\n' "$TS_V" | grep '^INVALID ' | head -5 | sed 's/^/      /'
  elif [ "$ts_count" -le "$TYPE_SCALE_BASELINE_BUDGET" ]; then ok "type-scale burn-down: $ts_count offenders (ceiling $TYPE_SCALE_BASELINE_BUDGET — may only shrink)"
  else fail "type-scale burn-down grew: $ts_count > ceiling $TYPE_SCALE_BASELINE_BUDGET — fix the page, never add a row"; fi
  past=$(printf '%s\n' "$TS_V" | grep -c '^PASTDUE ')
  [ "$past" = 0 ] && ok "no type-scale burn-down row past its due date" || { fail "$past type-scale burn-down rows past their due date — fix those pages"; printf '%s\n' "$TS_V" | awk -F'\t' '/^PASTDUE / { sub(/^PASTDUE /, "", $1); print "      " $1 " · " $2 " (" $4 ", due " $5 ")" }' | head -20; }
  printf '      remaining by owner surface (due):\n'
  printf '%s\n' "$TS_V" | awk -F'\t' '/^OWNER / { sub(/^OWNER /, "", $1); n++; if (n <= 12) printf "        %-34s %4s  %s\n", $1, $2, $3; else rest += $2 } END { if (n > 12) printf "        … %d more surfaces, %d offenders\n", n - 12, rest }'
  for r in /iq/communication /assessment/communication /pipelines/communication; do
    # The one exception is the library ActivePeopleGrid's 11/500 tile names in the overview (docs/ui-components-queue.md, 2026-10-07).
    awk -F'\t' -v r="$r" '!/^#/ && $1==r && $2 ~ / content / && $2 != "scale content 11/500" { bad=1 } END { exit bad }' "$TS_BURN" \
      && ok "$r: no content-column offender baselined (beyond the queued ActivePeopleGrid tile names)" || fail "$r: the burn-down still lists content-column offenders"
  done
else fail "$TS_BURN missing"; fi

if [ "$QUICK" = 0 ]; then
  section "measurement — rails, cascade and type scale, recorded as each route's rendered contract (scripts/journeys/measure.sh)"
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in "  ✗ "*) FAILS+=("${line#  ✗ }");; esac
  done < <(RAIL_PARITY_LOG_DIR="$LOGDIR" bash scripts/journeys/measure.sh)
fi

echo
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS — every second rail is the concise stacked rail."; exit 0; fi
echo "${#FAILS[@]} CHECK(S) FAILING:"; for f in "${FAILS[@]}"; do echo "  - $f"; done; exit 1
