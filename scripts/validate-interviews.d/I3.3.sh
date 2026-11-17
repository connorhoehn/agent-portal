# Row I3.3: the coach (a scripted stand-in in the mock world) and the suggestion log (decisions 6, 8, 20; contract D7).
# Sourced by scripts/validate-interviews.sh.
row_I3_3() {
  local S=schema/interviews_schema.sql C=$MW/lib/interviews/coach
  needF "CREATE TABLE IF NOT EXISTS interview_suggestions (" "$S" "the suggestion log's table"
  needF "answer          TEXT CHECK (answer IN ('ask', 'milo-ask', 'skip'))" "$S" "an answer is one of the three"
  needF "CHECK ((dropped IS NULL) = (competency_id IS NOT NULL))" "$S" "row rule: a kept suggestion has its competency, a dropped one none"
  needF "CHECK (dropped IS NULL OR (text = '' AND based_on IS NULL AND answer IS NULL))" "$S" "row rule: a dropped attempt keeps no text, quote or answer"
  needF "CHECK ((answer IS NULL) = (answered_at IS NULL))" "$S" "row rule: an answer has its time"
  needF "'interview_suggestions'" "$MW/lib/interviews/__tests__/interviews-postgres.test.ts" "the table is in the real-Postgres row-level list"
  needF "is pinned as text for a fixed input" "$C/__tests__/prompt.test.ts" "the coach's request is pinned as text"
  for a in "answer: 'ask'" "answer: 'milo-ask'" "answer: 'skip'"; do needF "$a" "$MW/mock/interviews-suggestions.ts" "the seeded log has $a"; done
  needF "coachRouter.get('/interviews/:id/suggestion'" "$MW/routes/interviews/coach.ts" "the lead's read"
  exists "$C/__tests__/parse.limits.test.ts" "the guard's limits as fixed-transcript cases (O-109)"
  refuses_404 I3.3
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g; do journey_step "I3.3$s"; done
  fi
}
built_row I3.3 row_I3_3
