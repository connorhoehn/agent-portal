# Row I5.4, the recruiter's review and the debrief page (hardening lane H4). Sourced by scripts/validate-interviews.sh.

row_I5.4() {
  local route=$MW/routes/interviews/debrief.ts page=$PAGES/DebriefPage.tsx
  exists $route "the debrief route"
  exists $page "the debrief page"
  needF "debriefRouter.get('/candidates/:id/debrief'" $route "the debrief read"
  if awk '/debriefRouter.get\(.\/candidates\/:id\/debrief/ { on = 1 } on { print } on && /^}\)\);/ { exit }' $route | grep -qF "res.setHeader('Cache-Control', 'no-store');"; then ok "the debrief is never cached"; else fail "the debrief read does not set no-store"; fi
  # No average, no total, no ranking (decision 6): not in the view's code and not in the page.
  if grep -nEi "(average|mean|total|rank|overall)[A-Za-z]*\\s*[:=(]" $MW/lib/interviews/debrief/view.ts | grep -vE "^[0-9]+:\\s*(//|/?\\*)" >/dev/null; then fail "a computed average, total or rank in the debrief view"; else ok "the debrief view computes no average, total or rank"; fi
  needF "stickyFirstColumn" $page "the Competency column stays in view"
  needF "columnGroups" $page "a column group per round"
  needF "interviews-debrief-record" $page "Open the record from each round"
  needF "RecapInPlace" $page "Milo's recap is read in place"
  if grep -n "style={{" $page >/dev/null; then fail "inline styles on the debrief page"; else ok "no inline styles on the debrief page"; fi
  if [ "$QUICK" -eq 0 ]; then
    if ( cd portal && node --test src/lib/__tests__/interviewsDebrief.test.ts ) >"$LOGS/portal-interviews-debrief.log" 2>&1; then ok "portal debrief helpers: $(grep -E '^ℹ pass' "$LOGS/portal-interviews-debrief.log")"; else fail "portal debrief helpers (see $LOGS/portal-interviews-debrief.log)"; fi
    refuses_404 I5.4
    run_journey
    for s in I5.4a I5.4b I5.4c I5.4d; do journey_step "$s"; done
  else
    refuses_404 I5.4
  fi
}

built_row I5.4 row_I5.4
