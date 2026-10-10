#!/usr/bin/env bash
# Definition of done for docs/research-honesty-checks-2026-09-16.md — the
# judge for the four recurring "numbers that lie" bug classes found by
# hand over ~40 fixes in one session. Exit 0 only when every check passes.
#
#   --quick   skip tsc (the two static scanners + the class 4 grep still run —
#             they are the whole point of this validator and are fast anyway)
#
# What each class is, why it is or isn't mechanically checkable, and the false-
# positive story for each rule, is written out in the doc above. Read that
# before loosening anything here.
#
# THIS IS A RATCHET for classes 3 and 4, on the same contract as
# scripts/route-coverage-budget.txt: the budget file holds today's count and
# may only go down. Classes 1 and 2 are NOT ratcheted — both are proven,
# mechanically-decidable bugs (see the calibration section below) with a
# demonstrated zero false-positive rate on this codebase, so the budget for
# both is a hard 0: any finding fails the build, full stop.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
REPO="$PWD"
MW="$REPO/middleware"
PORTAL="$REPO/portal"
QUICK=0; for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# ── Class 1 + 2: the AST scanner ────────────────────────────────────────────
# scripts/lib/honest-numbers-scan.cjs — see its header for the two rules.
section "class 1 — a total that is really the length of a capped page"
section "class 2 — a column rendered that the query never selects (server half)"

node "$REPO/scripts/lib/honest-numbers-scan.cjs" > "$TMP/scan.jsonl" 2>"$TMP/scan.err"
if [ -s "$TMP/scan.err" ]; then
  fail "the class 1/2 scanner crashed — see below"
  sed 's/^/      /' "$TMP/scan.err"
else
  n1=$(grep -c '"class":1' "$TMP/scan.jsonl" 2>/dev/null); n1=${n1:-0}
  n2=$(grep -c '"class":2' "$TMP/scan.jsonl" 2>/dev/null); n2=${n2:-0}
  if [ "$n1" = 0 ]; then ok "class 1 (fake totals): 0 findings"; else
    fail "class 1 (fake totals): $n1 finding(s) — budget is 0, this bug class is fully fixed on main"
    grep '"class":1' "$TMP/scan.jsonl" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        for (const line of s.trim().split("\n").filter(Boolean)) {
          const f = JSON.parse(line);
          console.log(`      ${f.file}:${f.line}  ${f.function}()  [${f.rule}]  ${f.detail}`);
        }});'
  fi
  if [ "$n2" = 0 ]; then ok "class 2 (column never selected, server half): 0 findings"; else
    fail "class 2 (column never selected, server half): $n2 finding(s) — budget is 0, this bug class is fully fixed on main"
    grep '"class":2' "$TMP/scan.jsonl" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        for (const line of s.trim().split("\n").filter(Boolean)) {
          const f = JSON.parse(line);
          console.log(`      ${f.file}:${f.line}  ${f.function}()  ${f.detail}`);
        }});'
  fi
fi

# ── Calibration: prove the scanner still catches what it was built to catch ──
# Without this, a future "simplification" of honest-numbers-scan.cjs could
# quietly lose detection power and the 0-finding sections above would read as
# "all clear" instead of "not looking". Runs the scanner against the actual
# pre-fix blobs of the bugs that motivated it (commit 294822c^, the real and
# mock leaderboard totals) plus a synthetic reproduction of the Quality-page
# column-omission bug (class 2 has no single historical commit that isolates
# just the SQL-omission half — the real fix landed interface+SQL together —
# so this rebuilds that exact shape by deleting one column from the CURRENT,
# correct quality.ts query).
section "calibration — would this have caught the bugs it was built for"
CAL="$TMP/calibration"; mkdir -p "$CAL"
git show 294822c^:middleware/src/providers/aurora.ts > "$CAL/aurora-pre-fix.ts" 2>/dev/null
cal_out=$(node "$REPO/scripts/lib/honest-numbers-scan.cjs" "$CAL/aurora-pre-fix.ts" 2>/dev/null)
cal_n=$(printf '%s\n' "$cal_out" | grep -c '"rule":"sliced-then-counted"\|"rule":"limit-no-count"' 2>/dev/null); cal_n=${cal_n:-0}
if [ "$cal_n" -ge 4 ]; then
  ok "class 1 catches the pre-fix aurora.ts (294822c^): $cal_n/4 leaderboard totals flagged"
else
  fail "class 1 scanner regressed: only $cal_n/4 of the known pre-fix leaderboard bugs are still caught"
fi

if [ ! -f "$MW/src/routes/quality.ts" ]; then
  fail "middleware/src/routes/quality.ts missing — calibration fixture can't be built"
else
  sed '/^ *judge_rationale,$/d' "$MW/src/routes/quality.ts" > "$CAL/quality-regressed.ts"
  if diff -q "$MW/src/routes/quality.ts" "$CAL/quality-regressed.ts" >/dev/null 2>&1; then
    fail "calibration fixture: removing judge_rationale from quality.ts's SELECT made no change — quality.ts shape moved, update the calibration section"
  else
    cal2_out=$(node "$REPO/scripts/lib/honest-numbers-scan.cjs" "$CAL/quality-regressed.ts" 2>/dev/null)
    if printf '%s\n' "$cal2_out" | grep -q "judge_rationale"; then
      ok "class 2 catches a regressed quality.ts (judge_rationale deleted from its own SELECT)"
    else
      fail "class 2 scanner regressed: dropping judge_rationale from quality.ts's SELECT was not flagged"
    fi
  fi
fi

# ── Class 3: a failed read rendered as an empty one ─────────────────────────
section "class 3 — a failed read rendered as an empty one (portal)"
node "$REPO/scripts/lib/honest-numbers-emptystate.cjs" > "$TMP/empty.jsonl" 2>"$TMP/empty.err"
if [ -s "$TMP/empty.err" ]; then
  fail "the class 3 scanner crashed — see below"
  sed 's/^/      /' "$TMP/empty.err"
else
  n3=$(wc -l < "$TMP/empty.jsonl" | tr -d ' ')
  BUDGET3_FILE="$REPO/scripts/honest-numbers-class3-budget.txt"
  BUDGET3_START=4
  budget3=$(tr -d ' \n' < "$BUDGET3_FILE" 2>/dev/null || true)
  if [ -z "$budget3" ]; then fail "$BUDGET3_FILE missing (write the current count, baseline $BUDGET3_START)"; budget3=$BUDGET3_START; fi
  if [ "$budget3" -gt "$BUDGET3_START" ]; then fail "class 3 budget $budget3 was raised above the $BUDGET3_START baseline — it may only go down"; fi
  if [ "$n3" -le "$budget3" ]; then
    ok "candidates: $n3 ≤ budget $budget3"
  else
    fail "candidates: $n3 > budget $budget3 — a page lost its error check, or a new one shipped without one"
  fi
  [ "$n3" -lt "$budget3" ] && note "budget is stale: lower $BUDGET3_FILE to $n3"
  if [ "$n3" -gt 0 ]; then
    note "candidates for human triage:"
    node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const f = JSON.parse(line);
        console.log("      " + f.file + (f.line ? ":" + f.line : "") + "  [" + f.rule + "]");
      }
    ' "$TMP/empty.jsonl"
  fi
fi

# Calibration for class 3: FindingsPage.tsx is the shipped counter-example —
# it destructures `error`/`degraded` off its findings useFetch call and must
# stay UNflagged, proving this isn't just "every EmptyState user fails".
if [ -f "$PORTAL/src/pages/work/FindingsPage.tsx" ]; then
  if node "$REPO/scripts/lib/honest-numbers-emptystate.cjs" "$PORTAL/src/pages/work/FindingsPage.tsx" 2>/dev/null | grep -q .; then
    fail "class 3 calibration: FindingsPage.tsx (which DOES check error/degraded) was flagged — false positive regression"
  else
    ok "class 3 calibration: FindingsPage.tsx (checks error/degraded) correctly NOT flagged"
  fi
fi

# Calibration for rule B (SmartEmptyState without a `degraded` prop). Two
# halves, because this rule has failed in both directions in one sitting:
#
#   RECALL — the pre-fix ApprovalQueuePage is the shape the rule exists for.
#   Its seed fetch swallowed every failure under "empty state handles it"
#   while the empty state said "Nothing is waiting on you". If a rewrite of
#   the scanner stops flagging that file, the rule is decorative.
#
#   PRECISION — ToolCallsPage passes `degraded`, but its `title` prop holds
#   `allErrors.length > 0 ? … `, and the first draft of the tag parser treated
#   that `>` as the end of the opening tag and never reached the prop. It must
#   stay UNflagged.
CAL3="$TMP/cal3"; mkdir -p "$CAL3"
cat > "$CAL3/RecallCase.tsx" <<'EOF_CAL'
export function RecallCase() {
  return <SmartEmptyState title="Nothing is waiting on you" detail="An empty queue." />;
}
EOF_CAL
cat > "$CAL3/PrecisionCase.tsx" <<'EOF_CAL'
export function PrecisionCase() {
  return (
    <SmartEmptyState
      title={allErrors.length > 0 ? 'No errors match these filters' : 'No tool errors'}
      degraded={errorPanelBlind}
    />
  );
}
EOF_CAL
if node "$REPO/scripts/lib/honest-numbers-emptystate.cjs" "$CAL3/RecallCase.tsx" 2>/dev/null | grep -q 'smartemptystate-no-degraded-prop'; then
  ok "class 3 rule B recall: a bare <SmartEmptyState> (no degraded prop) is flagged"
else
  fail "class 3 rule B recall: a bare <SmartEmptyState> was NOT flagged — the rule has stopped working"
fi
if node "$REPO/scripts/lib/honest-numbers-emptystate.cjs" "$CAL3/PrecisionCase.tsx" 2>/dev/null | grep -q .; then
  fail "class 3 rule B precision: a <SmartEmptyState> that DOES pass degraded was flagged — the tag parser is tripping on a '>' inside a prop expression again"
else
  ok "class 3 rule B precision: degraded passed alongside a '>' in a prop expression correctly NOT flagged"
fi

# ── Class 4: a measurement where there is none ──────────────────────────────
section "class 4 — a measurement where there is none (candidates, not verdicts)"
# Three independent textual shapes, unioned and deduped by file:line. Every
# hit here needs a human: some of these zeros are honest (0 words for empty
# text), some are the exact bug (100% SLA over zero decisions) — see the doc.
{
  grep -rnE "Number\(r\[['\"][a-zA-Z_0-9]+['\"]\]\s*\?\?\s*0\)" middleware/src/routes middleware/src/providers 2>/dev/null \
    | grep -iE "(p[0-9]{2}[a-z]*|percentile|avg[a-z]*|mean[a-z]*|rate[a-z]*|fraction[a-z]*|sla[a-z]*|score[a-z]*|latency[a-z]*):"
  grep -rniE "COALESCE\([^,]+,\s*0\)\s+AS\s+(p[0-9]{2}|avg[a-z_]*|mean[a-z_]*|rate[a-z_]*|sla[a-z_]*|score[a-z_]*|latency[a-z_]*)" middleware/src/routes middleware/src/providers 2>/dev/null
  grep -rnE "[a-zA-Z_.]+\s*(>|===|!==|<)\s*0\s*\?[^:]*\/[^:]*:\s*[0-9][^0-9]" middleware/src/routes middleware/src/providers middleware/src/lib 2>/dev/null
  grep -rnE "[a-zA-Z_.]+\s*===?\s*0\s*\?\s*[0-9]+\s*:[^;]*\/" middleware/src/routes middleware/src/providers middleware/src/lib 2>/dev/null
} | grep -v '/__tests__/' | sort -t: -k1,1 -k2,2n -u > "$TMP/class4.txt"
n4=$(wc -l < "$TMP/class4.txt" | tr -d ' ')
BUDGET4_FILE="$REPO/scripts/honest-numbers-class4-budget.txt"
BUDGET4_START=22
budget4=$(tr -d ' \n' < "$BUDGET4_FILE" 2>/dev/null || true)
if [ -z "$budget4" ]; then fail "$BUDGET4_FILE missing (write the current count, baseline $BUDGET4_START)"; budget4=$BUDGET4_START; fi
if [ "$budget4" -gt "$BUDGET4_START" ]; then fail "class 4 budget $budget4 was raised above the $BUDGET4_START baseline — it may only go down"; fi
if [ "$n4" -le "$budget4" ]; then
  ok "candidates: $n4 ≤ budget $budget4"
else
  fail "candidates: $n4 > budget $budget4 — a new zero-on-empty default shipped"
fi
[ "$n4" -lt "$budget4" ] && note "budget is stale: lower $BUDGET4_FILE to $n4"
if [ "$n4" -gt 0 ]; then
  note "candidates for human triage:"
  sed 's/^/      /' "$TMP/class4.txt"
fi

# Calibration for class 4: the historical harness.ts avgDurationMs bug
# (`n === 0 ? 0 : total / n`, fixed in 85c00bd) must still match the
# "count===0 ? literal : ratio" shape.
git show 85c00bd^:middleware/src/routes/harness.ts > "$TMP/harness-pre-fix.ts" 2>/dev/null
if grep -qE "[a-zA-Z_.]+\s*===?\s*0\s*\?\s*[0-9]+\s*:[^;]*\/" "$TMP/harness-pre-fix.ts" 2>/dev/null; then
  ok "class 4 catches the pre-fix harness.ts avgDurationMs (85c00bd^): \"n === 0 ? 0 : total / n\""
else
  fail "class 4 grep regressed: the pre-fix harness.ts avgDurationMs shape is no longer matched"
fi

# ── Builds ───────────────────────────────────────────────────────────────────
section "builds"
if [ "$QUICK" = 0 ]; then
  jg_mw_tsc >/dev/null 2>&1 && ok "middleware tsc" || fail "middleware tsc errors"
  jg_portal_tsc >/dev/null 2>&1 && ok "portal tsc" || fail "portal tsc errors"
fi

printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — honest-numbers scanners agree with the current codebase."
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
