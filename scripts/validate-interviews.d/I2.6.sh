# Row I2.6 (this repository's half; platform-api's lines are H6's): D3, who may list or play an interview's recording.
# Sourced by scripts/validate-interviews.sh. D2 and D3 are asked with a bearer, so the per-role table is walk step I2.6a
# (each person's own realtime token); the .404 table holds the cookie half (no bearer, 401).
row_I2_6() {
  local RR=$MW/lib/interviews/recording-rules.ts
  needF "export async function decideRecordingAccess" "$RR" "D3's loader"
  needF "realtimeLobbyAccessRouter.post('/recording-access'" "$MW/routes/realtime-lobby-access.ts" "D3's route"
  needF "never a guest (its own interview" "$MW/routes/__tests__/realtime-lobby-access-interviews.test.ts" "D3's route test refuses every guest"
  refuses_404 I2.6
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    journey_step I2.6a
  fi
}
built_row I2.6 row_I2_6
