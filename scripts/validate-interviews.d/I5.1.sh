# Row I5.1, the interview record (hardening lane H4). Sourced by scripts/validate-interviews.sh.

# Does the handler that starts at a line matching $2 (and runs to its closing "}));") contain the literal $3?
h4_in_block() { awk -v s="$2" '$0 ~ s { on = 1 } on { print } on && /^}\)\);/ { exit }' "$1" | grep -qF -- "$3"; }

row_I5.1() {
  local route=$MW/routes/interviews/record.ts page=$PAGES/InterviewRecordPage.tsx
  exists $route "the record route"
  exists $page "the record page"
  if h4_in_block $route "recordRouter.get.'/interviews/:id/record'" "res.setHeader('Cache-Control', 'no-store');"; then ok "the record is answered with Cache-Control no-store"; else fail "the record route does not set no-store"; fi
  if h4_in_block $MW/routes/interviews/pad.ts "padRouter.get.'/interviews/:id/pad/log'" "res.setHeader('Cache-Control', 'no-store');"; then ok "the pad log's read is answered with no-store"; else fail "the pad log's read does not set no-store"; fi
  needF "session.role === 'admin' || isGuestId(session.sub)" $route "no admin exception and no guest: both are the tenant's not-found"
  needF "!RECORD_STATES.includes(interview.state)" $route "only a round that has ended has a record"
  needF "RECORD_STATES.includes(p.interview.state)" $MW/routes/interviews/pad.ts "the pad log's read follows the record's rule once the round has ended (and while it is live)"
  for f in $route $MW/lib/interviews/record/*.ts; do
    if grep -n "console\\." "$f" >/dev/null; then fail "a log line in $f (nothing of the record reaches one)"; else ok "no log line in ${f#middleware/src/}"; fi
  done
  needF "hideDownload" $page "the recording has no download control"
  if grep -n "ownload" $page | grep -vE "hideDownload|^[0-9]+:\\s*(//|/?\\*)" >/dev/null; then fail "a download in the record page"; else ok "nothing to download or share on the record page"; fi
  if grep -n "style={{" $page >/dev/null; then fail "inline styles on the record page"; else ok "no inline styles on the record page"; fi
  needF "CodePlayback" $page "the code plays back on the record page"
  needF "TranscriptPanel" $page "the transcript is the library's panel"
  needF "mergeCloseMarkers" $page "close markers of one kind are one marker"
  needF "'record'" portal/e2e/ui-dom-audit.policies.ts "the record is a DOM audit route" || true
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the pad log's route (read after the end)" src/routes/__tests__/interviews-pad.test.ts
    if ( cd portal && node --test src/lib/__tests__/interviewsRecord.test.ts src/lib/__tests__/interviewsPlayback.test.ts ) >"$LOGS/portal-interviews-record.log" 2>&1; then ok "portal record and playback helpers: $(grep -E '^ℹ pass' "$LOGS/portal-interviews-record.log")"; else fail "portal record and playback helpers (see $LOGS/portal-interviews-record.log)"; fi
    refuses_404 I5.1
    run_journey
    for s in I5.1a I5.1b I5.1c I5.1d I5.1e I5.1f I5.1g I5.1h I5.1i; do journey_step "$s"; done
  else
    refuses_404 I5.1
  fi
}

built_row I5.1 row_I5.1
