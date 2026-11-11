#!/usr/bin/env bash
# validate-learning-loop.sh — the judge for the learning loop (docs/learning-loop-design.md, "Acceptance").
#
# Runs, in this order, and prints one PASS or FAIL line per item and a final verdict:
#   items 1 to 12   scripts/journeys/learning-loop.mjs, through scripts/journeys/run-demo-moments.mjs: its own
#                   mock middleware and portal, real dispatches against the fake microVM, no model
#   item 13         scripts/learning-loop/debrief-e2e.mjs: the real local worker, a stub `claude`, a throwaway repository
#   item 14         scripts/learning-loop/local-report-e2e.mjs: the same harness, a brief that gives a runbook
#   suites          the middleware suites the loop owns (run reports, runbooks, the debrief, the mock's offer, the brief
#                   contract, local compute, the microVM dispatcher, the wire, parity, guard and scope suites) and the portal suite
#
# Ports, so it never touches anyone's running stack (each stack below is booted and stopped by its own script):
#   JOURNEY_MIDDLEWARE_PORT  JOURNEY_PORTAL_PORT  LL_E2E_PORT  LL_DEBRIEF_PORT
#   (each script's own default applies when a variable is unset; set all four when anyone else is running servers)
# Also needed: PLAYWRIGHT_BROWSERS_PATH where Playwright's browsers are installed.
#
# Usage:  scripts/validate-learning-loop.sh [--skip-suites]
# Exit 0 only when every item and every suite passes.
#
# Item results are read from what each script printed (its PASS/FAIL lines), never inferred from an exit code alone:
# an exit code with no matching PASS line is a FAIL.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_SUITES=0
for a in "$@"; do case "$a" in --skip-suites) SKIP_SUITES=1 ;; esac; done

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/validate-learning-loop-XXXXXX")"
FAILS=()
pass() { printf 'PASS  %s\n' "$1"; }
fail() { FAILS+=("$1"); printf 'FAIL  %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

printf 'validate-learning-loop: logs in %s\n' "$LOGS"

# ── items 1 to 12: the journey ───────────────────────────────────────────────
section "items 1 to 12: scripts/journeys/learning-loop.mjs (the mock, real dispatches, no model)"
JOURNEY_LOG="$LOGS/journey.log"
( cd portal && node ../scripts/journeys/run-demo-moments.mjs --journey learning-loop ) >"$JOURNEY_LOG" 2>&1
JOURNEY_CODE=$?

# The journey names its steps L<item>: ...; a step is the item's result. L10 has a second step, L10b.
ITEM_TITLES=(
  ""
  "the logout cookie bug's run page shows its report and what it learned"
  "the proposal shows the runbook in full, a passing lint, the run's obstacles and Demo data"
  "a second persona accepts; the confirmation states the repository; the version names the run"
  "a related work item lists the runbook with its reason; a pinned one goes first"
  "the related item's run: its Brief shows the runbook; its Runbooks section shows it given and followed"
  "the runbook's page lists the run, its health is proven, the evidence line counts it"
  "the dashboard item is given nothing, and Learned says why there was no debrief"
  "the cold-start bug fails, and its second run shows the first attempt under previous attempts"
  "three unfollowed successful runs give one retire proposal naming them"
  "with ten run-authored proposals open, the next debrief is skipped: review-queue-full"
  "an initiative crossing 80 percent: one bell item and a mark on Budgets"
  "a proposal with a script cannot be accepted until the reviewer ticks that they read it"
)
for n in 1 2 3 4 5 6 7 8 9 10 11 12; do
  # L10 also needs its second step (the skipped run's own page).
  want="L${n}:"
  if grep -q "^PASS ${want}" "$JOURNEY_LOG" && ! grep -q "^FAIL ${want}" "$JOURNEY_LOG"; then
    if [ "$n" = 10 ] && ! grep -q "^PASS L10b:" "$JOURNEY_LOG"; then
      fail "item 10: ${ITEM_TITLES[$n]} (its run page did not print the stored sentence)"
    else
      pass "item $n: ${ITEM_TITLES[$n]}"
    fi
  else
    fail "item $n: ${ITEM_TITLES[$n]}"
  fi
done
# The steps after the acceptance items belong to the journey too.
for s in R1 R2 R3; do
  if grep -q "^PASS ${s}:" "$JOURNEY_LOG" && ! grep -q "^FAIL ${s}:" "$JOURNEY_LOG"; then
    pass "journey step $s"
  else
    fail "journey step $s"
  fi
done
if [ "$JOURNEY_CODE" -ne 0 ]; then
  fail "the journey exited $JOURNEY_CODE (see $JOURNEY_LOG)"
  grep -E "^FAIL|^  " "$JOURNEY_LOG" | head -20 | sed 's/^/      /'
fi

# ── items 13 and 14: the real local worker against a stub claude ─────────────
section "item 13: scripts/learning-loop/debrief-e2e.mjs (the real worker, a stub claude, a throwaway repository)"
node scripts/learning-loop/debrief-e2e.mjs >"$LOGS/debrief-e2e.log" 2>&1
code=$?
if [ "$code" -eq 0 ]; then pass "item 13: the report is stored with its session id, the worker resumes it, the kept folder becomes a proposal that passes lint"; else fail "item 13: debrief-e2e exited $code (see $LOGS/debrief-e2e.log)"; tail -n 12 "$LOGS/debrief-e2e.log" | sed 's/^/      /'; fi

section "item 14: scripts/learning-loop/local-report-e2e.mjs (a brief that gives a runbook)"
node scripts/learning-loop/local-report-e2e.mjs >"$LOGS/local-report-e2e.log" 2>&1
code=$?
if [ "$code" -eq 0 ]; then pass "item 14: the stub received the runbook and the previous attempts inside the fence; the report records it followed"; else fail "item 14: local-report-e2e exited $code (see $LOGS/local-report-e2e.log)"; tail -n 12 "$LOGS/local-report-e2e.log" | sed 's/^/      /'; fi

# ── the suites ───────────────────────────────────────────────────────────────
if [ "$SKIP_SUITES" -eq 0 ]; then
  section "middleware suites the loop owns"
  # Regexes against test paths: run reports, runbooks, the debrief, the mock's offer and fake-microVM runs, the brief
  # contract, local compute, the microVM dispatcher, and the wire, parity, guard and scope suites.
  PATTERNS=(
    'lib/run-reports/__tests__' 'lib/runbooks/__tests__'
    'routes/__tests__/run-reports' 'routes/__tests__/runbook' 'routes/__tests__/learning-loop-offer-mock'
    'routes/__tests__/local-compute' 'lib/__tests__/local-compute' 'lib/__tests__/microvm-dispatcher'
    'lib/__tests__/learning-budget' 'providers/__tests__/work-item-runbook-pins'
    'mock/__tests__/runbook' 'mock/core/wire/__tests__' 'mock/core/parity/__tests__'
    'lib/__tests__/.*guard' 'lib/__tests__/.*scope' 'routes/__tests__/.*scope' 'routes/__tests__/mock-scope'
  )
  ( cd middleware && node node_modules/.bin/jest --config jest.config.cjs --maxWorkers=3 "${PATTERNS[@]}" ) >"$LOGS/middleware-suites.log" 2>&1
  code=$?
  summary="$(grep -E '^(Tests|Test Suites):' "$LOGS/middleware-suites.log" | tr '\n' ' ')"
  if [ "$code" -eq 0 ]; then pass "middleware suites: $summary"; else fail "middleware suites: $summary(see $LOGS/middleware-suites.log)"; grep -E '✕|FAIL ' "$LOGS/middleware-suites.log" | head -15 | sed 's/^/      /'; fi

  section "portal suite"
  ( cd portal && npm test ) >"$LOGS/portal-suite.log" 2>&1
  code=$?
  summary="$(grep -E '^(Tests|Test Files|Test Suites):|Tests +[0-9]+' "$LOGS/portal-suite.log" | tr '\n' ' ')"
  if [ "$code" -eq 0 ]; then pass "portal suite: $summary"; else fail "portal suite: $summary(see $LOGS/portal-suite.log)"; grep -E '✕|FAIL|×' "$LOGS/portal-suite.log" | head -15 | sed 's/^/      /'; fi
fi

# ── verdict ──────────────────────────────────────────────────────────────────
section "verdict"
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "validate-learning-loop: ALL PASS"
  exit 0
fi
echo "validate-learning-loop: ${#FAILS[@]} FAIL"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
