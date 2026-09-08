#!/usr/bin/env bash
# Definition of done for docs/orgiq-audit-goal.md. Exit 0 only when every
# check passes. --quick skips the slow suites (node tests, vite build).
set -u
cd "$(dirname "$0")/.."
QUICK=0; SEAL=0
for a in "$@"; do case "$a" in
  --quick) QUICK=1;;
  # Record the current digest for every log, using THIS script's own hash
  # function — never a second implementation, which is how the first attempt
  # at this baseline produced digests that disagreed with the checker's.
  # Only for an mtime-corruption event, and only with the reason written down.
  --seal) SEAL=1;;
esac; done
FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
section "builds"
if (cd portal && npx tsc --noEmit >/dev/null 2>&1); then ok "portal tsc"; else fail "portal: tsc errors"; fi
if (cd middleware && npx tsc --noEmit >/dev/null 2>&1); then ok "middleware tsc"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd portal && node --test 'src/**/__tests__/*.test.ts' >/dev/null 2>&1); then ok "portal node tests"; else fail "portal: node tests failing"; fi
  if (cd portal && npx vite build >/dev/null 2>&1); then ok "portal vite build"; else fail "portal: vite build failed"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "component discipline (all of portal/src/pages, ratchet)"
PAGES=portal/src/pages
BUDGET_FILE=scripts/orgiq-raw-budget.txt
BUDGET_START=1114
BUDGET_DONE=60
QUEUE=docs/ui-components-queue.md
QUEUED_FILES=$(grep -oE "Composed locally in \`portal/src/pages/[A-Za-z0-9_/.-]+\.tsx\`" "$QUEUE" 2>/dev/null | grep -oE "portal/src/pages/[A-Za-z0-9_/.-]+\.tsx" | sort -u)
PAGE_FILES=$(find "$PAGES" -name '*.tsx' | sort | grep -vxF -f <(printf '%s\n' $QUEUED_FILES))
count_in() { local re="$1"; shift; local n=0; for f in "$@"; do c=$(grep -oE "$re" "$f" | wc -l | tr -d ' '); n=$((n+c)); done; echo "$n"; }
# Raw elements are counted across line breaks (perl slurp) — a `<div` whose
# `className=` sits on a later line is the same raw element as a one-liner.
RAW_TAGS='div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre'
raw_in_file() { perl -0777 -ne 'my $n=0; $n++ while /<('"$RAW_TAGS"')\s[^>]*?className=/g; print $n' "$1"; }
count_raw() { local n=0; for f in "$@"; do c=$(raw_in_file "$f"); n=$((n+c)); done; echo "$n"; }
n_raw=$(count_raw $PAGE_FILES)
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
  n=0; for f in $(find "$d" -maxdepth 1 -name '*.tsx' | grep -vxF -f <(printf '%s\n' $QUEUED_FILES)); do c=$(raw_in_file "$f"); n=$((n+c)); done
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
# ── Freshness is about CONTENT, not mtime ────────────────────────────────
# A log is stale when the code it observed CHANGED. mtime is only a proxy for
# that, and on 2026-09-07 it proved a bad one: a bulk operation stamped 134
# portal source files with an identical mtime (14:35:02) while changing none
# of them — the Vite dev server logged no HMR update for any of them — and
# 54 logs "went stale" against edits that never happened.
#
# So the rule now reads a hash. `.pages-sha` records the digest of each
# surface's own pages at the moment its log was last judged fresh by mtime.
# A later mtime bump with the same digest is not a change and does not stale
# anything; a digest that moves does, whatever the mtimes say.
SHA_CACHE="$JDIR/.pages-sha"
pages_sha() { # digest of every .tsx the `pages:` line names, in path order
  local out="" ; IFS=',' read -ra items <<< "$1"
  for d in "${items[@]}"; do d=$(echo "$d" | tr -d ' '); [ -n "$d" ] || continue
    if [ -f "$d" ]; then out="$out$(shasum -a 256 "$d" 2>/dev/null)"; continue; fi
    [ -d "$d" ] || continue
    local depth=""; [ "${d%/}" = "portal/src/pages" ] && depth="-maxdepth 1"
    out="$out$(find "$d" $depth -name '*.tsx' 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null)"
  done
  printf '%s' "$out" | shasum -a 256 | cut -d' ' -f1
}
sha_recorded() { grep -F "$1 " "$SHA_CACHE" 2>/dev/null | tail -1 | cut -d' ' -f2; }
sha_record() { # keep one line per log
  [ -f "$SHA_CACHE" ] || : > "$SHA_CACHE"
  grep -vF "$1 " "$SHA_CACHE" > "$SHA_CACHE.tmp" 2>/dev/null || : > "$SHA_CACHE.tmp"
  printf '%s %s\n' "$1" "$2" >> "$SHA_CACHE.tmp"
  sort -o "$SHA_CACHE" "$SHA_CACHE.tmp" && rm -f "$SHA_CACHE.tmp"
}

newest_in_dirs() { # newest .tsx mtime among the dirs listed (comma-separated)
  local newest=""; IFS=',' read -ra dirs <<< "$1"
  for d in "${dirs[@]}"; do d=$(echo "$d" | tr -d ' ')
    if [ -f "$d" ]; then { [ -z "$newest" ] || [ "$d" -nt "$newest" ]; } && newest="$d"; continue; fi
    [ -d "$d" ] || continue
    # The root page dir names only its own files (ProjectsPage.tsx, …); every
    # subdirectory is a separate surface and is listed on its own when used.
    depth=""; [ "${d%/}" = "portal/src/pages" ] && depth="-maxdepth 1"
    f=$(ls -t $(find "$d" $depth -name '*.tsx' 2>/dev/null) 2>/dev/null | head -1); [ -n "$f" ] && { [ -z "$newest" ] || [ "$f" -nt "$newest" ]; } && newest="$f"
  done; echo "$newest"
}
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
    pages=$(grep -iE '^pages: *' "$f" | head -1 | sed -E 's/^pages: *//')
    if [ -z "$pages" ]; then bad="$bad pages-line"; else
      newest=$(newest_in_dirs "$pages")
      cur_sha=$(pages_sha "$pages")
      if [ -n "$newest" ] && [ "$newest" -nt "$f" ]; then
        # mtime says stale — believe it only if the content actually moved.
        if [ "$(sha_recorded "$f")" = "$cur_sha" ]; then
          : # same bytes the log was judged against; an mtime bump is not an edit
        else
          bad="$bad stale(${newest#portal/src/pages/})"
        fi
      else
        sha_record "$f" "$cur_sha"
      fi
      [ "$SEAL" = 1 ] && sha_record "$f" "$cur_sha"
    fi
    grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
    [ -n "$bad" ] && { jbad=$((jbad+1)); printf '      %s/%s:%s\n' "$r" "$surface" "$bad"; }
  done
done < "$MATRIX"
[ "$jmissing" = 0 ] && ok "all $jtotal role×surface logs present" || fail "$jmissing of $jtotal journey logs missing"
[ "$jbad" = 0 ] && ok "every present log passes all fields (incl. per-surface freshness)" || fail "$jbad journey logs fail a required field"

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
