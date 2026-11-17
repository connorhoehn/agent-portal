# Row I4.2: the pad in the room (lane H8). Sourced by scripts/validate-interviews.sh. The pad-proof suite is the I4 floor
# (phase_suites: src/lib/interviews/pad), so it is not repeated here. The pad has no HTTP route of its own (the gateway
# carries it), so the row has no .404 table; its refusals are pad-proof's (O-229) and the pad log's table (I4.3).
row_I4_2() {
  local CH=$MW/lib/interviews/pad/channel.ts PP=$MW/lib/interviews/pad/__tests__/pad-proof.test.ts
  exists "$PP" "the pad-proof suite"
  needF "the admitted candidate types into their own pad beside the lead, and both converge" "$PP" "pad-proof: the candidate's seat converges beside the lead"
  needF "export const PAD_DOCUMENT_PREFIX = 'ivpad:';" "$CH" "the pad's document is ivpad:<id>"
  needF 'return id ? `${DOC}${id}` : null;' "$CH" "the pad's channel is doc:ivpad:<id>"
  needF "{ id: 'interview-pad', match: base => inDocumentNamespace(base), channel: args => admitPadChannel(args, args.base) }" "$MW/lib/gateway/authority.ts" "every doc: name on the BFF gateway is decided by the pad's authority"
  # On the interviews side the pad's channel is the only doc: name (the portal's other doc: names are assessment's, on its own gateway).
  local other; other=$(grep -rnE '`doc:|'"'"'doc:' portal/src/pages/interviews portal/src/pages/join portal/src/lib/interviews*.ts 2>/dev/null | grep -v __tests__ | grep -v 'lib/interviewsPad.ts' || true)
  if [ -z "$other" ]; then ok "no other doc: name on the interviews pages"; else fail "another doc: name on the interviews pages: $(echo "$other" | head -1 | cut -c1-120)"; fi
  local sock; sock=$(grep -rlE 'new WebSocket|socket\.io|io\(' portal/src/pages/interviews/pad portal/src/lib/interviewsPad.ts 2>/dev/null || true)
  if [ -z "$sock" ]; then ok "the pad opens no socket of its own"; else fail "the pad opens a socket ($sock)"; fi
  # @connorhoehn/ui-components/code-pad: the pad (which the candidate's pane mounts through RunnablePad) and the record page only.
  local users bad=""; users=$(grep -rl "@connorhoehn/ui-components/code-pad" portal/src | grep -v __tests__ | sort)
  for f in $users; do
    case "$f" in portal/src/pages/interviews/pad/*|portal/src/pages/interviews/InterviewRecordPage.tsx|portal/src/lib/interviewsPlayback.ts) ;; *) bad="$bad $f" ;; esac
  done
  if [ -z "$bad" ]; then ok "code-pad is imported only by the pad and the record page ($(echo "$users" | wc -l | tr -d ' ') files)"; else fail "code-pad imported elsewhere:$bad"; fi
  needF "GuestRoomPane" "portal/src/pages/join/JoinRoom.tsx" "the candidate's pane is the room's one pane"
  needF "RunnablePad" "portal/src/pages/join/GuestRoomPane.tsx" "the candidate's pane mounts the same pad"
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g h; do journey_step "I4.2$s"; done
  fi
}
built_row I4.2 row_I4_2
