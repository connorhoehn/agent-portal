# Row I4.5: the coach reads the pad and the last run (lane H8). Sourced by scripts/validate-interviews.sh. The code suite is
# the I4 floor (src/lib/interviews/coach/__tests__/code.test.ts). The walk step is written by piece I4.4 (the same room:
# a failing run, then the lead's next suggestion), so the walk this row reads is I4.4's.
row_I4_5() {
  local C=$MW/lib/interviews/coach/__tests__/code.test.ts
  exists "$C" "the code suite"
  needF "is pinned as text for a fixed pad and run; the system prompt gains the code rules and keeps every other rule" "$C" "the request with a Code part, pinned as text"
  needF "coachCodeFor(interview)" "$MW/lib/interviews/coach/service.ts" "the coach reads the pad and the last run for each suggestion"
  needF "latestPadSnapshot" "$MW/lib/interviews/pad/log/index.ts" "the pad's last snapshot is what the coach reads"
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    journey_step I4.5a
  fi
}
built_row I4.5 row_I4_5
