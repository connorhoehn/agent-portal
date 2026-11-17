# Row I5.5, the hiring manager's recap and the stage decision (hardening lane H4). Sourced by scripts/validate-interviews.sh.

row_I5.5() {
  local route=$MW/routes/interviews/debrief.ts
  exists $route "the stage route"
  needF "debriefRouter.post('/applications/:id/stage', readersDoNotDecide, requireAction('DecideCandidate')" $route "deciding is DecideCandidate, and the recruiter is told they read and do not decide"
  needF "opening.hiringManagerId !== session.sub) throw new NotFoundError" $route "only the opening's hiring manager decides; another's is not found"
  needF "basedOn !== app.history.length" $route "a stale page is refused, so two windows cannot both record"
  needF "decideStage(app.id, change, basedOn)" $route "the decision is one compare-and-set write against the history length the page read"
  needF "void stageDecided(app.id, session.sub);" $route "the recruiter is rung after the decision"
  want_count "res.setHeader\('Cache-Control', 'no-store'\)" $route 3 "the debrief read, the recruiter's refusal and the stage answer are never cached"
  needF "DECISION_CHOICES" $PAGES/DebriefPage.tsx "the three choices are asked in the prompt deck"
  needF "ComposerPrompt" $PAGES/DebriefPage.tsx "the decision waits in the composer's prompt deck"
  if [ "$QUICK" -eq 0 ]; then
    refuses_404 I5.5
    run_journey
    for s in I5.5a I5.5b I5.5c I5.5d I5.5e; do journey_step "$s"; done
  else
    refuses_404 I5.5
  fi
}

built_row I5.5 row_I5.5
