# Row I6.1, consent records and notice versions on the profile. Sourced by scripts/validate-interviews.sh.
# The phase's floor (phase_suites I6) runs interviews-records.test.ts; this piece runs the portal's own test.

row_I6.1() {
  needF "recordsRouter.get('/candidates/:id/consents'" $MW/routes/interviews/records.ts "the consents route"
  needF "ANSWER_READERS" $MW/routes/interviews/records.ts "only the recruiter and the admin read the answers"
  needF "res.setHeader('Cache-Control', 'no-store')" $MW/routes/interviews/records.ts "the consents are never cached"
  exists portal/src/pages/interviews/ProfileConsents.tsx "the Consents section"
  needF "ProfileConsents" $PAGES/CandidateProfilePage.tsx "Consents sit on the profile"
  needF "readsConsents(role)" $PAGES/CandidateProfilePage.tsx "an interviewer's profile has no Consents section"
  needF "{ id: 'activity', label: 'Activity' }" $PAGES/CandidateProfilePage.tsx "the profile's Activity tab (a64c703f)"
  if grep -n "style={{" portal/src/pages/interviews/ProfileConsents.tsx >/dev/null; then fail "the Consents section has inline styles"; else ok "the Consents section has no inline styles"; fi
  # A consent answer reaches no scorecard and no debrief (decision 5).
  if grep -nE "consentStore|getConsent" $MW/lib/interviews/debrief/*.ts $MW/lib/interviews/scorecard.ts $MW/routes/interviews/debrief.ts $MW/routes/interviews/scorecards.ts >/dev/null 2>&1; then
    fail "a scorecard or the debrief reads the consent answers"
  else ok "no scorecard or debrief reads the consent answers"; fi
  refuses_404 I6.1
  if [ "$QUICK" -eq 0 ]; then
    local log="$LOGS/portal-interviewsRecords.log"
    ( cd portal && node --test src/lib/__tests__/interviewsRecords.test.ts ) >"$log" 2>&1
    if [ $? -eq 0 ]; then ok "portal interviewsRecords.test.ts: $(grep -E 'ℹ pass' "$log" | tail -1)"; else fail "portal interviewsRecords.test.ts (see $log)"; fi
    run_journey
    for s in I6.1a I6.1b I6.1c; do journey_step "$s"; done
  fi
}

built_row I6.1 row_I6.1
