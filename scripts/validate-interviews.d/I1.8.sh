# Row I1.8, behavioural rounds. Sourced by scripts/validate-interviews.sh.

row_I1.8() {
  exists $MW/mock/interviews-behavioural.ts "the behavioural kit's fixture"
  want_count "from './interviews-behavioural.js'" $MW/mock/interviews.ts 1 "read by the seed with one import"
  needF "type: 'behavioural'" $MW/mock/interviews-behavioural.ts "a behavioural round"
  if has "starter:" $MW/mock/interviews-behavioural.ts; then fail "starter code in the behavioural kit"; else ok "no starter code in the behavioural kit"; fi
  needF "export function roundHasPad(" $MW/lib/interviews/kit.ts "a behavioural round has no code pad (roundHasPad)"
  needF "which has no code pad, so it cannot carry starter code" $MW/lib/interviews/kit.ts "starter code on a behavioural question refused"
  needF "has no code pad, so this question carries no starter code" $PAGES/KitEditor.tsx "the editor offers no starter code on a behavioural question"
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "kit tests (behavioural rounds)" src/lib/interviews/__tests__/kit.test.ts -t "behavioural|starter code"
    run_journey
    for s in I1.8a I1.8b; do journey_step "$s"; done
  fi
}

built_row I1.8 row_I1.8
