# Row I3.2: the interviews policy for Milo (lib/interviews/milo-policy.ts; decisions 4, 9, 20). Sourced by
# scripts/validate-interviews.sh. The table holds the refusals a fixed id can name (a guest cookie and no session on the
# Work assistant's routes and the meetings list); the walk's I3.2 steps hold what needs the interview's own call record,
# whose id exists only once the call starts (the lead's invite, the panel's lead-only sentence, the recruiter's and the
# hiring manager's reads afterwards, another round's interviewer, a Work session on it and the reverse, the guest cookie).
row_I3_2() {
  local P=$MW/lib/interviews/milo-policy.ts
  needF "export const LEAD_ONLY = 'Only the lead interviewer of this interview can invite Milo, turn its voice on or add time.'" "$P" "the lead-only sentence"
  needF "listeningLimitMinutes" "$P" "the listening limit (the round's minutes plus 15)"
  needF "export function lobbyAgrees" "$MW/routes/meeting-assistant.ts" "Work's calls for Work, an interview's for the interviews tenant"
  exists "$MW/lib/interviews/__tests__/milo-policy.H3.test.ts" "the H3 policy edges (O-099, O-101, O-103)"
  needF "O-100: the gateway" "$MW/routes/__tests__/meeting-assistant-interviews.test.ts" "a Work user refused an interview lobby (O-100)"
  needF "O-103: the lead" "$MW/routes/__tests__/meeting-assistant-interviews.test.ts" "the extend past the limit refused in words (O-103)"
  refuses_404 I3.2
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the H3 policy edges" src/lib/interviews/__tests__/milo-policy.H3.test.ts
    run_journey
    for s in a b c d e f g; do journey_step "I3.2$s"; done
  fi
}
built_row I3.2 row_I3_2
