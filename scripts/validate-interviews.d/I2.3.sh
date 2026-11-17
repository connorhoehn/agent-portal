# Row I2.3: the candidate's pages before the call (landing, notice and consents, device check, waiting room). Sourced by
# scripts/validate-interviews.sh. The candidate's pages are built from the library only.
row_I2_3() {
  local J=portal/src/pages/join f
  for f in ConsentStep DeviceCheckStep WaitingStep HeldStep GuestFrame; do exists "$J/$f.tsx" "join/$f.tsx"; done
  want_count 'style=\{\{' "$J/../JoinPage.tsx" 0 "JoinPage.tsx has no inline style"
  for f in "$J"/*.tsx; do
    if grep -qE 'style=\{\{|<(div|span|p|h[1-6]|button|input)[ >]' "$f"; then fail "$(basename "$f") hand-rolls markup or inline style"; fi
  done
  ok "the candidate's pages draw no raw div, span, p, heading, button or input and no inline style"
  needF "'Invitation', 'Your answers', 'Camera and microphone', 'Waiting'" "$J/steps.ts" "the strip's four walked steps"
  exists portal/src/pages/join/__tests__/steps.test.ts "the steps' unit test"
  needF 'data-testid="join-consents-back"' "$J/ConsentStep.tsx" "a refused change offers Back to waiting on the stored answers"
  refuses_404 I2.3
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f; do journey_step "I2.3$s"; done
  fi
}
built_row I2.3 row_I2_3
