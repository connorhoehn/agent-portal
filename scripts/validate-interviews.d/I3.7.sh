# Row I3.7: the live transcript, the panel's side only (decisions 4 and 21; contract E5). Sourced by
# scripts/validate-interviews.sh. The table: the lead, the panel, the recruiter and the opening's hiring manager read a live
# round's transcript; the guest and everyone else do not; nobody reads a round that is not live.
row_I3_7() {
  needF "miloRouter.get('/interviews/:id/transcript'" "$MW/routes/interviews/milo.ts" "the transcript read"
  needF "data-testid=\"interview-room-transcript\"" portal/src/pages/interviews/InterviewRoomPage.tsx "the transcript in the room's Milo tab"
  refuses_404 I3.7
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d; do journey_step "I3.7$s"; done
  fi
}
built_row I3.7 row_I3_7
