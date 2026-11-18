# Row E1: the whole journey in one pass (OWED O-282). Sourced by scripts/validate-interviews.sh. The walk piece
# scripts/journeys/interviews/E1.mjs is the story, technical round then behavioural round, as the real roles through the
# pages: add and assign, accept with the notice once, a plan, the link, consents and the knock, admitted, both type in the
# pad, one run both see, Milo's suggestion asked aloud, the candidate's time request, the end, the scorecard with the recap
# and a question, the record on one clock, then the behavioural round (no pad, Milo's notes), the debrief and the decision.
# Every step is a walk step judged here; none is pending. The call's media is stood in (lib.mjs standInCall).
row_E1() {
  local P=scripts/journeys/interviews/E1.mjs
  exists "$P" "the journey's walk piece"
  needF "export async function standInCall" "scripts/journeys/interviews/lib.mjs" "the call's stand-in is one shared helper in the harness"
  needF "standInCall" "scripts/journeys/interviews/h3-call.mjs" "the Milo pieces' calls use the shared stand-in"
  needF "standInCall" "scripts/journeys/interviews/h8-room.mjs" "the pad pieces' calls use the shared stand-in"
  needF "const STEPS = 'abcdefghijklmnopqrst'" "$P" "the walk names its twenty steps"
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g h i j k l m n o p q r s t; do journey_step "E1$s"; done
  fi
}
built_row E1 row_E1
