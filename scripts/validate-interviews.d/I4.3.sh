# Row I4.3: the pad log (lane H8). Sourced by scripts/validate-interviews.sh. The rules, store and route suites are the I4
# floor (src/lib/interviews/pad, src/routes/__tests__/interviews-pad.test.ts); this piece adds the body-limit suite, which
# boots the real app's order.
row_I4_3() {
  local R=$MW/routes/interviews/pad.ts G=$MW/routes/interview-invite-pad.ts
  needF "padRouter.post('/interviews/:id/pad/events'" "$R" "the seats' post"
  needF "padRouter.get('/interviews/:id/pad/log'" "$R" "the panel's read"
  needF "padGuestRouter.post('/pad/events', interviewsFlagGate, requireGuest()" "$G" "the candidate's post, behind the guest gate"
  if grep -qE "padGuestRouter\.get\(" "$G"; then fail "the candidate has a read of the pad log"; else ok "the candidate has no read of the pad log"; fi
  needF "a paste by the candidate shows as an event on the panel\\'s read (the row\\'s judge line)" "$MW/routes/__tests__/interviews-pad.test.ts" "the route suite holds the row's judge line"
  exists "$MW/routes/__tests__/interviews-pad-limits.test.ts" "the body-limit suite (O-243)"
  refuses_404 I4.3
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the pad log's body limits through the app" src/routes/__tests__/interviews-pad-limits.test.ts
    run_journey
    for s in a b c; do journey_step "I4.3$s"; done
  fi
}
built_row I4.3 row_I4_3
