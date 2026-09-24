#!/usr/bin/env bash
# Definition of done for docs/distillation-goal.md. Exit 0 only when every
# check passes. Flags: --quick skips the slow suites (jest, vite build).
set -u
cd "$(dirname "$0")/.."
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
section "middleware"
if (cd middleware && npx tsc --noEmit >/dev/null 2>&1); then ok "tsc clean"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest src/routes/__tests__/distillation src/providers/__tests__/distillation >/dev/null 2>&1); then ok "jest (distillation suites) green"; else fail "middleware: distillation jest failures"; fi
fi

section "portal"
if (cd portal && npx tsc --noEmit >/dev/null 2>&1); then ok "tsc clean"; else fail "portal: tsc errors"; fi
if (cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts' >/dev/null 2>&1); then ok "node tests green"; else fail "portal: distillation node tests failing"; fi
if [ "$QUICK" = 0 ]; then
  if (cd portal && npx vite build >/dev/null 2>&1); then ok "vite build"; else fail "portal: vite build failed"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "component discipline (portal/src/pages/distillation)"
PAGES="portal/src/pages/distillation"
RAW_RE='<(div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre)( [^>]*)?className='
QUEUE=docs/ui-components-queue.md
QUEUED_FILES=$(grep -oE "Composed locally in \`portal/src/pages/distillation/[A-Za-z0-9_/.-]+\.tsx\`" "$QUEUE" 2>/dev/null | grep -oE "portal/src/pages/distillation/[A-Za-z0-9_/.-]+\.tsx" | sort -u)
PAGE_FILES=$(find "$PAGES" -name '*.tsx' | sort | grep -vxF -f <(printf '%s\n' $QUEUED_FILES))
count_in() { local re="$1"; shift; local n=0; for f in "$@"; do c=$(grep -oE "$re" "$f" | wc -l | tr -d ' '); n=$((n+c)); done; echo "$n"; }
n_raw=$(count_in "$RAW_RE" $PAGE_FILES)
n_sty=$(count_in 'style=\{\{' $PAGE_FILES)
q_over=""; for f in $QUEUED_FILES; do [ -f "$f" ] || continue; c=$(grep -oE "$RAW_RE" "$f" | wc -l | tr -d ' '); [ "$c" -le 12 ] || q_over="$q_over ${f#$PAGES/}($c)"; done
[ -z "$q_over" ] && ok "queued composites ≤ 12 raw elements each" || fail "queued composite over cap:$q_over"
if [ "$n_raw" = 0 ]; then ok "raw styled elements: 0"; else
  fail "raw styled elements in pages: $n_raw (must be 0 — use Stack/Inline/Card/DetailSection/PageSection/DataTable/Chip…)"
  for f in $PAGE_FILES; do c=$(grep -oE "$RAW_RE" "$f" | wc -l | tr -d ' '); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$PAGES/}"; done | sort -rn | head -8
fi
[ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}} in pages: $n_sty"

# ─────────────────────────────────────────────────────────────────────────────
section "information architecture (docs/distillation-redesign-spec.md §1)"
MODULE="$PAGES/DistillationModule.tsx"
{ [ -f "$MODULE" ] && grep -q "ScopeHeader" "$MODULE" && grep -q "data-shell-flush" "$MODULE"; } \
  && ok "one module frame: ScopeHeader, flush" || fail "no DistillationModule.tsx on ScopeHeader with data-shell-flush under $PAGES"
grep -rq "SubNavLayout" "$PAGES" && fail "SubNavLayout still used under $PAGES (the module has no second rail)" || ok "no SubNavLayout second rail"
[ -f "$PAGES/DistillationLayout.tsx" ] && fail "DistillationLayout.tsx still present (retired)" || ok "DistillationLayout retired"
{ grep -q "tabs" "$MODULE" && grep -q "dot:" "$MODULE" && grep -q "controls=" "$MODULE" && grep -q "/iq/library" "$MODULE"; } \
  && ok "header: tabs with live count + health dot, repo selector, Open Library" || fail "DistillationModule header lacks tabs/dot/controls/Library link"
grep -qE "path=\"distillation\"" portal/src/App.tsx && ok "/iq/distillation is a route tree" || fail "App.tsx: /iq/distillation is not a nested route tree"
for s in knowledge review activity; do
  grep -qE "path=\"$s\"" portal/src/App.tsx || fail "App.tsx: no route for /iq/distillation/$s"
done
for s in overview tiers artifacts lineage compactions; do
  grep -qE "path=\"$s\" element=\{<DistillationLegacyRedirect" portal/src/App.tsx || fail "App.tsx: legacy /iq/distillation/$s does not redirect (old links must keep working)"
done
grep -qE "<Route index element=\{<DistillationLegacyRedirect" portal/src/App.tsx && ok "legacy routes + module root redirect into the new IA" || fail "App.tsx: /iq/distillation index does not redirect"
grep -q "export function migrateDistillationUrl" "$PAGES/distillationRoutes.ts" 2>/dev/null && [ -f "$PAGES/__tests__/distillationRoutes.test.ts" ] \
  && ok "migration mapping is pure and tested" || fail "distillationRoutes.migrateDistillationUrl or its test is missing"
pal=$(grep -cE "path: '/iq/distillation/(knowledge|review|activity)'" portal/src/components/shell/portalCommands.ts)
[ "$pal" -ge 3 ] && ok "palette knows the 3 destinations" || fail "portalCommands.ts lists $pal of 3 distillation destinations"
grep -qE "path: '/iq/distillation/knowledge'" portal/src/components/shell/Layout.tsx && ok "shell rail targets Knowledge" || fail "shell rail does not target /iq/distillation/knowledge"
grep -rqE "/iq/library" $PAGES/*.tsx && ok "records link into the Library" || fail "no /iq/library link in distillation pages (guides must link to the asset they became)"
n_canvas=$(grep -l "TypedNodeCanvas" $PAGES/*.tsx 2>/dev/null | wc -l | tr -d ' ')
[ "$n_canvas" -ge 2 ] && ok "graphs on the library TypedNodeCanvas ($n_canvas files: Sources lineage + Activity tier graph)" || fail "TypedNodeCanvas used in $n_canvas distillation files (need Sources graph + tier graph)"
grep -rqE "from ['\"]@xyflow/react['\"]" "$PAGES" && fail "a distillation page imports @xyflow/react directly (use TypedNodeCanvas)" || ok "no hand-rolled xyflow canvas"
grep -q "controls={false}" $PAGES/*.tsx && fail "a canvas hides its CanvasZoomControls" || ok "canvases keep their zoom controls"
grep -q "CanvasPaneLayout" "$PAGES/ActivityTab.tsx" 2>/dev/null && ok "Activity: canvas + run inspector in CanvasPaneLayout" || fail "ActivityTab does not use CanvasPaneLayout"
{ grep -q "SourceList" "$PAGES/SourcesPanel.tsx" && grep -q "SegmentedControl" "$PAGES/SourcesPanel.tsx"; } 2>/dev/null \
  && ok "Sources inspector: List | Graph" || fail "SourcesPanel lacks SourceList + List/Graph switch"
{ grep -q "ExplorerLayout" "$PAGES/KnowledgeTab.tsx" && grep -q "ExplorerLayout" "$PAGES/ReviewTab.tsx" && grep -q "ContextColumn" "$PAGES/KnowledgeTab.tsx"; } 2>/dev/null \
  && ok "Knowledge + Review: explorer · record · ContextColumn" || fail "Knowledge/Review are not ExplorerLayout + ContextColumn"
grep -q "Load more" "$PAGES/KnowledgeTab.tsx" 2>/dev/null && ok "explorer keeps cursor Load more" || fail "Knowledge explorer lost cursor Load more"
{ grep -q "can('ManageBots')" "$PAGES/ReviewTab.tsx" && grep -q "AccessNotice" "$PAGES/ReviewTab.tsx"; } 2>/dev/null \
  && ok "Review: verdicts gated on ManageBots, read-only notice otherwise" || fail "ReviewTab does not gate verdicts on can('ManageBots') with an AccessNotice"
{ grep -q "RichChatComposer" "$PAGES/ExplainComposer.tsx" && grep -q "/iq/invoke" "$PAGES/ExplainComposer.tsx"; } 2>/dev/null \
  && ok "docked composer explains via Ask (no writes)" || fail "ExplainComposer missing or not routed to /iq/invoke"
grep -rq "useDistillationChannel" "$PAGES" && [ -f portal/src/hooks/useDistillationChannel.ts ] && ok "live data over useDistillationChannel" || fail "pages do not use useDistillationChannel"
for m in distillationRoutes tierFlowModel reviewQueueModel sourcesModel procedureRunsModel knowledgeModel activityModel distillationChannel; do
  [ -f "$PAGES/$m.ts" ] && [ -f "$PAGES/__tests__/$m.test.ts" ] || fail "pure model $m.ts or its node:test is missing"
done
ok "pure models have node:test coverage"
grep -rq "distillation/library/" portal/src/pages/library 2>/dev/null && grep -rq "Distilled from" portal/src/pages/library 2>/dev/null && ok "Library shows provenance" || fail "Library detail has no 'Distilled from' section reading /api/distillation/library/:id/provenance"

# ─────────────────────────────────────────────────────────────────────────────
section "middleware contract"
ROUTER=middleware/src/routes/distillation.ts
for p in "/items" "/items/:id" "/items/:id/lineage" "/artifacts" "/review" "/review/:id" "/library/:libraryItemId/provenance" "/procedures" "/procedures/:id" "/procedures/:id/applications" "/procedures/:id/apply" \
         "/facets" "/items/:id/sources" "/sessions/:id" "/procedures/:id/runs" "/replication" "/compactions/:id"; do
  grep -qF "'$p'" "$ROUTER" || fail "route missing: $p"
done
grep -qE "produced\??: *\{" middleware/src/providers/distillation.ts && grep -q "artifact_ids" middleware/src/providers/distillation.ts && ok "compaction jobs carry produced{}" || fail "CompactionJob has no produced{cluster_ids,artifact_ids}"
[ -f schema/distillation_schema.sql ] && grep -q "distillation_schema.sql" schema/load_schema.py && ok "schema registered" || fail "schema/distillation_schema.sql missing or not registered in load_schema.py"
TESTS=middleware/src/routes/__tests__
missing=0
while IFS= read -r path; do
  pat=$(printf '%s' "$path" | sed -E 's#:[A-Za-z_]+#[^/?'"'"'"]+#g')
  if ! grep -rqE "/api/distillation${pat}" "$TESTS"; then printf '      untested: %s\n' "$path"; missing=$((missing+1)); fi
done < <(grep -oE "distillationRouter\.(get|post|put|patch|delete)\('[^']+'" "$ROUTER" | sed -E "s/.*\('//; s/'$//" | sort -u)
[ "$missing" = 0 ] && ok "every mounted route has a test" || fail "$missing mounted distillation routes have no test"
# mock richness — the contract's minimums
mock=middleware/src/mock/distillation.ts
if [ -f "$mock" ]; then
  # facts are written two ways: `id: 'fact-…'` rows and the `['fact-…', …]` tuples the steps() helper takes
  na=$(grep -cE "^\s+id: '(art|artifact)-" "$mock"); nf=$(grep -cE "^\s+(id: |\[)'fact-" "$mock"); nc=$(grep -cE "^\s+id: '(cl|cluster)-" "$mock")
  np=$(grep -cE "^\s+type: 'procedure'" "$mock"); napp=$(grep -cE "^\s+applied\('art-" "$mock")
  [ "$na" -ge 8 ] && ok "≥ 8 artifacts in mock ($na)" || fail "mock has $na artifacts (need ≥ 8)"
  [ "$nc" -ge 18 ] && ok "≥ 18 clusters in mock ($nc)" || fail "mock has $nc clusters (need ≥ 18)"
  [ "$nf" -ge 12 ] && ok "≥ 12 facts in mock ($nf)" || fail "mock has $nf facts (need ≥ 12)"
  [ "$np" -ge 3 ] && ok "≥ 3 procedures in mock ($np)" || fail "mock has $np procedures (need ≥ 3)"
  [ "$napp" -ge 5 ] && ok "≥ 5 procedure applications in mock ($napp)" || fail "mock has $napp procedure applications (need ≥ 5)"
  grep -q "isProceduralChunk" middleware/src/providers/distillation.ts && grep -q "procedureHealth" middleware/src/providers/distillation.ts && ok "procedure minting + health rules present" || fail "isProceduralChunk / procedureHealth missing from the provider"
else fail "middleware/src/mock/distillation.ts missing"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "journey audit (docs/distillation-journeys)"
JDIR=docs/distillation-journeys
ROLES=(member org-leader)
SURFACES=(knowledge review activity)
jmissing=0; jbad=0
for r in "${ROLES[@]}"; do for s in "${SURFACES[@]}"; do
  f="$JDIR/$r/$s.md"
  if [ ! -f "$f" ]; then jmissing=$((jmissing+1)); continue; fi
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
  grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
  # Density: list surfaces must put the first data row above the fold.
  case "$s" in knowledge|review|activity)
    frt=$(grep -ioE 'first-row-top[^0-9]*[0-9]+' "$f" | grep -oE '[0-9]+' | head -1)
    { [ -n "$frt" ] && [ "$frt" -le 640 ]; } || bad="$bad first-row-top(${frt:-missing})";;
  esac
  grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
  grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
  shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
  { [ -n "$shot" ] && [ -f "$JDIR/$r/$shot" ]; } || bad="$bad screenshot"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
  [ -n "$bad" ] && { jbad=$((jbad+1)); printf '      %s/%s:%s\n' "$r" "$s" "$bad"; }
done; done
[ "$jmissing" = 0 ] && ok "all 6 role×surface logs present" || fail "$jmissing of 6 journey logs missing (roles: ${ROLES[*]}; surfaces: ${SURFACES[*]})"
[ "$jbad" = 0 ] && ok "every present log passes all fields" || fail "$jbad journey logs fail a required field"
# Freshness, per surface: a log must be newer than the newest .tsx among the
# files/dirs its own `pages:` line names — the same rule the orgiq audit uses.
# A log with no `pages:` line falls back to the global "newest page edit",
# so the check can never be dodged by omitting the line.
if [ -d "$JDIR" ]; then
  newest_global=$(ls -t $(find "$PAGES" -name '*.tsx') 2>/dev/null | head -1)
  newest_in() { # newest .tsx among comma-separated files/dirs
    local newest=""; IFS=',' read -ra items <<< "$1"
    for d in "${items[@]}"; do d=$(echo "$d" | tr -d ' '); [ -n "$d" ] || continue
      if [ -f "$d" ]; then { [ -z "$newest" ] || [ "$d" -nt "$newest" ]; } && newest="$d"; continue; fi
      [ -d "$d" ] || continue
      f=$(ls -t $(find "$d" -name '*.tsx' 2>/dev/null) 2>/dev/null | head -1)
      [ -n "$f" ] && { [ -z "$newest" ] || [ "$f" -nt "$newest" ]; } && newest="$f"
    done; echo "$newest"
  }
  stale=0; stale_names=""
  # Only the current surfaces are judged; logs for surfaces the 2026-09-24
  # redesign retired (overview, tiers, artifacts, lineage, compactions) are
  # history and are not re-audited.
  for f in $(for r in "${ROLES[@]}"; do for s in "${SURFACES[@]}"; do [ -f "$JDIR/$r/$s.md" ] && echo "$JDIR/$r/$s.md"; done; done); do
    pages=$(grep -iE '^pages: *' "$f" | head -1 | sed -E 's/^pages: *//')
    ref=$([ -n "$pages" ] && newest_in "$pages" || echo "$newest_global")
    # A `pages:` line naming only files that no longer exist (a retired
    # surface) proves nothing — judge it against the newest page instead.
    [ -z "$ref" ] && ref="$newest_global"
    [ -n "$ref" ] && [ "$ref" -nt "$f" ] && { stale=$((stale+1)); stale_names="$stale_names ${f#$JDIR/}(${ref##*/})"; }
  done
  [ "$stale" = 0 ] && ok "journey logs are newer than the pages their surface renders from" || fail "$stale journey logs predate a page they render from — re-audit them:$stale_names"
fi

section "docs"
[ -f docs/distillation.md ] && ok "docs/distillation.md exists" || fail "docs/distillation.md missing (tiers, compaction, artifact → Library, reading lineage)"
grep -qE "Knowledge.*Review.*Activity" docs/distillation.md 2>/dev/null && ok "docs/distillation.md describes Knowledge / Review / Activity" || fail "docs/distillation.md does not describe the Knowledge / Review / Activity IA"

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — distillation meets its definition of done."
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
