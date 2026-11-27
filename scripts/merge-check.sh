#!/usr/bin/env bash
# The check to run before merging a package into main (ledger row CI-11).
#
# A package that adds a route, a schema column or an authority write trips checks that live outside its own
# tests: the wire and write snapshots, the voice inventory, the mock-to-schema shape parity, the two-store
# agreement and the authority-invalidation coverage. This runs all of it in one go:
#
#   1. typecheck the middleware and the portal
#   2. the portal's tests
#   3. recapture the wire and write snapshots against a mock middleware this script starts on its own port
#      and stops again (never the developer's own server; it does not persist pairings)
#   4. rewrite and check the voice inventory (a new route with no decision row fails here)
#   5. the full middleware suite
#
#   scripts/merge-check.sh              everything
#   scripts/merge-check.sh --quick      skip the full middleware suite (steps 1 to 4 and the mock-core suites)
#   scripts/merge-check.sh --no-capture skip step 3 (nothing listens, nothing is recaptured)
#   MERGE_CHECK_PORT=3011               the port for step 3 (default 3011; the script refuses a port in use)
#
# It changes tracked files when a recapture or the inventory differs: review `git status` and commit them with
# the package. Exit 0 only when every step passed and nothing it started is still listening.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MERGE_CHECK_PORT:-3011}"
QUICK=0; CAPTURE=1
for a in "$@"; do case "$a" in --quick) QUICK=1;; --no-capture) CAPTURE=0;; *) echo "unknown option: $a" >&2; exit 2;; esac; done

L="$(mktemp -d -t merge-check)"   # this run's logs
FAILED=()
step() { printf '\n== %s\n' "$1"; }
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; FAILED+=("$1"); }
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

step "1. typecheck"
(cd "$ROOT/middleware" && npx tsc --noEmit >$L/tsc-mw.log 2>&1) && ok "middleware typecheck" || { bad "middleware typecheck"; tail -n 15 $L/tsc-mw.log; }
(cd "$ROOT/portal" && npx tsc --noEmit >$L/tsc-portal.log 2>&1) && ok "portal typecheck" || { bad "portal typecheck"; tail -n 15 $L/tsc-portal.log; }

step "2. portal tests"
(cd "$ROOT/portal" && npm test >$L/portal.log 2>&1) && ok "portal tests ($(grep -E '^ℹ pass' $L/portal.log | tr -d 'ℹ ' ))" \
  || { bad "portal tests"; grep -E '^not ok|✖' $L/portal.log | head -15; }

if [ "$CAPTURE" = 1 ]; then
  step "3. snapshots, recaptured against a private mock server on :$PORT"
  if [ -n "$(listening)" ]; then
    bad "port $PORT is in use; nothing was recaptured (set MERGE_CHECK_PORT, or pass --no-capture)"
  else
    LOG="$(mktemp -t merge-check-mock)"
    ( cd "$ROOT/middleware" && PORT="$PORT" VOICE_LOG_DIR="$(mktemp -d -t merge-check-voice)" SPEND_HOLDS_UNATTRIBUTED=allow DEV_OFFLINE=true \
        MOCK_AURORA=true MOCK_AGENTCORE=true MOCK_GUARDRAILS=true MOCK_CLOUDWATCH=true MOCK_QUEUE=true POLICY_STORE_ID= \
        SESSION_SIGNING_SECRET_ARN= COGNITO_USER_POOL_ID= COGNITO_CLIENT_ID= COGNITO_CLIENT_SECRET= COGNITO_DOMAIN= COGNITO_CALLBACK_URL= \
        NODE_ENV=development INSECURE_DEV_MODE=true AUTH_DEMO_MODE=true nohup npx tsx src/index.ts >"$LOG" 2>&1 & )
    up=0
    for _ in $(seq 1 45); do
      if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 200; then up=1; break; fi
      sleep 2
    done
    if [ "$up" = 1 ]; then
      (cd "$ROOT/middleware" && WIRE_BASE_URL="http://127.0.0.1:$PORT" npx tsx src/mock/core/wire/capture.ts >$L/capture.log 2>&1) \
        && ok "snapshots recaptured ($(grep -E 'GET routes captured' $L/capture.log | sed 's/^wire: //'))" \
        || { bad "snapshot capture"; tail -n 15 $L/capture.log; }
    else
      bad "the mock server did not answer on :$PORT within 90 seconds"; tail -n 15 "$LOG"
    fi
    pid="$(listening)"; [ -n "$pid" ] && kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5; do [ -z "$(listening)" ] && break; sleep 1; done
    [ -z "$(listening)" ] && ok "nothing is left listening on :$PORT" || bad "a process is still listening on :$PORT (pid $(listening))"
  fi
fi

step "4. voice inventory"
(cd "$ROOT" && node scripts/voice/inventory.mjs >$L/inventory.log 2>&1; node scripts/voice/inventory.mjs --check >>$L/inventory.log 2>&1) \
  && ok "voice inventory" || { bad "voice inventory (a new route needs a decision row in scripts/voice/inventory.mjs)"; grep -vE '^(OK|FAIL|wrote)' $L/inventory.log | head -12; }

if [ "$QUICK" = 1 ]; then
  step "5. the repo-wide check suites (--quick: not the full middleware suite)"
  (cd "$ROOT/middleware" && npx jest src/mock/core src/lib/gateway/__tests__/authority-invalidation-coverage.test.ts >$L/jest.log 2>&1)
else
  step "5. the full middleware suite (about ten minutes)"
  (cd "$ROOT/middleware" && npm test >$L/jest.log 2>&1)
fi
if [ $? = 0 ]; then ok "middleware tests ($(grep -E '^Tests:' $L/jest.log | sed 's/^Tests: *//'))"
else bad "middleware tests"; grep -E '^FAIL |^Tests:' $L/jest.log | sort -u | head -20; fi

step "result"
(cd "$ROOT" && git status --short -- docs/voice-tool-inventory.json middleware/src/mock/core/wire/snapshots | sed 's/^/changed: /')
if [ "${#FAILED[@]}" = 0 ]; then echo "ALL PASS"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILED[@]}"; printf '  %s\n' "${FAILED[@]}"; exit 1
