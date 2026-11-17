# Row I5.3, a rating input and the scorecard (hardening lane H4). Sourced by scripts/validate-interviews.sh.

row_I5.3() {
  local route=$MW/routes/interviews/scorecards.ts page=$PAGES/ScorecardPage.tsx
  exists $route "the scorecard routes"
  needF "const conduct = requireAction('ConductInterview');" $route "submitting is ConductInterview, so a recruiter and a hiring manager read and never submit"
  needF "othersRevealed" $route "the others' scorecards are shown only once the viewer's own is in"
  needF "const BODY_KEYS: ReadonlySet<string> = new Set(['ratings', 'recommendation', 'summary', 'reason', 'basedOn']);" $MW/lib/interviews/scorecard.ts "a scorecard carries no field naming its author: it is always the signed-in person"
  needF "ratingsAtRecap: await ratingsAtRecap(i.id, session.sub)" $route "changed-after-recap is the server's fact, from the ratings stored at the open"
  needF "res.setHeader('Cache-Control', 'no-store');" $route "the scorecard is never cached"
  needF "RatingInput" $page "the rating is the library's RatingInput"
  needF "ComposerPromptDeck" $page "submitting and correcting are asked in the prompt deck"
  if grep -n "style={{" $page >/dev/null; then fail "inline styles on the scorecard page"; else ok "no inline styles on the scorecard page"; fi
  if grep -nE "<(Modal|Dialog|ConfirmDialog)[ >]" $page >/dev/null; then fail "a modal on the scorecard page"; else ok "no modal on the scorecard page"; fi
  if grep -n "console\\." $route >/dev/null; then fail "a log line in the scorecard route"; else ok "no log line in the scorecard route"; fi
  if [ "$QUICK" -eq 0 ]; then
    if ( cd portal && node --test src/lib/__tests__/interviewsScorecard.test.ts ) >"$LOGS/portal-interviews-scorecard.log" 2>&1; then ok "portal scorecard helpers: $(grep -E '^ℹ pass' "$LOGS/portal-interviews-scorecard.log")"; else fail "portal scorecard helpers (see $LOGS/portal-interviews-scorecard.log)"; fi
    refuses_404 I5.3
    run_journey
    for s in I5.3a I5.3b I5.3c I5.3d I5.3e I5.3f; do journey_step "$s"; done
  else
    refuses_404 I5.3
  fi
}

built_row I5.3 row_I5.3
