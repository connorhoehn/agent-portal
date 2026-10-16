#!/usr/bin/env bash
# The judge for docs/work-journeys-goal.md — are the Work tenant's (orgiq)
# journeys deep, complete and tested for every role? Exits 0 only when every
# check passes; prints every failing line so one run shows the whole backlog.
#
#   ./scripts/validate-work-journeys.sh           # everything (adds the runner's own tests and the orgiq-audit judge)
#   ./scripts/validate-work-journeys.sh --quick   # static checks only: docs, catalog, maps, depth, refusals, floors, logs, freshness
#   ./scripts/validate-work-journeys.sh --walk    # walk every work map first (needs Vite :5183 + middleware :3001; seals passing role directories)
set -u
cd "$(dirname "$0")/.."
QUICK=0; WALK=0
for a in "$@"; do case "$a" in
  --quick) QUICK=1;;
  --walk) WALK=1;;
  --seal) echo "--seal is retired: walk, then scripts/journeys/seal.sh <dir> (docs/journeys.md)" >&2; exit 2;;
  *) echo "unknown argument $a" >&2; exit 2;;
esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
relay() { while IFS=$'\t' read -r kind text; do case "$kind" in ok) ok "$text";; fail) fail "$text";; note) note "$text";; *) [ -n "$kind" ] && note "$kind $text";; esac; done; }
W="node scripts/journeys/work-journeys.mjs"

# ── 1 documents ─────────────────────────────────────────────────────────────
section "1 documents"
for f in docs/work-journeys-goal.md docs/work-journeys/PROTOCOL.md docs/work-journeys/MATRIX.txt docs/journeys/maps/work/_shared.ts scripts/journeys/work-journeys.mjs scripts/work-journeys-floors.tsv; do
  [ -f "$f" ] && ok "$f" || fail "$f missing"
done
if grep -qE 'work-journeys-goal\.md.*validate-work-journeys\.sh' CLAUDE.md; then ok "CLAUDE.md docs map has the work-journeys row"; else fail "CLAUDE.md docs map has no row naming work-journeys-goal.md and validate-work-journeys.sh"; fi
n_val=$(ls scripts/validate-*.sh | wc -l | tr -d ' ')
claimed=$(grep -oE '\(([0-9]+) validators\)' CLAUDE.md | grep -oE '[0-9]+' | head -1)
[ "${claimed:-x}" = "$n_val" ] && ok "CLAUDE.md validator count ($claimed) matches scripts/ ($n_val)" || fail "CLAUDE.md says (${claimed:-?} validators); scripts/ holds $n_val"
if grep -q "work:" scripts/journeys/maps.mjs && grep -q "'docs/work-journeys'" scripts/journeys/journeys.mjs; then ok "the work family has a runner profile and seal rules"; else fail "the work family is missing from maps.mjs PROFILES or journeys.mjs FAMILIES"; fi

# ── 2 the maps ──────────────────────────────────────────────────────────────
section "2 maps (docs/journeys/maps/work) — run-maps check, catalog sync"
chk=$(node scripts/journeys/run-maps.mjs check --family work 2>&1)
last=$(printf '%s\n' "$chk" | tail -1)
case "$last" in *" 0 problem(s)") ok "run-maps.mjs check --family work: $last";; *) fail "run-maps.mjs check --family work: $last"; printf '%s\n' "$chk" | grep '✗' | head -8 | sed 's/^/      /';; esac
relay < <($W catalog)

# ── 3 depth ─────────────────────────────────────────────────────────────────
section "3 depth (every step measured and asserted; the catalog's states, tabs and checks)"
relay < <($W depth)

# ── 4 refusals ──────────────────────────────────────────────────────────────
section "4 refusals (every role × gated /iq and /admin route it cannot reach)"
relay < <($W refusals)

# ── 5 coverage floors ───────────────────────────────────────────────────────
section "5 coverage floors (scripts/work-journeys-floors.tsv, ratchet up only)"
relay < <($W floors)
if node scripts/journeys/run-maps.mjs coverage --check >/dev/null 2>&1; then ok "docs/journeys/coverage.md is current"; else fail "docs/journeys/coverage.md is out of date (node scripts/journeys/run-maps.mjs coverage)"; fi
if grep -q 'distillation' docs/journeys/coverage.md; then fail "docs/journeys/coverage.md still lists distillation (deleted)"; else ok "coverage.md lists no deleted surface (distillation)"; fi
roles=$(grep -oE '^- \*\*roles:\*\* [0-9]+ of [0-9]+' docs/journeys/coverage.md | head -1)
never=$(awk '/^### Roles never walked/{f=1;next} /^### /{f=0} f' docs/journeys/coverage.md | grep -E '^- orgiq:' || true)
[ -z "$never" ] && ok "every orgiq role is walked by a map (${roles#- })" || fail "orgiq roles never walked: ${never#- orgiq: }"

# ── 6 logs ──────────────────────────────────────────────────────────────────
section "6 logs (docs/work-journeys): walked, passing, fresh, sealed"
if [ "$WALK" = 1 ]; then
  for r in member sme program-owner org-leader hr-admin; do node scripts/journeys/run-maps.mjs walk work --role "$r" >/dev/null 2>&1 || note "the $r walk reported failures (judged from the logs below)"; done
fi
relay < <($W logs)
source scripts/lib/journeys.sh
WLOGS=(); while IFS= read -r l; do [ -n "$l" ] && WLOGS+=("$l"); done < <(cat .scratch/work-journeys-logs.txt 2>/dev/null)
if [ "${#WLOGS[@]}" -gt 0 ]; then jr_freshness docs/work-journeys "${WLOGS[@]}"; jr_report; else fail "no walked work logs to judge for freshness"; fi

# ── 7 the DOM audit ─────────────────────────────────────────────────────────
section "7 DOM audit (zero gating findings; what the burn-down owns has an owner and a reason)"
relay < <($W burndown)
gating=$(grep -lE '^dom-audit: *[1-9][0-9]* failing' docs/work-journeys/*/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$gating" = 0 ] && ok "no work log has a gating DOM-audit finding" || fail "$gating work log(s) have gating DOM-audit findings: fix them or own them in docs/journeys/audit-burndown.tsv"

# ── 8 the old hand logs ─────────────────────────────────────────────────────
section "8 the orgiq hand logs are retired; validate-orgiq-audit.sh judges the map logs"
hand=$(find docs/orgiq-journeys -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "$hand" = 0 ] && ok "docs/orgiq-journeys holds no hand-walked logs" || fail "docs/orgiq-journeys still holds $hand hand-walked log(s): regenerate them as maps or retire them"
if grep -q 'docs/work-journeys' scripts/validate-orgiq-audit.sh && ! grep -q 'JDIR=docs/orgiq-journeys' scripts/validate-orgiq-audit.sh; then ok "validate-orgiq-audit.sh reads the work map logs"; else fail "validate-orgiq-audit.sh still reads docs/orgiq-journeys"; fi
if [ "$QUICK" = 0 ]; then
  if bash scripts/validate-orgiq-audit.sh --quick >/tmp/work-journeys-orgiq.$$ 2>&1; then ok "validate-orgiq-audit.sh --quick passes"; else fail "validate-orgiq-audit.sh --quick fails: $(grep -m3 '✗' /tmp/work-journeys-orgiq.$$ | cut -c1-160 | tr '\n' ' ')"; fi
  rm -f /tmp/work-journeys-orgiq.$$
fi

# ── 9 the runner ────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "9 the runner's own tests"
  if node --test scripts/journeys/tests/*.test.mjs >/tmp/work-journeys-tests.$$ 2>&1; then ok "scripts/journeys/tests pass ($(grep -oE 'ℹ pass [0-9]+' /tmp/work-journeys-tests.$$ | grep -oE '[0-9]+'))"; else fail "scripts/journeys/tests fail: $(grep -m2 '✖' /tmp/work-journeys-tests.$$ | tr '\n' ' ')"; fi
  rm -f /tmp/work-journeys-tests.$$
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS — the Work tenant's journeys are deep, complete and walked for every role"; exit 0; fi
echo "${#FAILS[@]} failing check(s) — docs/work-journeys-goal.md names the phase for each"
exit 1
