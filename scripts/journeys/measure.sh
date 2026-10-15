#!/usr/bin/env bash
# Measure every inventoried route's RENDERED CONTRACT on the shared stack and
# record it (docs/journeys.md): the rail measurements, the layout-cascade
# sweep and the type-scale sweep, over portal/e2e/route-inventory.ts. Each
# complete measurement writes docs/journeys/contracts/<sweep>.json; the
# journey freshness rule (scripts/lib/journeys.sh) judges logs against them.
# validate-rail-parity.sh (full mode) runs exactly this as its measurement.
#
#   scripts/journeys/measure.sh            # all three (~15 min on the Tilt stack)
#   scripts/journeys/measure.sh rail       # one of: rail cascade type-scale
#
# Needs the shared stack (Vite :5183, middleware :3001); restarts nothing.
# Prints the judges' ✓/✗ lines; exits 1 when any measurement failed its
# judge (the contract is recorded either way — a failing page is a contract too).
set -u
# Every sweep signs in as a dev:mock clone of its persona (own session epoch), so a measurement runs beside
# an audit using the seed personas (docs/mock-floor.md § Scopes and clones). Same grants, same measurements.
export JOURNEY_MEASURE_CLONES=1
cd "$(dirname "$0")/../.."
LOGDIR=${RAIL_PARITY_LOG_DIR:-/tmp}
mkdir -p "$LOGDIR"
WHICH=${1:-all}
FAILED=0
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILED=1; }
# Subjects come from the route inventory, never from a list here.
inv() { (cd portal && node e2e/route-inventory.ts "$@"); }

if ! { curl -sf -o /dev/null http://localhost:5183/ && curl -sf -o /dev/null http://127.0.0.1:3001/api/health; }; then
  fail "portal :5183 or middleware :3001 is not up — start them for the measurement"; exit 1
fi
START=$(inv source-digest)

if [ "$WHICH" = all ] || [ "$WHICH" = rail ]; then
  RAIL_REC=$(mktemp)
  if (cd portal && RAIL_PARITY_CONTRACT_OUT="$RAIL_REC" node ../scripts/lib/rail-parity-measure.mjs) > $LOGDIR/rail-parity.log 2>&1; then ok "assessment workspace rail matches /iq/library (see $LOGDIR/rail-parity.log)"; else fail "rail measurement failed — see $LOGDIR/rail-parity.log"; sed -n 1,20p $LOGDIR/rail-parity.log | sed 's/^/      /'; fi
  IFS=$'\t' read -r SUBJ RUSER RTENANT < <(inv subjects rail-social)
  if (cd portal && env RAIL_PARITY_CONTRACT_OUT="$RAIL_REC" RAIL_PARITY_SUBJECT=$SUBJ RAIL_PARITY_USER=$RUSER ${RTENANT:+RAIL_PARITY_TENANT=$RTENANT} node ../scripts/lib/rail-parity-measure.mjs) > $LOGDIR/rail-parity-social.log 2>&1; then
    ok "social chat rail flush on all six pages as $RUSER (see $LOGDIR/rail-parity-social.log)"; grep '^MATCH' $LOGDIR/rail-parity-social.log | sed 's/^/      /'
  else fail "social chat rail frame differs — see $LOGDIR/rail-parity-social.log"; grep -A6 '^DIFFERS' $LOGDIR/rail-parity-social.log | sed 's/^/      /'; fi
  IFS=$'\t' read -r SUBJ RUSER RTENANT < <(inv subjects rail-communication)
  if (cd portal && env RAIL_PARITY_CONTRACT_OUT="$RAIL_REC" RAIL_PARITY_SUBJECT=$SUBJ RAIL_PARITY_USER=$RUSER ${RTENANT:+RAIL_PARITY_TENANT=$RTENANT} node ../scripts/lib/rail-parity-measure.mjs) > $LOGDIR/rail-parity-communication.log 2>&1; then
    ok "Org › Communication chat rail flush as $RUSER (see $LOGDIR/rail-parity-communication.log)"; grep '^MATCH' $LOGDIR/rail-parity-communication.log | sed 's/^/      /'
  else fail "Communication chat rail frame differs — see $LOGDIR/rail-parity-communication.log"; grep -A6 '^DIFFERS' $LOGDIR/rail-parity-communication.log | sed 's/^/      /'; fi
  LIST_SUBJECTS=$(inv subjects list-rail http://127.0.0.1:3001)
  if (cd portal && RAIL_PARITY_CONTRACT_OUT="$RAIL_REC" RAIL_PARITY_LIST="$LIST_SUBJECTS" node ../scripts/lib/rail-parity-measure.mjs) > $LOGDIR/rail-parity-list.log 2>&1; then
    ok "list rails flush beside the section rail, Initiatives width, trail first after them (see $LOGDIR/rail-parity-list.log)"; grep '^MATCH' $LOGDIR/rail-parity-list.log | sed 's/^/      /'
  else fail "a list rail is not flush — see $LOGDIR/rail-parity-list.log"; grep -A7 '^DIFFERS' $LOGDIR/rail-parity-list.log | sed 's/^/      /'; fi
  if curl -sf -o /dev/null http://localhost:15174/documents; then
    if (cd portal && RAIL_PARITY_OTHER=http://localhost:15174/documents node ../scripts/lib/rail-parity-measure.mjs --other) > $LOGDIR/rail-parity-other.log 2>&1; then ok "realtime-examples /documents rail matches /iq/library"; else fail "realtime-examples /documents rail differs — see $LOGDIR/rail-parity-other.log"; fi
  else
    ok "realtime-examples is not up on :15174 — its measurement is skipped (rerun with it up)"
  fi
  printf '      %s\n' "$(cd portal && node e2e/contracts.ts write rail "$RAIL_REC" "$START")"
  rm -f "$RAIL_REC"
fi

if [ "$WHICH" = all ] || [ "$WHICH" = cascade ]; then
  if (cd portal && npx playwright test e2e/layout-cascade.spec.ts --reporter=line --output="$LOGDIR/layout-cascade-results") > $LOGDIR/layout-cascade.log 2>&1; then
    ok "layout cascade holds on every inventoried route ($(grep -oE 'swept [0-9]+ routes' $LOGDIR/layout-cascade.log | awk '{s+=$2} END {print s}') routes; $LOGDIR/layout-cascade.log)"
  else
    fail "layout cascade violated — see $LOGDIR/layout-cascade.log"; grep -E '( -> .*(rails|list-rail|crumbs-first|gutter|title|footer|hscroll):|baseline: |  no list rail|  a repository|  the list rail|  the trail \(x=)' $LOGDIR/layout-cascade.log | sort -u | head -40 | sed 's/^/      /'
  fi
fi

if [ "$WHICH" = all ] || [ "$WHICH" = type-scale ]; then
  # The type-scale step: every visible text node, top-down, per region; fails on any offender not in the burn-down.
  rm -f "$LOGDIR/type-scale-report.txt"
  if (cd portal && TYPE_SCALE_LOG_DIR="$LOGDIR" npx playwright test e2e/type-scale-sweep.spec.ts --reporter=line --output="$LOGDIR/type-scale-results") > $LOGDIR/type-scale.log 2>&1; then
    ok "type scale holds on every inventoried route — no offender beyond e2e/type-scale-burndown.tsv ($(grep -oE 'swept [0-9]+ routes' $LOGDIR/type-scale.log | awk '{s+=$2} END {print s}') routes; $LOGDIR/type-scale-report.txt)"
    grep -E '^/(iq|assessment|pipelines)/communication ' "$LOGDIR/type-scale-report.txt" | sed 's/^/      /'
  else
    fail "type scale: new offenders — see $LOGDIR/type-scale.log and $LOGDIR/type-scale-report.txt"
    grep -E ' -> .* · (scale|title-scale|above-title|grows|siblings|actions) · ' $LOGDIR/type-scale.log | sort -u | head -40 | sed 's/^/      /'
  fi
fi
exit $FAILED
