#!/usr/bin/env bash
# validate-component-discipline.sh — is the portal built out of the component
# library, or hand-rolled out of divs?
#
# The assessment tenant already answered this for itself: its gate in
# validate-assessment-tenant.sh walked `portal/src/pages/assessment` from 274
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
QUEUE=docs/ui-components-queue.md

# The same element set validate-assessment-tenant.sh counts.
RAW_RE='<(div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre)( [^>]*)?className='

# A raw element is permitted in exactly one kind of file: a local composite
# standing in for a primitive the library lacks, AND queued for it. Only rows
# that say "Composed locally in `<file>`" mint an exemption — a row that merely
# names where a gap was worked around must not exempt that file.
QUEUED_FILES=$(grep -oE "Composed locally in \`portal/src/[A-Za-z0-9_/.-]+\.tsx\`" "$QUEUE" 2>/dev/null \
  | grep -oE "portal/src/[A-Za-z0-9_/.-]+\.tsx" | sort -u)
# A queued file still gets a per-file cap, so "queue it" cannot become
# "hand-roll it".
QUEUED_MAX_PER_FILE=8

count_re() { # count_re <regex> <files...> — single-line patterns only
  local re="$1"; shift
  local n=0 c
  for f in "$@"; do
    [ -f "$f" ] || continue
    c=$(grep -oE "$re" "$f" 2>/dev/null | wc -l | tr -d ' ')
    n=$((n + c))
  done
  printf '%s' "$n"
}

# Raw styled elements, counted across LINE BREAKS.
#
# `grep` matches a line at a time, and JSX opening tags routinely span several:
#
#     <input
#       type="range"
#       className="w-full accent-primary"
#     />
#
# A line-based regex cannot see that element at all. Measured when this gate was
# first written: 45 raw elements portal-wide — about 9% — were invisible, and
# "converting" a file could mean nothing more than pushing its className onto
# its own line. A budget guarding a number that can be gamed by reformatting is
# not a budget.
#
# So the raw count is multi-line aware. `<button` and `style={{` stay on grep:
# both are single tokens with no such blind spot.
#
# (The assessment tenant's own gate has the same line-based regex. Its zero was
# checked against this counter when this was written and is a true zero, so
# nothing there is hiding behind the same gap.)
count_raw() { # count_raw <files...>
  [ $# -eq 0 ] && { printf '0'; return; }
  python3 - "$@" <<'PY'
import re, sys
EL = r'div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre'
rx = re.compile(rf'<({EL})(\s[^>]*?)?\sclassName=', re.S)
total = 0
for path in sys.argv[1:]:
    try:
        total += len(rx.findall(open(path, encoding='utf-8', errors='ignore').read()))
    except OSError:
        pass
print(total, end='')
PY
}

is_queued() {
  printf '%s\n' $QUEUED_FILES | grep -qxF "$1"
}

# Files in an area, minus the queued composites.
area_files() { # area_files <dir>
  local dir="$1" f
  while IFS= read -r f; do
    is_queued "$f" || printf '%s\n' "$f"
  done < <(find "$dir" -name '*.tsx' 2>/dev/null | sort)
}

# ─────────────────────────────────────────────────────────────────────────────
# Per-area ratchets.
#
# `pages/**` is already close to clean — that is what the assessment gate and
# the surfaces built after it bought. `components/**` is where the debt is,
# because nothing ever counted it. Each budget below is TODAY'S count; lower it
# as the area converts.
#
# Format: <path>:<raw budget>
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ ONE-TIME RE-BASELINE, and the only raise this file will ever carry.
# The first version of this gate counted with a line-based grep, which cannot
# see a JSX tag whose className sits on a later line — 45 elements portal-wide,
# ~9%, were invisible, and a file could be "converted" by reformatting alone.
# `count_raw` is multi-line aware now, so these raw numbers went UP without any
# code getting worse. The never-raise rule exists to stop new debt hiding, not
# to protect a measurement known to be wrong. From here they only go down.
#
# Format: <path>:<raw>:<button>:<inline-style>
#
# `portal/src` is the catch-all so no directory can escape by not being listed;
# the narrower entries exist so a regression names the area that caused it.
# Raw counts nest (an entry covers its subdirectories), which is deliberate —
# converting a leaf lowers both its own budget and its parent's.
AREAS=(
  "portal/src:4:47:254"
  "portal/src/components/runs:0:0:0"
  "portal/src/components/codebases:0:0:0"
  "portal/src/components/scores:0:0:4"
  "portal/src/components/marketplace:0:0:0"
  "portal/src/components/ingest:0:1:58"
  "portal/src/components/canary:0:15:63"
  "portal/src/components/org-graph:2:6:6"
  "portal/src/components/shell:0:6:40"
  "portal/src/components/knowledge:0:0:0"
  "portal/src/components/sdlc:0:0:0"
  "portal/src/components/kb:0:3:54"
  "portal/src/components/observability:0:7:6"
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
  n_sty=$(count_re 'style=\{\{' "${files[@]}")
  label="${dir#portal/src/}"; [ "$label" = "portal/src" ] && label="portal/src (all)"

  over=0
  [ "$n_raw" -le "$b_raw" ] || { fail "$label: $n_raw raw styled elements > budget $b_raw"; over=1; }
  [ "$n_btn" -le "$b_btn" ] || { fail "$label: $n_btn raw <button> > budget $b_btn (use Button/IconButton/SelectableCard)"; over=1; }
  [ "$n_sty" -le "$b_sty" ] || { fail "$label: $n_sty inline style={{}} > budget $b_sty"; over=1; }
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
# The library entry that breaks the production build. Same check the assessment
# gate makes, applied to the whole portal: importing it fails `vite build`
# because @tiptap/react is a ui-components PEER dep this portal never installed.
# ─────────────────────────────────────────────────────────────────────────────
section "no build-breaking library entry"
if grep -rq "ui-components/integrations/realtime-modules" "$SRC" --include='*.tsx' 2>/dev/null; then
  fail "imports integrations/realtime-modules (breaks vite build without @tiptap/react)"
else
  ok "no integrations/realtime-modules imports"
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
    s=$(count_re 'style=\{\{' "${files[@]}")
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
