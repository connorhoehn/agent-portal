# Row I0.6, an opening's money: two caps, what is held, spent and left. Sourced by scripts/validate-interviews.sh.

row_I0.6() {
  need "'learning', 'interviews'" schema/spend_holds_schema.sql "interviews is in the spend holds' source CHECK"
  need "'learning', 'interviews'" schema/spend_ledger_schema.sql "interviews is in the spend ledger's source CHECK"
  exists $MW/lib/interviews/spend.ts "the interviews spend rules"
  needF "openingsRouter.get('/openings/:id/spend'" $MW/routes/interviews/openings.ts "the opening's money route"
  needF "mayReadOpeningMoney(resolveSession(req)!.role)" $MW/routes/interviews/openings.ts "the route answers not-found to anyone who may not read the money"
  needF "mayReadOpeningMoney(this.viewer.role) ? { budgetCapUsd: o.budgetCapUsd } : {}" $MW/lib/interviews/views.ts "the opening record carries the cap only for a reader of money"
  for id in interviews-opening-money interviews-opening-budget-cap interviews-opening-interview-cap; do
    if grep -rqF "$id" $PAGES; then ok "test id $id"; else fail "test id $id is gone from the pages"; fi
  done
  refuses_404 I0.6
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the spend rules, the money routes and the opening record's cap" \
      src/lib/interviews/__tests__/spend.test.ts src/routes/__tests__/interviews-spend.test.ts src/routes/__tests__/interviews-openings.test.ts
    run_journey
    for s in I0.6a I0.6b I0.6c I0.6d I0.6e; do journey_step "$s"; done
  fi
}

built_row I0.6 row_I0.6
