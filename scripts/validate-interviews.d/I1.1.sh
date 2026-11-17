# Row I1.1, the Candidates page. Sourced by scripts/validate-interviews.sh.

row_I1.1() {
  exists $PAGES/CandidatesPage.tsx "the Candidates page"
  needF "CollectionCommandHost" $PAGES/CandidatesPage.tsx "on the shared command composer"
  for h in "'Candidate'" "'Opening'" "'Stage'" "'Next interview'" "'Last result'"; do needF "header: $h" $PAGES/CandidatesPage.tsx "column $h"; done
  needF "{ tenant: 'interviews', path: '/interviews/candidates' }" portal/e2e/route-inventory.ts "a table route in the inventory"
  needF "'my-openings'," portal/e2e/ui-dom-audit.policies.ts "a DOM audit route"
  needF '"journey:interviews"' portal/package.json "npm run journey:interviews"
  if [ "$QUICK" -eq 0 ]; then
    if ( cd portal && node --test src/lib/__tests__/interviews.test.ts ) >"$LOGS/portal-interviews.log" 2>&1; then ok "portal interviews words and order: $(grep -E '^ℹ pass' "$LOGS/portal-interviews.log")"; else fail "portal interviews test (see $LOGS/portal-interviews.log)"; fi
    run_journey
    for s in I0.5a I0.5b I0.5c I0.5d I0.5e I0.5f I0.5g I1.1 I1.1b I1.1c I1.1d I1.1e; do journey_step "$s"; done
  fi
}

built_row I1.1 row_I1.1
