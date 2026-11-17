# Row I2.7: panel seats. Sourced by scripts/validate-interviews.sh. The server half is the table (a panel seat by
# state, on a behavioural round with a panel and on the live technical round); the walk holds the three-person room
# as far as the mock world draws it (no call without platform-api: "3 joined" and the tiles print NOT RUN).
row_I2_7() {
  needF "useInterviewRoomSeat" portal/src/components/shell/MeetingAssistantBar.tsx "the bar reads the seat: a panel member gets none of the lead's controls"
  needF "Waiting for the lead" portal/src/pages/interviews/InterviewRoomPage.tsx "a panel member before the lead reads Waiting for the lead"
  refuses_404 I2.7
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d; do journey_step "I2.7$s"; done
  fi
}
built_row I2.7 row_I2_7
