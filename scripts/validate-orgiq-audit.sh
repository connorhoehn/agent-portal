#!/usr/bin/env bash
# Definition of done for docs/orgiq-audit-goal.md. Exit 0 only when every
# check passes. --quick skips the slow suites (node tests, vite build).
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
QUICK=0
for a in "$@"; do case "$a" in
  --quick) QUICK=1;;
  # --seal is retired: one helper seals, after a walk (scripts/journeys/seal.sh).
  --seal) echo "--seal is retired: walk the logs, then run scripts/journeys/seal.sh <dir> (docs/journeys.md)" >&2; exit 2;;
esac; done
FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
section "builds"
if jg_portal_tsc >/dev/null 2>&1; then ok "portal tsc"; else fail "portal: tsc errors"; fi
if jg_mw_tsc >/dev/null 2>&1; then ok "middleware tsc"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd portal && node --test 'src/**/__tests__/*.test.ts' >/dev/null 2>&1); then ok "portal node tests"; else fail "portal: node tests failing"; fi
  if jg_vite_build >/dev/null 2>&1; then ok "portal vite build"; else fail "portal: vite build failed"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "component discipline (all of portal/src/pages, ratchet)"
PAGES=portal/src/pages
BUDGET_FILE=scripts/orgiq-raw-budget.txt
BUDGET_START=1114
BUDGET_DONE=60
# The one raw-element counter (scripts/lib/discipline.sh, shared with
# validate-component-discipline.sh): across line breaks AND brace-aware — the
# perl slurp this used could not see past an arrow function in an onClick.
source scripts/lib/discipline.sh
QUEUED_FILES=$(dc_queued_files "$PAGES/")
PAGE_FILES=$(dc_area_files "$PAGES" "$PAGES/")
count_in() { dc_count_re "$@"; }
raw_in_file() { dc_count_raw "$1"; }
n_raw=$(dc_count_raw $PAGE_FILES)
# Any JSX style prop counts — `style={{…}}` AND `style={hoistedConst}`; hoisting
# an inline style into a named const is the same hand-rolled CSS.
n_sty=$(count_in 'style=\{' $PAGE_FILES)
n_btn=$(count_in '<button' $PAGE_FILES)
budget=$(cat "$BUDGET_FILE" 2>/dev/null | tr -d ' \n')
if [ -z "$budget" ]; then fail "$BUDGET_FILE missing (write the current budget, starting at $BUDGET_START)"; budget=$BUDGET_START; fi
if [ "$budget" -gt "$BUDGET_START" ]; then fail "budget $budget was raised above the $BUDGET_START baseline — it may only go down"; fi
if [ "$n_raw" -le "$budget" ]; then ok "raw styled elements: $n_raw ≤ budget $budget"; else
  fail "raw styled elements: $n_raw > budget $budget"
fi
if [ "$budget" -le "$BUDGET_DONE" ]; then ok "budget has reached the done line ($BUDGET_DONE)"; else fail "budget $budget is above the done line $BUDGET_DONE — keep de-hand-rolling (worst directories below)"; fi
printf '      worst directories:\n'
for d in $(find "$PAGES" -mindepth 1 -maxdepth 1 -type d | sort) "$PAGES"; do
  n=$(dc_count_raw $(find "$d" -maxdepth 1 -name '*.tsx' | grep -vxF -f <(printf '%s\n' $QUEUED_FILES)))
  [ "$n" -gt 0 ] && printf '      %5d  %s\n' "$n" "$d"
done | sort -rn | head -8
[ "$n_sty" = 0 ] && ok "no JSX style= props in pages" || fail "JSX style= props in pages (inline or hoisted): $n_sty"
# Native form controls with no library wrapper — <select>/<input>/<textarea> —
# are hand-rolled controls even without a className; count them too. The tag
# may end its line (`<input` then props on the next lines), so `$` counts.
n_native=$(count_in '<(select|input|textarea)([[:space:]]|>|/|$)' $PAGE_FILES)
[ "$n_native" = 0 ] && ok "no native <select>/<input>/<textarea> in pages" || fail "native form controls in pages (use Select/Input/Textarea/Checkbox): $n_native"
[ "$n_btn" = 0 ] && ok "no raw <button> in pages" || fail "raw <button> in pages: $n_btn"
q_over=""; for f in $QUEUED_FILES; do [ -f "$f" ] || continue; c=$(raw_in_file "$f"); [ "$c" -le 12 ] || q_over="$q_over ${f#$PAGES/}($c)"; done
[ -z "$q_over" ] && ok "queued composites ≤ 12 raw elements each" || fail "queued composite over cap:$q_over"

# ─────────────────────────────────────────────────────────────────────────────
section "journey audit (docs/orgiq-journeys, matrix-driven)"
JDIR=docs/orgiq-journeys
MATRIX=$JDIR/MATRIX.txt
[ -f "$MATRIX" ] || { fail "$MATRIX missing"; }
jmissing=0; jbad=0; jtotal=0
# Freshness (docs/journeys.md): a log is stale when the rendered contract of
# a route it walked changed since its walk was sealed — judged once below for
# every matrix log, not as a field of each. (A source digest of the `pages:`
# line used to decide it, so a refactor that kept every page's look restaled
# the logs over it.) Only scripts/journeys/seal.sh <dir> records a seal.
source scripts/lib/journeys.sh
walked=""
while IFS='|' read -r surface url listflag roles; do
  surface=$(echo "$surface" | tr -d ' '); [ -z "$surface" ] && continue; case "$surface" in \#*) continue;; esac
  listflag=$(echo "$listflag" | tr -d ' '); roles=$(echo "$roles" | tr -d ' ')
  IFS=',' read -ra rs <<< "$roles"
  for r in "${rs[@]}"; do
    jtotal=$((jtotal+1)); f="$JDIR/$r/$surface.md"
    if [ ! -f "$f" ]; then jmissing=$((jmissing+1)); continue; fi
    bad=""
    grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
    grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
    grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
    grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
    grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
    grep -qiE '^role-gating: *\S' "$f" || bad="$bad role-gating"
    if [ "$listflag" = "L" ]; then
      frt=$(grep -ioE 'first-row-top[^0-9]*[0-9]+' "$f" | grep -oE '[0-9]+' | head -1)
      { [ -n "$frt" ] && [ "$frt" -le 640 ]; } || bad="$bad first-row-top(${frt:-missing})"
    fi
    shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
    { [ -n "$shot" ] && [ -f "$JDIR/$r/$shot" ]; } || bad="$bad screenshot"
    walked="$walked $f"
    grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
    [ -n "$bad" ] && { jbad=$((jbad+1)); printf '      %s/%s:%s\n' "$r" "$surface" "$bad"; }
  done
done < "$MATRIX"
[ "$jmissing" = 0 ] && ok "all $jtotal role×surface logs present" || fail "$jmissing of $jtotal journey logs missing"
[ "$jbad" = 0 ] && ok "every present log passes all fields" || fail "$jbad journey logs fail a required field"
jr_freshness "$JDIR" $walked
jr_report

section "rail isolation per role"
for r in member sme program-owner org-leader hr-admin; do
  f="$JDIR/$r/RAIL.md"
  if [ ! -f "$f" ]; then fail "$f missing"; continue; fi
  bad=""
  grep -qiE '^rail-items: *\S' "$f" || bad="$bad rail-items"
  grep -qiE '^hidden-surfaces-direct-route: *\S' "$f" || bad="$bad hidden-routes"
  grep -qiE '^palette-entries: *[0-9]+' "$f" || bad="$bad palette"
  grep -qiE '^quick-switch: *(denied|lists|create)' "$f" || bad="$bad quick-switch(⌘I must deny with a reason, list, or offer create)"
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -z "$bad" ] && ok "$r rail isolation" || fail "$r RAIL.md fails:$bad"
done

section "defects and docs"
open_defects=0
for f in $(find "$JDIR" -name 'DEFECTS.md' 2>/dev/null); do
  n=$(awk '/^## *Open/{o=1;next} /^## /{o=0} o && /^[0-9]+\./{c++} END{print c+0}' "$f"); open_defects=$((open_defects+n))
done
[ "$open_defects" = 0 ] && ok "no defect left under an Open heading" || fail "$open_defects defect(s) still listed under '## Open' in DEFECTS.md files"
[ -f docs/orgiq-audit.md ] && ok "docs/orgiq-audit.md exists" || fail "docs/orgiq-audit.md missing"

echo
if [ "${#FAILS[@]}" = 0 ]; then echo "ALL CHECKS PASS — the orgiq tenant meets its definition of done."; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done; exit 1
