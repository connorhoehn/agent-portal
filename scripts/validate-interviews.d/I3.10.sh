# Row I3.10: Milo drafts a question plan on Prepare (contract E6). Sourced by scripts/validate-interviews.sh.
row_I3_10() {
  local P=$MW/lib/interviews/plan
  needF "planRouter.post('/interviews/:id/plan-draft'" "$MW/routes/interviews/plan.ts" "the lead's draft"
  needF "question: \`Draft \${earlier.length + 1} for a \${interview.type} round of \${interview.minutes} minutes\`" "$P/service.ts" "a plan row names the round, not the candidate"
  needF "is pinned as text" "$P/__tests__/plan.test.ts" "the plan's prompt is pinned as text"
  needF "is pinned as a whole body for a fixed kit" "$P/__tests__/request-pin.test.ts" "the plan's whole request body is pinned"
  refuses_404 I3.10
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f; do journey_step "I3.10$s"; done
  fi
}
built_row I3.10 row_I3_10
