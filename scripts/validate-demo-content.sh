#!/usr/bin/env bash
# The judge for docs/demo-content-goal.md — is the dev:mock world demoable to a
# peer? Exits 0 only when every check passes; prints every failing line so one
# run shows the whole backlog. The audit behind it: docs/demo-content-audit.md.
#
#   ./scripts/validate-demo-content.sh            # judge the committed probe capture + the fixtures + the story logs
#   ./scripts/validate-demo-content.sh --probe    # re-walk every tenant × role as clones first (needs :5183 + :3001)
#   ./scripts/validate-demo-content.sh --walk     # walk the demo story maps first (needs the stack)
#   ./scripts/validate-demo-content.sh --quick    # skip the fixture loaders (tsx) and the story logs
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"
QUICK=0; PROBE=0; WALK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; --probe) PROBE=1;; --walk) WALK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
# judge.mjs prints `ok|fail|note<TAB>text` (read through process substitution so FAILS survives).
relay() { while IFS=$'\t' read -r kind text; do case "$kind" in ok) ok "$text";; fail) fail "$text";; note) note "$text";; *) [ -n "$kind" ] && note "$kind $text";; esac; done; }

# ── D0 the documents ────────────────────────────────────────────────────────
section "D0 documents"
for f in docs/demo-content-goal.md docs/demo-content-audit.md docs/demo-journeys/PROTOCOL.md portal/e2e/demo-content-probe.spec.ts scripts/demo-content/rubric.mjs; do
  if [ -f "$f" ]; then ok "$f"; else fail "$f missing"; fi
done
if grep -q 'demo-content-goal.md' CLAUDE.md && grep -q 'validate-demo-content.sh' CLAUDE.md; then ok "CLAUDE.md docs map lists the goal and this judge"; else fail "CLAUDE.md docs map has no demo-content row"; fi

# ── D1 the probe capture ────────────────────────────────────────────────────
section "D1 probe capture (every tenant × role, as clones)"
if [ "$PROBE" = 1 ]; then
  SHOTS="${DEMO_PROBE_SHOTS:-${TMPDIR:-/tmp}/demo-content}"
  rm -rf "$SHOTS/captures"
  (cd portal && DEMO_PROBE_SHOTS="$SHOTS" npx playwright test e2e/demo-content-probe.spec.ts --workers=3 --reporter=line) >/dev/null 2>&1 || note "the probe run reported failures (errored captures are judged below)"
  node scripts/demo-content/merge-probe.mjs "$SHOTS" | while read -r l; do note "$l"; done
fi
relay < <(node scripts/demo-content/judge.mjs probe)

# ── D2 rendered text, every captured page ───────────────────────────────────
section "D2 rendered text (rubric b, c, d, g over every captured page)"
relay < <(node scripts/demo-content/judge.mjs rendered)

# ── D3 demo pages carry content as a clone ──────────────────────────────────
section "D3 demo pages: enough content, no empty state, as a clone of the role"
relay < <(node scripts/demo-content/judge.mjs pages)

# ── F fixtures and the program seed ─────────────────────────────────────────
section "F1 filler in fixture and seed copy"
relay < <(node scripts/demo-content/judge.mjs sources)

if [ "$QUICK" = 0 ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  section "F2 repeated prose and literal dates in fixture rows"
  if (cd middleware && npx tsx ../scripts/demo-content/prose.mts > "$TMP/prose.txt" 2>/dev/null); then
    rep=$(grep -c '^repeated' "$TMP/prose.txt"); dat=$(grep -c '^date' "$TMP/prose.txt")
    if [ "$rep" = 0 ]; then ok "(b) no sentence template repeats more than 5× in a fixture"; else
      fail "(b) $rep sentence templates repeat more than 5× in one fixture"
      grep '^repeated' "$TMP/prose.txt" | head -6 | awk -F'\t' '{printf "      %s %s %s “%.80s”\n", $3, $2, $4, $5}'
    fi
    if [ "$dat" = 0 ]; then ok "(e) no literal calendar date in fixture copy"; else
      fail "(e) $dat literal calendar dates in fixture copy (they do not move with the mock clock)"
      grep '^date' "$TMP/prose.txt" | head -6 | awk -F'\t' '{printf "      %s %s “%s”\n", $3, $2, $4}'
    fi
  else fail "prose.mts did not run (middleware/node_modules?)"; fi

  section "F3 cross-reference integrity (every id a fixture mentions exists; stored names match)"
  if (cd middleware && npx tsx ../scripts/demo-content/xref.mts > "$TMP/xref.txt" 2>/dev/null); then
    summary=$(grep '^#' "$TMP/xref.txt"); n=$(grep -cv '^#' "$TMP/xref.txt")
    if [ "$n" = 0 ]; then ok "(a) ${summary#\# }"; else
      fail "(a) ${summary#\# }"
      grep -v '^#' "$TMP/xref.txt" | head -8 | awk -F'\t' '{printf "      %s %s %s %s — %s\n", $1, $3, $4, $5, $6}'
    fi
  else fail "xref.mts did not run (middleware/node_modules?)"; fi
fi

section "F4 counts are derived, not stored (docs/mock-floor.md rule 1, held at zero here)"
AGG_RE='^[[:space:]]*(total[A-Za-z0-9_]*|[A-Za-z0-9_]*[Cc]ount|[A-Za-z0-9_]*[Rr]ate|avg[A-Za-z0-9_]*|[A-Za-z0-9_]*[Tt]otal|[A-Za-z0-9_]*_avg|[A-Za-z0-9_]*_count|[A-Za-z0-9_]*_rate|[A-Za-z0-9_]*_total)[[:space:]]*:[[:space:]]*-?(0*[1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)[,;]?[[:space:]]*$'
INLINE_RE='\b(childCount|childDoneCount|memberCount|unreadCount|participantCount|spanCount|executionCount|requestCount)[[:space:]]*:[[:space:]]*[1-9][0-9]*'
agg_scan() {
  local f
  for f in middleware/src/mock/*.ts; do
    case "$(basename "$f")" in distillation*|runbooks*) continue ;; esac
    grep -nE "$AGG_RE" "$f" | sed "s|^|$f:|"
    grep -noE "$INLINE_RE" "$f" | sed "s|^|$f:|"
  done
}
agg=$(agg_scan | awk -F: '!seen[$1":"$2]++')
n_agg=$(printf '%s' "$agg" | grep -c . || true)
if [ "$n_agg" = 0 ]; then ok "no literal count/total/rate beside fixture rows"; else
  fail "$n_agg literal counts/totals beside fixture rows — derive them (countBy/sumBy) from the rows they summarise"
  printf '%s\n' "$agg" | head -6 | sed 's/^/      /'
fi

# ── J the demo stories ──────────────────────────────────────────────────────
section "J demo story maps (docs/journeys/maps/demo, logs in docs/demo-journeys)"
chk=$(node scripts/journeys/run-maps.mjs check --family demo 2>&1 | tail -1)
case "$chk" in *"0 problem"*) ok "maps valid: $chk";; *) fail "maps invalid: $chk";; esac
if [ "$WALK" = 1 ]; then node scripts/journeys/run-maps.mjs walk --family demo --no-seal >/dev/null 2>&1 || note "the walk reported failures (judged from the logs below)"; fi
if [ "$QUICK" = 0 ]; then
  for m in $(cd docs/journeys/maps/demo && find . -name '*.ts' ! -name '_*' | sed 's|^\./||; s|\.ts$||' | sort); do
    log="docs/demo-journeys/$m.md"
    if [ ! -f "$log" ]; then fail "story $m: never walked ($log missing — run with --walk)"; continue; fi
    if grep -qE '^verdict: *pass' "$log" && grep -qE '^story-facts: *pass' "$log" && grep -qE '^cross-links: *pass' "$log"; then ok "story $m passes"
    else fail "story $m: $(grep -m1 -E '^(story-facts|cross-links|verdict):.*fail' "$log" | cut -c1-150)"; fi
  done
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS — the demo content is coherent, believable and complete"; exit 0; fi
echo "${#FAILS[@]} failing check(s) — docs/demo-content-audit.md names the fix lane for each"
exit 1
