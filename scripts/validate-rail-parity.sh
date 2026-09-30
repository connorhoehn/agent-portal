#!/usr/bin/env bash
# Judge for docs/rail-parity-goal.md — every second rail is the concise
# stacked rail (`StackedRail`), the Org tenant's family.
#
#   ./scripts/validate-rail-parity.sh           # everything, incl. the headless measurement
#   ./scripts/validate-rail-parity.sh --quick   # static checks only
#
# Exit 0 only when every check passes; every failing line is printed.
set -u
cd "$(dirname "$0")/.."
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done
FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }
has()  { grep -qE "$1" "$2" 2>/dev/null; }

RAIL=portal/src/pages/assessment/knowledge/DocumentRail.tsx
GOAL=docs/rail-parity-goal.md
DTS=portal/node_modules/@connorhoehnslalom/ui-components/dist/index.d.ts

section "library — StackedRail is installed"
if [ -f "$DTS" ] && has "export declare function StackedRail" "$DTS"; then ok "StackedRail exported by the installed ui-components"; else fail "installed ui-components has no StackedRail export ($DTS)"; fi

section "assessment documents rail composes StackedRail"
has "StackedRail" "$RAIL" && ok "$RAIL imports StackedRail" || fail "$RAIL: no StackedRail"
for banned in "WorkspaceRail" "KeyboardTreeView" "TreeView size=\"rail\"" "ConversationShelf"; do
  has "$banned" "$RAIL" && fail "$RAIL: still composes $banned (the card-panel family)" || ok "$RAIL: no $banned"
done
for kept in "pull" "New page" "usePresence" "onDrag|draggable|onReorder"; do
  has "$kept" "$RAIL" && ok "$RAIL keeps: $kept" || fail "$RAIL lost: $kept (decision 2)"
done

section "goal doc records the adoption"
for row in "ui-components release: \`?[0-9]+\.[0-9]+\.[0-9]+" "aws-agentcore \`DocumentRail.tsx\`: [0-9a-f]{7,}" "realtime-examples \`DocumentExplorer.tsx\`: [0-9a-f]{7,}"; do
  has "$row" "$GOAL" && ok "recorded: $row" || fail "$GOAL: not recorded yet: $row"
done

if [ "$QUICK" = 0 ]; then
  section "measurement — the two rails agree (headless, 1672×941)"
  if curl -sf -o /dev/null http://localhost:5183/ && curl -sf -o /dev/null http://127.0.0.1:3001/api/health; then
    if (cd portal && node ../scripts/lib/rail-parity-measure.mjs) > /tmp/rail-parity.log 2>&1; then ok "assessment workspace rail matches /iq/library (see /tmp/rail-parity.log)"; else fail "rail measurement failed — see /tmp/rail-parity.log"; sed -n 1,20p /tmp/rail-parity.log | sed 's/^/      /'; fi
    if curl -sf -o /dev/null http://localhost:15174/documents; then
      if (cd portal && RAIL_PARITY_OTHER=http://localhost:15174/documents node ../scripts/lib/rail-parity-measure.mjs --other) > /tmp/rail-parity-other.log 2>&1; then ok "realtime-examples /documents rail matches /iq/library"; else fail "realtime-examples /documents rail differs — see /tmp/rail-parity-other.log"; fi
    else
      ok "realtime-examples is not up on :15174 — its measurement is skipped (rerun with it up)"
    fi
  else
    fail "portal :5183 or middleware :3001 is not up — start them for the measurement"
  fi
fi

echo
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS — every second rail is the concise stacked rail."; exit 0; fi
echo "${#FAILS[@]} CHECK(S) FAILING:"; for f in "${FAILS[@]}"; do echo "  - $f"; done; exit 1
