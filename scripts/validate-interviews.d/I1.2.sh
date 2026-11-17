# Row I1.2, the candidate profile. Sourced by scripts/validate-interviews.sh.

row_I1.2() {
  exists $PAGES/CandidateProfilePage.tsx "the candidate profile page"
  needF "WorkflowStepper" $PAGES/CandidateProfilePage.tsx "the stage tracker from the library"
  needF "interviews-profile-rounds" $PAGES/CandidateProfilePage.tsx "the rounds table"
  needF "RecordNotFound" $PAGES/CandidateProfilePage.tsx "the usual not-found page for a candidate out of scope"
  needF "candidateHref" $PAGES/CandidatesPage.tsx "Candidates names link to the profile"
  needF "candidateHref" $PAGES/MyOpeningsPage.tsx "My openings names link to the profile"
  needF "candidateHref" $PAGES/MyInterviewsPage.tsx "My interviews names link to the profile"
  needF 'path="candidates/:id"' portal/src/App.tsx "the profile route"
  if grep -n "style={{" $PAGES/CandidateProfilePage.tsx >/dev/null; then fail "the profile page has inline styles"; else ok "the profile page has no inline styles"; fi
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in I1.2a I1.2b I1.2c I1.2d; do journey_step "$s"; done
  fi
}

built_row I1.2 row_I1.2
