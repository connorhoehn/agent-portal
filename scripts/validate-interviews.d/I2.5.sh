# Row I2.5: declined consent (decision 5). Sourced by scripts/validate-interviews.sh. The eight answer combinations are
# judged against D2 in the walk (step I2.5c: each candidate asks D2 with their own token once let in). The held page
# (I2.5b, row I6.4) runs only when the walk's environment sets INTERVIEWS_REQUIRED_CONSENTS: it is not judged here.
row_I2_5() {
  needF "consentEffectsRouter.get('/consent-effects'" "$MW/routes/interviews/consent-effects.ts" "the consent-effects route"
  needF "export function consentColumnLabel" portal/src/lib/interviewsUpcoming.ts "Upcoming's consent column"
  needF "runs with" "$MW/lib/social-notify.ts" "the recruiter's bell"
  exists "$MW/routes/__tests__/interviews-declined.H2.test.ts" "the H2 edge file for the bell (O-081, O-082)"
  exists "$MW/routes/__tests__/realtime-lobby-access-interviews.H2.test.ts" "the H2 edge file for D2 with a store down (O-083)"
  refuses_404 I2.5
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the H2 declined and D2 edge suites" src/routes/__tests__/interviews-declined.H2.test.ts src/routes/__tests__/realtime-lobby-access-interviews.H2.test.ts
    run_journey
    journey_step I2.5a; journey_step I2.5c
  fi
}
built_row I2.5 row_I2_5
