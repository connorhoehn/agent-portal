# Row I3.1: a policy seam in the meeting assistant (lib/meeting-assistant/policy.ts). Sourced by scripts/validate-interviews.sh,
# which defines ok/fail/needF/exists/jest_ok, $MW and $QUICK. Registering it is the integrator's (the judge's piece loading).
row_I3_1() {
  local P=$MW/lib/meeting-assistant/policy.ts
  exists "$P" "lib/meeting-assistant/policy.ts"
  needF "export interface MeetingAssistantPolicy" "$P" "the MeetingAssistantPolicy interface"
  needF "export const DEFAULT_POLICY" "$P" "the default policy (today's behaviour)"
  needF "export function registerMeetingAssistantPolicy" "$P" "the registry, by lobby family"
  for f in inviteRefusal reads payer sessionTools mayUseTool acknowledgement acknowledgedElsewhere rings listsMeeting relaysLiveSpeech answerFromHeldText; do
    needF "  $f" "$P" "the interface answers $f"
  done
  exists "$MW/lib/meeting-assistant/__tests__/policy.test.ts" "registry and default-table test"
  needF "resolves the default for every existing family" "$MW/lib/meeting-assistant/__tests__/policy.test.ts" "the registry test resolves the default for every existing family"
  exists "$MW/routes/__tests__/meeting-assistant-policy.test.ts" "stub-policy route test"
  for w in "can refuse an invite" "can narrow the readers" "can switch the payer" "can empty the tools"; do
    needF "$w" "$MW/routes/__tests__/meeting-assistant-policy.test.ts" "route test: a stub policy $w"
  done
  [ "$QUICK" -eq 1 ] || jest_ok "the meeting assistant's suites" src/lib/meeting-assistant src/routes/__tests__/meeting-assistant
}
