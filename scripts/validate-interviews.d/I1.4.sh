# Row I1.4, assign a round; the bell; My interviews; accept or decline. Sourced by scripts/validate-interviews.sh.

row_I1.4() {
  # The routes, mounted once and gated on the right actions.
  exists $MW/routes/interviews/assignments.ts "the assignment routes"
  want_count "^interviewsRouter\.use\(assignmentsRouter\)" $MW/routes/interviews.ts 1 "mounted with one line"
  needF "const assign = requireAction('AssignInterviews');" $MW/routes/interviews/assignments.ts "assigning, reassigning and the time are the recruiter's action"
  needF "const conduct = requireAction('ConductInterview');" $MW/routes/interviews/assignments.ts "answering a seat and the panel's notice are the interviewer's action"
  want_count "^assignmentsRouter\.(get|post|put)\('[^']+', (assign|conduct)," $MW/routes/interviews/assignments.ts 7 "every assignment route gated on one of them"
  # The panel-notice read is declared above the /interviews/:id read, so its path is never taken for an id.
  needF "assignmentsRouter.get('/interviews/panel-notice'" $MW/routes/interviews/assignments.ts "the panel's notice status route"
  if [ "$(grep -n "interviewsRouter.use(assignmentsRouter)" $MW/routes/interviews.ts | cut -d: -f1)" -lt "$(grep -n "interviewsRouter.get('/interviews/:id'" $MW/routes/interviews.ts | cut -d: -f1)" ]; then ok "the assignment routes are mounted above the /interviews/:id read"; else fail "the assignment routes must come before /interviews/:id"; fi
  # The nav slot and the page anchors a lane fills.
  needF "// slot 3: a lane adds its entries just below this line" portal/src/components/shell/Layout.tsx "the nav's slot 3 anchor is still there"
  needF "label: 'My interviews'" portal/src/components/shell/Layout.tsx "My interviews in the nav, under Interview"
  needF "requireRoles: ['interviewer', 'admin']" portal/src/components/shell/Layout.tsx "for the interviewer"
  for p in AssignRoundPage MyInterviewsPage; do exists $PAGES/$p.tsx "the $p page"; done
  for id in interviews-profile-assign interviews-profile-reassign interviews-assign-form interviews-assign-lead interviews-assign-submit interviews-desk-accept interviews-desk-decline; do
    if grep -rqF "$id" $PAGES; then ok "test id $id"; else fail "test id $id is gone from the pages"; fi
  done
  # The panel's notice at Accept, in the page's own prompt deck, and no modal on My interviews.
  needF "needsNotice" $PAGES/MyInterviewsPage.tsx "My interviews opens the notice when the server asks for it"
  if has "<(Modal|Dialog|ConfirmDialog)[ >]" $PAGES/MyInterviewsPage.tsx; then fail "a modal on My interviews"; else ok "no modal on My interviews"; fi
  # Bells say the opening and the round and nothing about the candidate; the decline bell opens the round by an id that is not a name.
  needF "/interviews/rounds/\${encodeURIComponent(ev.interviewId)}" $MW/lib/social-notify.ts "the decline bell links by the interview's id"
  if grep -n "export async function notifyInterview\(Seated\|Declined\|Timed\)" -A30 $MW/lib/social-notify.ts | grep -qiE "candidate\.|candidateName|\.name"; then fail "an assignment bell reads a candidate's name"; else ok "no assignment bell reads the candidate"; fi
  needF "export function interviewIdFor(" $MW/lib/interviews/assign.ts "a round's id comes from interviewIdFor (random, no name in it)"
  if grep -n "export function interviewIdFor" -A8 $MW/lib/interviews/assign.ts | grep -qiE "name|slug|candidate"; then fail "interviewIdFor builds an id from a name"; else ok "interviewIdFor builds no id from a name"; fi
  refuses_404 I1.4
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "assignment checks, the routes, the notice and the bells" \
      src/lib/interviews/__tests__/assign.test.ts src/routes/__tests__/interviews-assignments.test.ts src/lib/interviews/consent
    if ( cd portal && node --test src/lib/__tests__/interviewsAssign.test.ts ) >"$LOGS/portal-interviews-assign.log" 2>&1; then ok "portal assign helpers: $(grep -E '^ℹ pass' "$LOGS/portal-interviews-assign.log")"; else fail "portal assign helpers (see $LOGS/portal-interviews-assign.log)"; fi
    run_journey
    for s in I1.4a I1.4b I1.4c I1.4d I1.4e I1.4f I1.4g I1.4h; do journey_step "$s"; done
  fi
}

built_row I1.4 row_I1.4
