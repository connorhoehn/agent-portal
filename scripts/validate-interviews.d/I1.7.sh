# Row I1.7, Prepare: the lead's plan of questions. Sourced by scripts/validate-interviews.sh.

row_I1.7() {
  exists $MW/lib/interviews/prepare.ts "the plan's checks (lib/interviews/prepare.ts)"
  exists $MW/routes/interviews/prepare.ts "the prepare route"
  needF "prepareRouter.put('/interviews/:id/questions', requireAction('ConductInterview')" $MW/routes/interviews/prepare.ts "only the lead's action writes the plan"
  want_count "^interviewsRouter\.use\(prepareRouter\)" $MW/routes/interviews.ts 1 "mounted with one line"
  exists $PAGES/PreparePage.tsx "the Prepare page"
  for id in interviews-prepare interviews-prepare-state interviews-prepare-room interviews-prepare-readonly interviews-prepare-missing; do
    if grep -qF "$id" $PAGES/PreparePage.tsx; then ok "test id $id"; else fail "test id $id is gone from Prepare"; fi
  done
  # The plan never shows the opening's money.
  if grep -nE "budgetCapUsd|interviewCapUsd|openingMoney|OpeningMoney|Spending cap" $PAGES/PreparePage.tsx $MW/routes/interviews/prepare.ts $MW/lib/interviews/prepare.ts | grep -vE "^[^:]+:[0-9]+:\s*(//|\*)" >/dev/null; then fail "Prepare or its route reads the opening's money"; else ok "Prepare and its route read no money"; fi
  if has "<(Modal|Dialog|ConfirmDialog)[ >]" $PAGES/PreparePage.tsx; then fail "a modal on Prepare"; else ok "no modal on Prepare"; fi
  refuses_404 I1.7
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the plan's checks and the prepare route" src/lib/interviews/__tests__/prepare.test.ts src/routes/__tests__/interviews-prepare.test.ts
    run_journey
    for s in I1.7a I1.7b I1.7c I1.7d I1.7e I1.7f; do journey_step "$s"; done
  fi
}

built_row I1.7 row_I1.7
