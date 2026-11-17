# Row I3.6: Milo for you, live (decisions 6, 20, 21; contract E5). Sourced by scripts/validate-interviews.sh.
row_I3_6() {
  local N=$MW/lib/interviews/milo-notes
  needF "export const FIXED_ANSWER = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.'" "$N/rules.ts" "the fixed sentence"
  needF "miloRouter.post('/interviews/:id/milo-ask'" "$MW/routes/interviews/milo.ts" "the lead's ask"
  needF "is pinned as text for a fixed input" "$N/__tests__/prompt.test.ts" "Milo's request is pinned as text"
  needF "CREATE TABLE IF NOT EXISTS interview_coach_log (" schema/interviews_schema.sql "the log's table (each ask is a row)"
  exists "$N/__tests__/parse.limits.test.ts" "the pre-check's limits as fixed cases (O-123)"
  exists "$MW/routes/__tests__/interviews-milo.H3.test.ts" "two lead tabs at once; the recruiter's reads (O-121, O-122)"
  refuses_404 I3.6
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the H3 Milo route edges" src/routes/__tests__/interviews-milo.H3.test.ts
    run_journey
    for s in a b c d e f g; do journey_step "I3.6$s"; done
  fi
}
built_row I3.6 row_I3_6
