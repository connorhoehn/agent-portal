#!/usr/bin/env bash
# Route ↔ test parity, for every router — not just assessment.ts.
#
# `scripts/validate-assessment-tenant.sh` has carried this exact check for one
# router for months and repeatedly caught real gaps: a route nothing calls is
# a route nobody has seen work. This runs the same idea against the whole HTTP
# surface, via `middleware/src/mock/core/coverage/scan.ts` — which reuses
# `mock/core/wire/routes.ts`'s route enumeration rather than re-parsing the
# router files a second way, and matches routes against every
# `request(...).<method>(path)` call the test suite makes.
#
# What "has a test" means, and what this cannot see (a route having *a* test
# says nothing about whether the test is any good; this cannot read the
# assertion), is written out in docs/route-test-coverage.md. Read that before
# loosening anything here.
#
# This is a RATCHET, on the same contract as scripts/orgiq-raw-budget.txt and
# scripts/mock-aggregate-budget.txt: scripts/route-coverage-budget.txt holds
# the ceiling on untested routes. It may only go down.
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"
MW="$REPO/middleware"
BUDGET_FILE="$REPO/scripts/route-coverage-budget.txt"
BUDGET_START=260

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

section "route ↔ test parity (every router)"
if (cd "$MW" && node node_modules/.bin/tsx src/mock/core/coverage/scan.ts > "$TMP/report.txt" 2>"$TMP/err.txt"); then
  n=$(grep -oE '^TOTAL_UNTESTED=[0-9]+' "$TMP/report.txt" | cut -d= -f2)
  total=$(grep -oE 'route coverage: [0-9]+/[0-9]+' "$TMP/report.txt" | head -1 | grep -oE '[0-9]+' | sed -n '2p')
  if [ -z "$n" ]; then
    fail "scan produced no TOTAL_UNTESTED line — see $TMP/err.txt"
  else
    ok "$total routes enumerated, $n without a matching request(...) call"
    budget=$(tr -d ' \n' < "$BUDGET_FILE" 2>/dev/null || true)
    if [ -z "$budget" ]; then
      fail "$BUDGET_FILE missing (write the current count, baseline $BUDGET_START)"; budget=$BUDGET_START
    fi
    if [ "$budget" -gt "$BUDGET_START" ]; then
      fail "route-coverage budget $budget was raised above the $BUDGET_START baseline — it may only go down"
    fi
    if [ "$n" -le "$budget" ]; then
      ok "untested routes: $n ≤ budget $budget"
    else
      fail "untested routes: $n > budget $budget — a route lost its test, or a new route shipped with none"
    fi
    if [ "$n" -lt "$budget" ]; then
      note "budget is stale: lower $BUDGET_FILE to $n"
    fi
    section "worst routers (most untested routes first)"
    awk '/^src\/|^\.\.\/|— [0-9]+ untested$/' "$TMP/report.txt" | head -10 | while IFS= read -r line; do note "$line"; done
  fi
else
  fail "scan crashed — see $TMP/err.txt"
  head -20 "$TMP/err.txt" | sed 's/^/      /'
fi

printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — route coverage is at or under budget."
  exit 0
fi
echo "${#FAILS[@]} CHECK(S) FAILING:"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
