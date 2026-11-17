# Row I0.7 of scripts/validate-interviews.sh: the spike on how the code pad is
# carried and how a guest gets a seat (docs/interviews-tenant-plan.md, "I0.7 answer").
# Sourced by the judge, which supplies ok/fail/needF/exists/jest_ok, QUICK and MW,
# and runs from the repository root.
row_I0_7() {
  local PLAN=docs/interviews-tenant-plan.md PAD=$MW/lib/interviews/pad
  needF '## I0.7 answer' "$PLAN" "the plan has the I0.7 answer"
  for part in "### The pad's shared text" "### The guest's seat" "### Recordings in the mock world"; do
    needF "$part" "$PLAN" "the answer covers: ${part#\#\#\# }"
  done
  needF 'Decision: the middleware' "$PLAN" "the answer names its carrier"
  needF 'Rows changed:' "$PLAN" "the answer lists the rows it changes"
  for f in channel.ts authority.ts feature.ts __tests__/pad-proof.test.ts; do exists "$PAD/$f" "pad/$f"; done
  needF 'interviewPads(),' "$MW/lib/realtime-gateway.ts" "the pad feature rides the middleware's gateway"
  needF 'admitPadChannel(args, args.base)' "$MW/lib/gateway/authority.ts" "the authority facade sends doc: names to the pad's rule"
  [ "$QUICK" -eq 1 ] || jest_ok "the pad proof: two people converge, everyone else refused" src/lib/interviews/pad
}
