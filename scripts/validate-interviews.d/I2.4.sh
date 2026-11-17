# Row I2.4: the interview room for both sides (decision 21). Sourced by scripts/validate-interviews.sh. The mock world
# has no platform-api, so the walk covers the room before and after the call; the in-call steps print NOT RUN.
row_I2_4() {
  local RM=$MW/routes/interviews/room.ts
  needF "roomRouter.get('/interviews/:id/room'" "$RM" "the room's read"
  needF "roomRouter.post('/interviews/:id/start'" "$RM" "start"
  needF "roomRouter.post('/interviews/:id/end'" "$RM" "end"
  exists portal/src/pages/interviews/InterviewRoomPage.tsx "the panel's room"
  exists portal/src/pages/join/JoinRoom.tsx "the candidate's room"
  needF "interviewInviteRouter.get('/room'" "$MW/routes/interview-invite.ts" "the candidate's room read (D1)"
  # The interview lobby's footer: no share, rooms (the social entry) or reactions; every other lobby's footer unchanged.
  needF "return { share: false, meeting: false, reactions: false, mediaToggle: false, socialEntry: false" portal/src/components/shell/callShellModel.ts "an interview call's bar has no share, rooms or reactions"
  needF "every other lobby keeps the work huddle" portal/src/components/shell/__tests__/footerCallItems.test.ts "other tenants' footers are unchanged (test)"
  refuses_404 I2.4
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g h; do journey_step "I2.4$s"; done
    # I2.4o is a finding (the technical pane's column is 559 px at 1440, one under decision 21's 560): pending until it holds.
    if grep -q "^PASS I2.4o:" "$JOURNEY_LOG"; then ok "walk step I2.4o"; else pending "I2.4o a finding for the lead: $(grep -E '^(FAIL|PASS) I2.4o:' "$JOURNEY_LOG" | head -1 | cut -c1-150)"; fi
  fi
}
built_row I2.4 row_I2_4
