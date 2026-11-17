# Row I1.5, a date-and-time field; the time on an interview; Upcoming. Sourced by scripts/validate-interviews.sh.

row_I1.5() {
  exists $PAGES/UpcomingPage.tsx "the Upcoming page"
  needF "assignmentsRouter.put('/interviews/:id/time', assign," $MW/routes/interviews/assignments.ts "the time route is the recruiter's action"
  needF "export function checkTime(" $MW/lib/interviews/assign.ts "checkTime: whole minute, in the future, only before the call"
  needF "DateTimeField" $PAGES/UpcomingPage.tsx "the library's date-and-time field sets the time"
  needF "'/interviews/upcoming'," portal/src/components/shell/Layout.tsx "an Upcoming row in the nav"
  needF "requireRoles: ['recruiter', 'admin']" portal/src/components/shell/Layout.tsx "for the recruiter"
  for h in "'Candidate'" "'Opening and round'" "'Lead and panel'" "'Time and invite link'"; do needF "header: $h" $PAGES/UpcomingPage.tsx "Upcoming column $h"; done
  needF "withConsent ? 'State and consent' : 'State'" $PAGES/UpcomingPage.tsx "the State and consent column"
  for id in interviews-upcoming-table interviews-upcoming-editor interviews-upcoming-time-field interviews-upcoming-actions interviews-upcoming-saved interviews-upcoming-live; do
    if grep -qF "$id" $PAGES/UpcomingPage.tsx; then ok "test id $id"; else fail "test id $id is gone from Upcoming"; fi
  done
  if has "<(Modal|Dialog|ConfirmDialog)[ >]" $PAGES/UpcomingPage.tsx; then fail "a modal on Upcoming"; else ok "no modal on Upcoming (the time is confirmed in the composer's deck)"; fi
  # The discipline judge: no button in a cell on Upcoming; its one stacked cell sits under its burn-down row, with an owner and a date.
  if python3 scripts/count-layout-drift.py portal/src --list 2>/dev/null | awk '/^cellbutton [0-9]+$/ {on=1; next} /^[a-z]+ [0-9]+$/ {on=0; next} on' | grep -q "UpcomingPage"; then fail "a text button in an Upcoming cell"; else ok "no text button in an Upcoming cell"; fi
  if awk -F'\t' '!/^#/ && $1=="stackedcell" && $2=="portal/src/pages/interviews/UpcomingPage.tsx" && $3>=1 && $4!="" && $5 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ {f=1} END {exit !f}' scripts/layout-drift-burndown.tsv; then ok "Upcoming's stacked cell (State and consent) is under its burn-down row, with an owner and a due date"; else fail "Upcoming's stacked cell has no burn-down row"; fi
  refuses_404 I1.5
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the time rules and the time route" src/lib/interviews/__tests__/assign.test.ts src/routes/__tests__/interviews-assignments.test.ts -t "time|Time"
    run_journey
    for s in I1.5a I1.5b I1.5c I1.5d; do journey_step "$s"; done
  fi
}

built_row I1.5 row_I1.5
