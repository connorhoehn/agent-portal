# Row I6.3, retention sweeps and deletion on request. Sourced by scripts/validate-interviews.sh.
# The phase's floor runs src/lib/interviews/retention (the sweep at 89/91 days and four years either side, an open interview
# untouched, the log, overdue and its bell, the said log's class, the meeting assistant leaving interview calls) and
# interviews-retention.test.ts (a second request changes nothing, reasons redacted, the overdue fields).

row_I6.3() {
  needF "retentionRouter.post('/candidates/:id/deletion', manage" $MW/routes/interviews/retention.ts "the deletion request, ManageCandidates"
  needF "retentionRouter.get('/candidates/:id/deletions'" $MW/routes/interviews/retention.ts "the deletion log"
  needF "overdue: isOverdue(r, nowMs)" $MW/routes/interviews/retention.ts "each log row says whether it is overdue"
  needF "ringOverdue" $MW/lib/interviews/retention/service.ts "the sweep rings the recruiter for a late request"
  needF "export const OPEN_STATES" $MW/lib/interviews/retention/rules.ts "open interviews have no period start"
  needF "export const REDACTED_REASON = 'Reason removed.'" $MW/lib/interviews/retention/rules.ts "stage reasons are replaced on a deletion"
  needF "keepsOwnRetention: true" $MW/lib/interviews/milo-policy.ts "the meeting assistant's age sweep skips interview calls"
  needF "registerEraser({ kind: 'said-log', class: 'record'" $MW/lib/interviews/retention/erasers.ts "the said log is a record"
  needF "registerEraser({ kind: 'pad-log', class: 'media'" $MW/lib/interviews/retention/erasers.ts "the pad log is media"
  needF "registerEraser({ kind: 'runs', class: 'media'" $MW/lib/interviews/retention/erasers.ts "the runs are media"
  needF "interviews-deletion-ask" $PAGES/CandidateProfilePage.tsx "the recruiter's way to ask, on the profile"
  needF "deletions.prompts" $PAGES/CandidateProfilePage.tsx "the delete prompt is in the page's dock"
  # The log names kinds and counts, never content or a person's details.
  if grep -nE "console\.(warn|info|log)\(.*(\\\$\{err|message|candidate\.name|email)" $MW/lib/interviews/retention/*.ts >/dev/null 2>&1; then
    fail "a retention log line carries an error message or a person's details"
  else ok "retention log lines name kinds only"; fi
  refuses_404 I6.3
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the said log's store" src/lib/interviews/speak/__tests__/speak.test.ts
    run_journey
    for s in I6.3a I6.3b I6.3c I6.3d I6.3e I6.3f I6.3g I6.3h; do journey_step "$s"; done
  fi
}

built_row I6.3 row_I6.3
