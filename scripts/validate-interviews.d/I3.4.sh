# Row I3.4: the suggestion as the footer's prompt, and the candidate's side of Milo (decisions 4, 9, 20; contracts D7, E9).
# Sourced by scripts/validate-interviews.sh. E9 is held twice: the guest filter's unit suite (a phase I2 floor suite) and
# the walk's I3.4e/I3.4f, which read the candidate's history and the frames their page received in a live call.
row_I3_4() {
  local F=portal/src/components/shell/InterviewRoomFooter.tsx
  needF "<ComposerPromptDeck deck={deck} presentation=\"prompt\"" "$F" "the suggestion is a ComposerPromptDeck prompt"
  if grep -q 'style={{' "$F"; then fail "the footer prompt has an inline style ($F)"; else ok "the footer prompt has no inline style"; fi
  needF "export function guestMaySee" "$MW/lib/call-chat.ts" "the guest's chat filter (E9)"
  exists "$MW/lib/__tests__/call-chat-guest.real-gateway.test.ts" "the guest's history and frames against a real gateway (O-133; gated, not run here)"
  needF "the footer builds a suggestion prompt only for the lead" portal/src/lib/__tests__/interviewsRoom.test.ts "the footer skips a registration that is not the lead's (O-115)"
  needF "the suggestion poll reads again on the server" portal/src/lib/__tests__/interviewsRoom.test.ts "the poll is bounded (O-114)"
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g h i; do journey_step "I3.4$s"; done
  fi
}
built_row I3.4 row_I3_4
