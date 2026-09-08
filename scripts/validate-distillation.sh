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
section "information architecture"
LAYOUT="$PAGES/DistillationLayout.tsx"
[ -f "$LAYOUT" ] && grep -q "SubNavLayout" "$LAYOUT" && ok "DistillationLayout on SubNavLayout" || fail "no DistillationLayout.tsx using SubNavLayout under $PAGES"
for s in overview tiers artifacts lineage compactions review; do
  grep -qE "path=\"$s\"" portal/src/App.tsx || fail "App.tsx: no route for /iq/distillation/$s"
done
grep -qE "path=\"distillation\"" portal/src/App.tsx && ok "/iq/distillation is a route tree" || fail "App.tsx: /iq/distillation is not a nested route tree"
grep -qE "Navigate to=\"(/iq/distillation/)?overview\"" portal/src/App.tsx && ok "/iq/distillation redirects to overview" || fail "App.tsx: /iq/distillation does not redirect to overview"
pal=$(grep -cE "path: '/iq/distillation/(overview|tiers|artifacts|lineage|compactions|review)'" portal/src/components/shell/portalCommands.ts)
[ "$pal" -ge 6 ] && ok "palette knows the 6 distillation pages" || fail "portalCommands.ts lists $pal of 6 distillation pages"
grep -qE "/iq/library/" $PAGES/*.tsx $PAGES/**/*.tsx 2>/dev/null && ok "artifacts link into the Library" || fail "no /iq/library/ link in distillation pages (artifacts must link to the runbook/skill they became)"
grep -rq "@xyflow/react" "$PAGES" && ok "lineage graph uses @xyflow/react" || fail "no @xyflow/react lineage view under $PAGES"
grep -rqE "focus" "$PAGES"/Lineage*.tsx 2>/dev/null && ok "lineage honours ?focus=" || fail "Lineage page has no ?focus= deep link"
{ [ -f "$PAGES/CompactionFlow.tsx" ] && grep -q "@xyflow/react" "$PAGES/CompactionFlowFrame.tsx" 2>/dev/null && grep -q "CompactionFlow" "$PAGES/CompactionsPage.tsx"; } && ok "compaction flow visualization on Compactions" || fail "no CompactionFlow (xyflow tier ladder, animated while a job runs) mounted on CompactionsPage"
grep -rq "distillation/library/" portal/src/pages/library 2>/dev/null && grep -rq "Distilled from" portal/src/pages/library 2>/dev/null && ok "Library shows provenance" || fail "Library detail has no 'Distilled from' section reading /api/distillation/library/:id/provenance"

# ─────────────────────────────────────────────────────────────────────────────
section "middleware contract"
ROUTER=middleware/src/routes/distillation.ts
for p in "/items" "/items/:id" "/items/:id/lineage" "/artifacts" "/review" "/review/:id" "/library/:libraryItemId/provenance"; do
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
  na=$(grep -cE "^\s+id: '(art|artifact)-" "$mock"); nf=$(grep -cE "^\s+id: 'fact-" "$mock"); nc=$(grep -cE "^\s+id: '(cl|cluster)-" "$mock")
  [ "$na" -ge 8 ] && ok "≥ 8 artifacts in mock ($na)" || fail "mock has $na artifacts (need ≥ 8)"
  [ "$nc" -ge 18 ] && ok "≥ 18 clusters in mock ($nc)" || fail "mock has $nc clusters (need ≥ 18)"
  [ "$nf" -ge 12 ] && ok "≥ 12 facts in mock ($nf)" || fail "mock has $nf facts (need ≥ 12)"
else fail "middleware/src/mock/distillation.ts missing"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "journey audit (docs/distillation-journeys)"
JDIR=docs/distillation-journeys
ROLES=(member org-leader)
SURFACES=(overview tiers artifacts lineage compactions review)
jmissing=0; jbad=0
for r in "${ROLES[@]}"; do for s in "${SURFACES[@]}"; do
  f="$JDIR/$r/$s.md"
  if [ ! -f "$f" ]; then jmissing=$((jmissing+1)); continue; fi
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
  grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
  # Density: list surfaces must put the first data row above the fold.
  case "$s" in tiers|artifacts|compactions|review)
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
[ "$jmissing" = 0 ] && ok "all 12 role×surface logs present" || fail "$jmissing of 12 journey logs missing (roles: ${ROLES[*]}; surfaces: ${SURFACES[*]})"
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
  for f in $(find "$JDIR" -name '*.md' ! -name 'DEFECTS.md' ! -name 'PROTOCOL.md' 2>/dev/null); do
    pages=$(grep -iE '^pages: *' "$f" | head -1 | sed -E 's/^pages: *//')
    ref=$([ -n "$pages" ] && newest_in "$pages" || echo "$newest_global")
    [ -n "$ref" ] && [ "$ref" -nt "$f" ] && { stale=$((stale+1)); stale_names="$stale_names ${f#$JDIR/}(${ref##*/})"; }
  done
  [ "$stale" = 0 ] && ok "journey logs are newer than the pages their surface renders from" || fail "$stale journey logs predate a page they render from — re-audit them:$stale_names"
fi

section "docs"
[ -f docs/distillation.md ] && ok "docs/distillation.md exists" || fail "docs/distillation.md missing (tiers, compaction, artifact → Library, reading lineage)"

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — distillation meets its definition of done."
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
