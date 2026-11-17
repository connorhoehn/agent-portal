# Row I2.2: the lobby family, admission, a guest seat, the channel guard. Sourced by scripts/validate-interviews.sh.
# The floor suites (phase_suites I2) run the lobby, admission and realtime suites and the lobby-access route suite.
row_I2_2() {
  needF "export const INTERVIEW_LOBBY_PREFIX = 'interviews:interview:'" "$MW/lib/interviews/lobby.ts" "the lobby family interviews:interview:<id>"
  exists "$MW/lib/interviews/invite/admission.ts" "admission (knock, admit, not yet)"
  exists "$MW/routes/interviews/admission.ts" "the lead's waiting and admit routes"
  needF "realtimeLobbyAccessRouter.post('/lobby-access'" "$MW/routes/realtime-lobby-access.ts" "the seat is asked at /lobby-access"
  exists "$MW/lib/interviews/invite/__tests__/realtime.H2.test.ts" "the H2 edge file for the seat (O-056, O-059 gated, O-060)"
  needF "a turn-away tells the verdict cache" "$MW/lib/interviews/invite/__tests__/realtime.H2.test.ts" "the verdict-cache finding is pinned (it.failing)"
  refuses_404 I2.2
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d; do journey_step "I2.2$s"; done
  fi
}
built_row I2.2 row_I2_2
