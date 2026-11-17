# Row I5.6, the bells: starting soon, assigned, and (H4's half) the result bells. Sourced by scripts/validate-interviews.sh.

row_I5.6() {
  exists $MW/lib/interviews/soon.ts "the starting-soon rules"
  exists $MW/lib/interviews/soon-sweep.ts "the starting-soon sweep"
  needF "export const SOON_MINUTES_SETTING = 'INTERVIEWS_SOON_MINUTES'" $MW/lib/interviews/soon.ts "the window is the deployment's setting"
  needF "export async function notifyInterviewStartingSoon" $MW/lib/social-notify.ts "the starting-soon bell"
  needF "export async function notifyInterviewSeated" $MW/lib/social-notify.ts "the assigned bell"
  # The bells say the round, the opening and the minutes, never the candidate.
  for fn in notifyInterviewStartingSoon notifyInterviewSeated notifyInterviewDeclined; do
    if grep -n "export async function $fn" -A30 $MW/lib/social-notify.ts | grep -qiE "candidate\.|candidateName|candidate\?\.|\.candidate"; then fail "$fn reads the candidate"; else ok "$fn reads no candidate"; fi
  done
  needF "href: '/interviews/my-interviews'" $MW/lib/social-notify.ts "the starting-soon bell opens My interviews"
  if declare -F row_I5_6_results >/dev/null; then row_I5_6_results; fi
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the starting-soon rules, the sweep and the bells" src/lib/interviews/__tests__/soon.test.ts src/routes/__tests__/interviews-assignments.test.ts
    run_journey
    for s in I5.6a I5.6b I5.6c I5.6d I5.6e; do journey_step "$s"; done
  fi
}

built_row I5.6 row_I5.6
