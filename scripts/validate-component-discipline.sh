#!/usr/bin/env bash
# validate-component-discipline.sh — is the portal built out of the component
# library, or hand-rolled out of divs?
#
# The assessment tenant already answered this for itself: its gate in
# the assessment tenant gate (since removed) walked `portal/src/pages/assessment` from 274
# raw styled elements to 0. That gate covers exactly one directory, and the
# measurement that motivated it — "60 in the reference orgiq pages" — was never
# itself enforced. So the rest of the portal has never been gated, and the debt
# collected where nobody was counting: `portal/src/components`.
#
# Same rule as that gate, deliberately. A different regex would make the two
# numbers incomparable, and the point of this file is that the assessment
# tenant's result is reproducible everywhere else.
#
# BUDGETS ARE RATCHETS. Every number below may go DOWN and never up. That is
# the whole mechanism: it makes "we'll clean it up later" impossible to say
# without also making it false, because the next hand-rolled div fails the
# build rather than joining a pile nobody counts.
#
# Usage:  scripts/validate-component-discipline.sh
#         scripts/validate-component-discipline.sh --report   # per-area table
#
# Exit 0 only when every area is at or under its budget.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPORT=0
for a in "$@"; do case "$a" in --report) REPORT=1 ;; esac; done

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

SRC=portal/src
QUEUE=docs/ui-components-queue.md  # optional list of composites queued for the library; absent means none

# The same element set the assessment gate counted.
# One raw-element counter for every discipline check (audit 2026-10-07 T7):
# scripts/lib/discipline.sh, which the tenant validators source too.
source scripts/lib/discipline.sh
DC_QUEUE=$QUEUE
RAW_RE=$DC_RAW_RE
QUEUED_FILES=$(dc_queued_files portal/src/)
QUEUED_MAX_PER_FILE=8
count_re() { dc_count_re "$@"; }
count_raw() { dc_count_raw "$@"; }
area_files() { dc_area_files "$1" portal/src/; }

AREAS=(
  "portal/src:0:0:7"
  "portal/src/components/runs:0:0:0"
  "portal/src/components/codebases:0:0:0"
  "portal/src/components/scores:0:0:4"
  "portal/src/components/marketplace:0:0:0"
  "portal/src/components/ingest:0:0:0"
  "portal/src/components/canary:0:0:1"
  "portal/src/components/org-graph:0:2:6"
  "portal/src/components/shell:0:0:0"
  "portal/src/components/knowledge:0:0:0"
  "portal/src/components/sdlc:0:0:0"
  "portal/src/components/kb:0:0:2"
  "portal/src/components/observability:0:0:0"
  "portal/src/pages:0:0:0"
)

section "component discipline (per-area ratchets)"
grand=0
for entry in "${AREAS[@]}"; do
  dir="${entry%%:*}"; rest="${entry#*:}"
  b_raw="${rest%%:*}"; rest="${rest#*:}"
  b_btn="${rest%%:*}"; b_sty="${rest##*:}"
  [ -d "$dir" ] || continue
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(area_files "$dir")
  # A gate that measures nothing must fail, not pass. `mapfile` is absent on
  # macOS bash 3.2, and when it silently produced an empty list this script
  # reported every area at 0 — a green check that checked nothing, which is
  # the exact failure the assessment goal-doc was written about.
  if [ ${#files[@]} -eq 0 ]; then
    fail "${dir#portal/src/}: no .tsx files found — the gate is not measuring anything"
    continue
  fi
  n_raw=$(count_raw "${files[@]}")
  n_btn=$(count_re '<button' "${files[@]}")
  n_sty=$(count_re 'style=\{' "${files[@]}")
  label="${dir#portal/src/}"; [ "$label" = "portal/src" ] && label="portal/src (all)"

  over=0
  [ "$n_raw" -le "$b_raw" ] || { fail "$label: $n_raw raw styled elements > budget $b_raw"; over=1; }
  [ "$n_btn" -le "$b_btn" ] || { fail "$label: $n_btn raw <button> > budget $b_btn (use Button/IconButton/SelectableCard)"; over=1; }
  [ "$n_sty" -le "$b_sty" ] || { fail "$label: $n_sty style= props > budget $b_sty"; over=1; }
  if [ "$over" = 1 ]; then
    for f in "${files[@]}"; do
      c=$(count_raw "$f")
      [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$dir/}"
    done | sort -rn | head -6
    continue
  fi

  if [ "$n_raw" -lt "$b_raw" ] || [ "$n_btn" -lt "$b_btn" ] || [ "$n_sty" -lt "$b_sty" ]; then
    ok "$label: raw $n_raw/$b_raw, button $n_btn/$b_btn, style $n_sty/$b_sty — LOWER THE BUDGETS to $n_raw:$n_btn:$n_sty"
  else
    ok "$label: raw $n_raw, button $n_btn, style $n_sty (all at budget)"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# Queued composites keep their per-file cap wherever they live.
# ─────────────────────────────────────────────────────────────────────────────
section "queued composites stay small"
q_over=""; q_n=0
for f in $QUEUED_FILES; do
  [ -f "$f" ] || continue
  q_n=$((q_n + 1))
  c=$(count_raw "$f")
  [ "$c" -le "$QUEUED_MAX_PER_FILE" ] || q_over="$q_over ${f#portal/src/}($c)"
done
[ -z "$q_over" ] \
  && ok "$q_n queued composites, each ≤ $QUEUED_MAX_PER_FILE raw elements" \
  || fail "queued composite over the per-file cap of $QUEUED_MAX_PER_FILE:$q_over"

# ─────────────────────────────────────────────────────────────────────────────
# The library entry that once broke the production build. ui-components'
# integrations/realtime-modules imports the canonical `@connorhoehn/realtime-
# modules`. The portal used to install it under a different scope and bridge the
# name with a vite alias and tsconfig paths; it now installs the package under
# its real name, so the entry resolves with no bridge. This check asserts that.
# ─────────────────────────────────────────────────────────────────────────────
section "realtime-modules installed under its own name"
if node -e "const d=require('./portal/package.json').dependencies;process.exit(d['@connorhoehn/realtime-modules']?0:1)" 2>/dev/null \
   && ! grep -qE "@connorhoehn[a-z]+/realtime-modules" portal/vite.config.ts portal/tsconfig.json \
   && ! grep -q "'@connorhoehn/realtime-modules':" portal/vite.config.ts \
   && ! grep -q '"@connorhoehn/realtime-modules/' portal/tsconfig.json; then
  ok "portal installs @connorhoehn/realtime-modules under its own name (no alias, no tsconfig paths)"
else
  fail "portal must depend on @connorhoehn/realtime-modules directly, with no other-scope alias in vite.config.ts and no realtime-modules paths in tsconfig.json"
fi

section "raw typography on bare text nodes (ratchet)"
# AI-generated pages drift by writing `<span className="text-sm font-semibold">`
# instead of the library's `<T size weight tone>`. Count raw type-scale and
# font-weight utilities on bare <span>/<div>/<p> (brace-aware, multi-line) in
# portal/src. Baseline is in scripts/raw-typography-budget.txt: it may go down,
# never up. Counter: scripts/count-raw-typography.py (--files lists offenders).
TYPO_BUDGET=$(tr -d ' \n' < scripts/raw-typography-budget.txt 2>/dev/null || echo 0)
TYPO_N=$(python3 scripts/count-raw-typography.py "$SRC" 2>/dev/null | tail -1)
if [ "${TYPO_N:-x}" -le "$TYPO_BUDGET" ] 2>/dev/null; then
  ok "raw typography utilities on bare text: $TYPO_N (budget $TYPO_BUDGET)"
else
  fail "raw typography utilities on bare span/div/p: ${TYPO_N:-?} > budget $TYPO_BUDGET (use T size/weight/tone)"
fi

section "layout drift — library primitives composed off the type scale (burn-down)"
# The raw counters above are at zero portal-wide, and pages still read
# inconsistent: the drift moved up a level, into compositions built FROM the
# library — a `T className="text-[11px]"`, a card StatStrip with 17px values on
# a list page, a table cell stacking a caption and a bar under its value, a ✕
# glyph for an icon (the 2026-10-07 /admin/budgets report). One counter,
# scripts/count-layout-drift.py (brace-aware tag walking — an arrow function in
# an onClick cannot truncate a tag), nine classes. The last three are the
# table rules (2026-10-07): `cellbutton` (a
# text Button in a table cell or row actions), `lonesearch` (DataTable's own
# search field on a row of its own) and `tablesize` (a DataTable/Table off the
# 44px step — an explicit size other than sm; the shell's compact density
# draws every table there since ui-components 2.440); `densitysize` (2026-10-08,
# the density lane) is an explicit size="sm" on a composite the compact
# density already draws at sm — the house density restated per call; its
# budget is zero, so any new one fails; `stackedcell` and `cardstat` are the same rules'
# second-line and card-strip halves. The tolerated debt is a BURN-DOWN,
# scripts/layout-drift-burndown.tsv: one row per (class, file) with the count
# allowed in that file, its owner surface and a due date (audit J1). A file
# over its row (or with none), and a row still counting after its due date,
# fail; a file under its row is reported so the row can be lowered.
# Card-variant stat tiles are allowed only in the dashboards listed in
# scripts/card-stat-allowed.txt.
DRIFT_BURNDOWN=scripts/layout-drift-burndown.tsv
DRIFT_OUT=$(python3 scripts/count-layout-drift.py "$SRC" --list 2>/dev/null)
if [ -z "$DRIFT_OUT" ]; then
  fail "layout drift: count-layout-drift.py produced no output — the gate is not measuring anything"
elif [ ! -f "$DRIFT_BURNDOWN" ]; then
  fail "layout drift: $DRIFT_BURNDOWN missing"
else
  DRIFT_CUR=$(mktemp)
  printf '%s\n' "$DRIFT_OUT" | awk '/^[a-z]+ [0-9]+$/ { c = $1; next } c && /:[0-9]+$/ { sub(/^ +/, ""); sub(/:[0-9]+$/, ""); n[c "\t" $0]++ } END { for (k in n) print k "\t" n[k] }' > "$DRIFT_CUR"
  DRIFT_V=$(node portal/e2e/burndown.ts check "$DRIFT_BURNDOWN" --current "$DRIFT_CUR")
  rm -f "$DRIFT_CUR"
  for cls in bar bigtext cardstat stackedcell glyphbutton pxtype cellbutton lonesearch tablesize densitysize; do
    n=$(printf '%s\n' "$DRIFT_OUT" | awk -v c="$cls" '$1==c && NF==2 {print $2}')
    b=$(awk -F'\t' -v c="$cls" '!/^#/ && $1==c {s+=$3} END {print s+0}' "$DRIFT_BURNDOWN")
    if [ -z "$n" ]; then fail "layout drift: no count for '$cls'"; continue; fi
    over=$(printf '%s\n' "$DRIFT_V" | awk -v c="$cls" '/^OVER / { sub(/^OVER /, ""); split($0, f, "\t"); if (f[1]==c) print "      " f[2] " (" f[3] " > row " f[4] ")" }')
    due=$(printf '%s\n' "$DRIFT_V" | awk -v c="$cls" '/^PASTDUE / { sub(/^PASTDUE /, ""); split($0, f, "\t"); if (f[1]==c) print "      " f[2] " (" f[3] ", " f[4] ", due " f[5] ")" }')
    burned=$(printf '%s\n' "$DRIFT_V" | awk -v c="$cls" '/^BURNED / { sub(/^BURNED /, ""); split($0, f, "\t"); if (f[1]==c) k++ } END { print k+0 }')
    if [ -n "$over" ]; then
      fail "layout drift $cls: $n — a file is over its burn-down row (or has none)"; printf '%s\n' "$over"
    elif [ -n "$due" ]; then
      fail "layout drift $cls: $n — burn-down rows past their due date"; printf '%s\n' "$due"
    elif [ "$burned" -gt 0 ]; then
      ok "layout drift $cls: $n (burn-down $b) — $burned file(s) under their row: LOWER THE ROWS in $DRIFT_BURNDOWN"
    else
      ok "layout drift $cls: $n (burn-down $b)"
    fi
    # Every offender is printed for the small classes (pxtype is the long tail: see the owner table).
    if [ "$n" -gt 0 ] && [ "$cls" != pxtype ]; then
      printf '%s\n' "$DRIFT_OUT" | awk -v c="$cls" '
        /^[a-z]+ [0-9]+$/ { on = ($1 == c); next }
        on { sub(/^ +/, ""); print "      " $0 }'
    fi
  done
  printf '%s\n' "$DRIFT_V" | grep -q '^INVALID ' && { fail "layout drift: malformed burn-down rows"; printf '%s\n' "$DRIFT_V" | grep '^INVALID ' | sed 's/^/      /'; }
  printf '      remaining by owner surface (due):\n'
  printf '%s\n' "$DRIFT_V" | awk -F'\t' '/^OWNER / { sub(/^OWNER /, "", $1); n++; if (n <= 12) printf "        %-34s %4s  %s\n", $1, $2, $3; else rest += $2 } END { if (n > 12) printf "        … %d more surfaces, %d offenders\n", n - 12, rest }'
fi

# Specs sign in through ONE helper (audit 2026-10-07 T1, stop-doing rule 10):
# a spec that POSTs /api/session/login itself, or declares its own
# signIn/login function, has forked the session contract.
section "human-in-the-loop decisions in the composer deck (ratchet)"
# Since ui-components 2.444.0 a decision a page needs from a person is a
# ComposerPromptDeck prompt in the docked composer (header card, one question,
# numbered answers; Prepare job first — usePrepareJobDeck.ts). A ConfirmDialog,
# or a Modal/Drawer holding a form control, asks it in a box instead.
# scripts/count-hitl-modals.py counts those; the ceiling may go down, never up.
# A runtime rule (the DOM audit) cannot see this: decision modals are closed at
# load, and opening each takes a page-specific script — a page exception, which
# the audit forbids. The fixtures keep the counter honest in both directions.
HITL_BUDGET=57
HITL_FIX=scripts/fixtures/hitl-decision
if [ "$(python3 scripts/count-hitl-modals.py "$HITL_FIX/modal" | awk '$1=="decisionmodal"{print $2}')" = 1 ] \
  && [ "$(python3 scripts/count-hitl-modals.py "$HITL_FIX/deck" | awk '$1=="decisionmodal"{print $2}')" = 0 ]; then
  ok "decision-modal counter: modal fixture counts 1, deck fixture counts 0"
else
  fail "decision-modal counter disagrees with its fixtures ($HITL_FIX) — the ratchet is not measuring"
fi
HITL_OUT=$(python3 scripts/count-hitl-modals.py "$SRC" --list)
HITL_N=$(printf '%s\n' "$HITL_OUT" | awk '$1=="decisionmodal"{print $2}')
HITL_DECK=$(printf '%s\n' "$HITL_OUT" | awk '$1=="deck"{print $2}')
if [ -n "$HITL_N" ] && [ "$HITL_N" -le "$HITL_BUDGET" ]; then
  ok "decision modals: $HITL_N (budget $HITL_BUDGET); files on the composer deck: ${HITL_DECK:-0}"
  [ "$HITL_N" -lt "$HITL_BUDGET" ] && printf '      under budget — lower HITL_BUDGET to %s\n' "$HITL_N"
else
  fail "decision modals: ${HITL_N:-?} > budget $HITL_BUDGET — ask through ConversationComposer prompts (ComposerPromptDeck) instead"
  printf '%s\n' "$HITL_OUT" | awk '/^decisionmodal/{on=1;next} /^[a-z]+ [0-9]+$/{on=0} on' | head -20
fi

section "e2e sign-in discipline (portal/e2e/realSession.ts)"
# Only a spec that itself POSTs/fetches/visits the login route forks the contract;
# one that merely names the path while filtering observed requests does not.
local_login=$(grep -lE "(post|fetch|goto|request)\(\s*[\x27\"\x60][^\x27\"\x60]*api/session/login" portal/e2e/*.spec.ts 2>/dev/null)
local_fn=$(grep -lE "^(async )?function (signIn|signin|login|logIn|loginAs|signInAs)\b|^const (signIn|login|loginAs) *= *async" portal/e2e/*.spec.ts 2>/dev/null)
[ -z "$local_login" ] && ok "no spec posts /api/session/login itself" || fail "specs sign in on their own (use e2e/realSession.ts):$(echo $local_login | sed 's#portal/e2e/##g')"
[ -z "$local_fn" ] && ok "no spec declares its own signIn/login function" || fail "specs declare a local sign-in function (use e2e/realSession.ts):$(echo $local_fn | sed 's#portal/e2e/##g')"

section "UI inheritance contracts (composition, shell provider, packaged runtime)"
if node scripts/audit-ui-inheritance.cjs --check; then
  ok "shared collection/composer contracts and installed UI archive agree"
else
  fail "UI inheritance contract failed (see audit-ui-inheritance.cjs output)"
fi

if [ "$REPORT" = 1 ]; then
  section "report — every area, including ungated ones"
  printf '  %-34s %5s %5s %5s %5s\n' area raw div btn style
  while IFS= read -r dir; do
    files=()
    while IFS= read -r f; do files+=("$f"); done < <(area_files "$dir")
    [ ${#files[@]} -eq 0 ] && continue
    n=$(count_raw "${files[@]}")
    d=$(count_re '<div( [^>]*)?className=' "${files[@]}")
    b=$(count_re '<button' "${files[@]}")
    s=$(count_re 'style=\{' "${files[@]}")
    [ "$n" = 0 ] && [ "$s" = 0 ] && continue
    printf '  %-34s %5s %5s %5s %5s\n' "${dir#portal/src/}" "$n" "$d" "$b" "$s"
  done < <(find "$SRC" -type d -not -path '*/node_modules/*' | sort)
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then
  printf 'ALL CHECKS PASS — every gated area is at or under its raw/button/style budget.\n'
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
