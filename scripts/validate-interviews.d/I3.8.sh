# Row I3.8: the candidate's two fixed requests (lane H8). Sourced by scripts/validate-interviews.sh. The detector and held-
# answer suites (speak.test.ts, policy-held.test.ts, detector-limits.test.ts under lib/interviews/speak) are the I3 floor;
# this piece adds the guest route's suite and the static guard that no model caller is reachable from the route.
row_I3_8() {
  local G=$MW/routes/interview-invite-milo.ts S=$MW/lib/interviews/speak/index.ts
  needF "miloGuestRouter.post('/milo/request', interviewsFlagGate, requireGuest()" "$G" "the request route, behind the guest gate"
  needF "admissionOf(invite).state !== 'admitted' || interview.state !== 'live'" "$G" "the admitted guest of a live interview only"
  # No model caller: the route imports nothing but the guest gate, the stores and the held-text speech.
  local imports; imports=$(grep -E "^import" "$G" | grep -vE "'express'|async-handler|invite/admission|invite/guest|invite/realtime|invite/store|store-select|speak/index|interviews/clock|'\./interviews\.js'" || true)
  if [ -z "$imports" ]; then ok "the route imports no model caller"; else fail "the route imports more than held text: $(echo "$imports" | head -1)"; fi
  local model; model=$(grep -nE "openai|bedrock|BedrockRuntime|coach|milo-notes|\.suggest\(|InvokeModel|Converse" "$S" | grep -vE '^\s*[0-9]+:\s*(//|/?\*)' | grep -v "kind: 'question'" || true)
  if [ -z "$model" ]; then ok "the held-text speech calls no model"; else fail "the speech names a model caller: $(echo "$model" | head -1 | cut -c1-140)"; fi
  needF "answerFromHeldText: async (call, request)" "$MW/lib/interviews/milo-policy.ts" "a spoken request is answered from held text"
  exists "$MW/lib/interviews/speak/__tests__/detector-limits.test.ts" "the detector's limits (O-224)"
  exists "$MW/routes/__tests__/interviews-invite-milo.test.ts" "the request route under pressure (O-223)"
  refuses_404 I3.8
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the candidate's request route under pressure" src/routes/__tests__/interviews-invite-milo.test.ts
    run_journey
    for s in a b c d e; do journey_step "I3.8$s"; done
  fi
}
built_row I3.8 row_I3_8
