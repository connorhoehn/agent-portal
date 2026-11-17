# Row I3.5: Milo asks aloud (lane H8). Sourced by scripts/validate-interviews.sh. The three suites (approved-speech,
# live-session-say, speak) are the I3 floor; this piece adds the say route's own suite. Decision 9 as static checks: the
# interviews speech is the meeting assistant's own session, relay and gate, with no second provider and no bespoke bar.
row_I3_5() {
  local S=$MW/lib/interviews/speak/index.ts M=$MW/routes/interviews/milo.ts
  needF "miloRouter.post('/interviews/:id/say'" "$M" "the say route"
  needF "const { said } = await sayApproved(interview, { kind: 'question', source: 'kit', text: question.prompt.trim()" "$M" "the words are the kit's, read from the store, never the body"
  needF "peekAssistantRuntime()?.sayHeldText(callId, text, by)" "$S" "said through the running meeting assistant's own session (no second runtime)"
  needF "async sayHeldText(callId: string, text: string, by: string)" "$MW/lib/meeting-assistant/orchestrator.ts" "the meeting assistant's one approved-speech path"
  needF "relaysLiveSpeech: () => false," "$MW/lib/interviews/milo-policy.ts" "nothing the live model says on its own is relayed in an interview"
  local prov; prov=$(grep -rlE "openai|bedrock|BedrockRuntime|new WebSocket|session-select|realtime-session" "$MW/lib/interviews/speak" "$M" 2>/dev/null | grep -v __tests__ || true)
  if [ -z "$prov" ]; then ok "no second provider in the interviews speech"; else fail "a provider reached from the interviews speech: $prov"; fi
  local bar; bar=$(grep -rlE "AudioContext|new Audio\(|useAssistantVoice" portal/src/pages/interviews portal/src/components/shell/InterviewRoomFooter.tsx 2>/dev/null | grep -v __tests__ || true)
  if [ -z "$bar" ]; then ok "no bespoke voice bar in the interview room (the shell footer's Milo bar is the one)"; else fail "a bespoke voice player in the room: $bar"; fi
  needF "useAssistantVoice" "portal/src/pages/join/GuestMiloVoice.tsx" "the candidate hears Milo through the same voice player as Work"
  exists "$MW/routes/__tests__/interviews-say.test.ts" "the say route's suite (O-221)"
  refuses_404 I3.5
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the say route under pressure" src/routes/__tests__/interviews-say.test.ts
    run_journey
    for s in a b c d e f g; do journey_step "I3.5$s"; done
  fi
}
built_row I3.5 row_I3_5
