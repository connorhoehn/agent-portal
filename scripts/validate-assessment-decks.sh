#!/usr/bin/env bash
# Definition of done for docs/assessment-deck-goal.md — assessment review decks:
# the vendored deck engine, the middleware routes/providers, the drafter
# commands, the portal client, and the real-session browser journey. Exit 0
# only when every check passes; every failing line prints.
# Flags: --quick skips the slow suites (middleware jest, portal tsc, the browser).
#
# The journey (portal/e2e/assessment-decks-real.spec.ts) needs the dev:mock:social
# stack — a BFF with MOCK_AURORA + MOCK_AGENTCORE and the realtime gateway —
# behind a portal; PARITY_BASE_URL points at that portal (default :5183). An
# unreachable portal is a FAILURE here, not a skip: the judge cannot pass
# without the browser half.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

# The engine moved into realtime-modules at 0.112.0 (`/deck` subpath). The pin
# keeps moving (0.113 the same day), so the check is "both consumers pin the
# SAME realtime-modules sha, at or above 0.112.0, and the /deck subpath resolves
# from the installed package" — not a frozen sha that goes red on every bump.
ENGINE_MIN_VERSION=0.112.0
LOG_DIR=${TMPDIR:-/tmp}

# ─────────────────────────────────────────────────────────────────────────────
section "engine — realtime-modules /deck (no longer vendored)"
if [ -d middleware/src/lib/deck ]; then fail "middleware/src/lib/deck still exists (engine is the library's /deck subpath)"; else ok "no vendored engine under middleware/src/lib/deck"; fi
mw_sha=$(grep -oE 'realtime-modules#[0-9a-f]{40}' middleware/package.json | cut -d# -f2)
po_sha=$(grep -oE 'realtime-modules#[0-9a-f]{40}' portal/package.json | cut -d# -f2)
if [ -n "$mw_sha" ] && [ "$mw_sha" = "$po_sha" ]; then ok "middleware and portal pin the same realtime-modules sha ($mw_sha)"
else fail "middleware ($mw_sha) and portal ($po_sha) pin different realtime-modules shas"; fi
installed=$(node -p "require('./middleware/node_modules/@connorhoehn/realtime-modules/package.json').version" 2>/dev/null)
if [ -n "$installed" ] && [ "$(printf '%s\n%s\n' "$ENGINE_MIN_VERSION" "$installed" | sort -V | head -1)" = "$ENGINE_MIN_VERSION" ]; then
  ok "installed realtime-modules $installed carries the /deck engine (>= $ENGINE_MIN_VERSION)"
else fail "installed realtime-modules ${installed:-none} is below $ENGINE_MIN_VERSION (no /deck engine)"; fi
(cd middleware && node --input-type=module -e "import('@connorhoehn/realtime-modules/deck').then(m=>{if(!Object.keys(m).length)process.exit(1)})" >/dev/null 2>&1) \
  && ok "realtime-modules/deck resolves from the middleware" || fail "realtime-modules/deck does not resolve from the middleware"
grep -qiE 'deck engine|DeckSpec' docs/ui-components-queue.md \
  && ok "extracting the engine is queued in docs/ui-components-queue.md" \
  || fail "docs/ui-components-queue.md has no row for extracting the deck engine"

# ─────────────────────────────────────────────────────────────────────────────
section "contract — portal client against the backend"
# The reconciled shapes: revisions newest first, lastRun surfaced, 409 carries
# activeRevisionId, the download name is <slug>-v<seq>.pptx.
# The deck client's shared shapes (DeckDetailCore, the 409 conflict error) live in components/decks/deckApi.ts; decksApi.ts extends them.
grep -q 'lastRun' portal/src/components/decks/deckApi.ts && ok "deckApi types lastRun" || fail "components/decks/deckApi.ts does not type lastRun"
grep -q 'activeRevisionId' portal/src/components/decks/deckApi.ts && ok "deckApi reads the 409 activeRevisionId" || fail "components/decks/deckApi.ts ignores the 409 activeRevisionId"
if grep -n 'revisions\.at(-1)' portal/src/pages/assessment/decks/*.ts portal/src/pages/assessment/decks/*.tsx portal/src/components/decks/*.ts portal/src/components/decks/*.tsx >/dev/null 2>&1; then
  fail "a deck page treats the LAST revision as newest (the server lists newest first)"
else ok "no deck page reads revisions.at(-1) as the newest"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "agent — drafter commands (synth venv)"
if (cd agents/assessment-drafter && ../../.venv-synth/bin/python -m unittest test_document_commands >"$LOG_DIR/assessment-decks-drafter.log" 2>&1); then
  ok "drafter test_document_commands passes (non-verbatim span falls back to template text)"
else
  fail "agents/assessment-drafter test_document_commands failing — see $LOG_DIR/assessment-decks-drafter.log"
  tail -15 "$LOG_DIR/assessment-decks-drafter.log" | sed 's/^/      /'
fi

# ─────────────────────────────────────────────────────────────────────────────
section "portal"
if (cd portal && node --test 'src/pages/assessment/decks/__tests__/*.test.ts' >"$LOG_DIR/assessment-decks-portal.log" 2>&1); then
  ok "portal decks node:test suite passes"
else
  fail "portal decks node:test suite failing — see $LOG_DIR/assessment-decks-portal.log"
  grep -E '^not ok|✖' "$LOG_DIR/assessment-decks-portal.log" | head -10 | sed 's/^/      /'
fi
if [ "$QUICK" = 0 ]; then
  if jg_portal_tsc >"$LOG_DIR/assessment-decks-tsc.log" 2>&1; then ok "portal tsc clean"; else fail "portal: tsc errors — see $LOG_DIR/assessment-decks-tsc.log"; head -10 "$LOG_DIR/assessment-decks-tsc.log" | sed 's/^/      /'; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "middleware — deck suites (engine, facts/narrative, providers, routes) + typecheck"
  SUITES=$(cd middleware && find src -path '*__tests__*' -iname '*deck*.test.ts' | sort | tr '\n' ' ')
  FACTS=$(cd middleware && find src/lib/assessment-deck -path '*__tests__*' -name '*.test.ts' | sort | tr '\n' ' ')
  [ -n "$SUITES$FACTS" ] || fail "no deck jest suites found under middleware/src"
  if (cd middleware && npx jest --config jest.config.cjs $SUITES $FACTS src/routes/__tests__/pipelines-definitions.test.ts >"$LOG_DIR/assessment-decks-jest.log" 2>&1); then
    ok "middleware deck suites pass: $(grep -E '^Tests:' "$LOG_DIR/assessment-decks-jest.log")"
  else
    fail "middleware deck jest suites failing — see $LOG_DIR/assessment-decks-jest.log"
    grep -E '●|^Tests:' "$LOG_DIR/assessment-decks-jest.log" | head -12 | sed 's/^/      /'
  fi
  if jg_mw_typecheck >"$LOG_DIR/assessment-decks-mw-tsc.log" 2>&1; then ok "middleware typecheck clean"; else fail "middleware typecheck failing — see $LOG_DIR/assessment-decks-mw-tsc.log"; head -10 "$LOG_DIR/assessment-decks-mw-tsc.log" | sed 's/^/      /'; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "gates — component discipline, nav parity, route coverage"
Q=""; [ "$QUICK" = 1 ] && Q="--quick"
for gate in component-discipline nav-parity route-coverage; do
  if bash "scripts/validate-$gate.sh" $Q >"$LOG_DIR/assessment-decks-$gate.log" 2>&1; then
    ok "validate-$gate.sh passes"
  else
    fail "validate-$gate.sh failing — see $LOG_DIR/assessment-decks-$gate.log"
    grep -E '✗|FAIL|failing' "$LOG_DIR/assessment-decks-$gate.log" | head -8 | sed 's/^/      /'
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "browser — real BFF journey (assessment-decks-real.spec.ts)"
  BASE=${PARITY_BASE_URL:-http://localhost:5183}
  if curl -s -m 5 -o /dev/null "$BASE/"; then
    if (cd portal && PARITY_BASE_URL="$BASE" npx playwright test e2e/assessment-decks-real.spec.ts --reporter=line >"$LOG_DIR/assessment-decks-journey.log" 2>&1); then
      ok "journey passed against $BASE: $(grep -E '[0-9]+ passed' "$LOG_DIR/assessment-decks-journey.log" | tail -1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | xargs) (create+run, agent revise, download PK, manual save + stale 409 banner, share to #general: member 200, non-member 403)"
    else
      fail "journey failed against $BASE — see $LOG_DIR/assessment-decks-journey.log"
      sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$LOG_DIR/assessment-decks-journey.log" | grep -vE '^\s*$' | tail -20 | sed 's/^/      /'
    fi
  else
    fail "SKIPPED-not-reachable: no portal at $BASE (start the dev:mock:social stack, or set PARITY_BASE_URL) — the browser half did not run"
  fi
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS"; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
