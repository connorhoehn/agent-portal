# Row I5.2, Milo's recap, its first open and its ask (hardening lane H4). Sourced by scripts/validate-interviews.sh.

row_I5.2() {
  local route=$MW/routes/interviews/recap.ts parse=$MW/lib/interviews/recap/parse.ts page=$PAGES/ScorecardPage.tsx
  exists $route "the recap routes"
  # Every statement has a quote and a line number: the guard drops one without, and the page shows both.
  needF "line.side === 'candidate' && quote.length > 0 && quotedFrom(quote, [line])" $parse "a statement is kept only when its quote is in the candidate's own line it names"
  needF "{row.where}" $page "the page shows the line number of each statement"
  needF "const row = evidenceRow(c);" $page "the page shows the quote of each statement as its row"
  needF "where: \`Line \${claim.source.seq}\`" portal/src/lib/interviewsMiloAdvice.ts "the quote reads as a line of the transcript"
  # No Chip and no tone on the evidence: the recap view draws none.
  local view; view=$(awk '/^function RecapView/ { on = 1 } on { print } on && /^function AskFromRecap|^\/\*\* Under the recap/ { exit }' $page)
  if [ -z "$view" ]; then fail "RecapView not found in the scorecard page"; elif printf '%s' "$view" | grep -qE '<Chip|<Badge|<Tag|recommendationTone|tone="(success|danger|warning|accent|info)"|variant="(success|danger|warning)"'; then fail "a Chip or a tone in Milo's recap view"; else ok "no Chip and no tone in Milo's recap view"; fi
  # GET before one's own open is 404; the ask needs the open (decision 14's middle clause: rate, open the recap, then ask).
  needF "ratingsAtRecap(ref.interview.id, me)" $route "a seat reads the recap only after its own open or its own scorecard"
  needF "if (f.interview.state === 'reviewed' || !f.opened) return { kind: 'not-found' };" $MW/lib/interviews/milo-notes/rules.ts "the ask is not-found until the seat has opened the recap, and once the round is reviewed"
  needF "export const ASK_GAP_MS = 20_000;" $MW/lib/interviews/milo-notes/rules.ts "a second ask inside 20 seconds is refused"
  needF "res.setHeader('Cache-Control', 'no-store');" $route "the recap is never cached"
  needF "FIXED_ANSWER" $MW/lib/interviews/milo-notes/rules.ts "a question that asks for a judgement gets the one fixed sentence"
  want_count "recapRouter\.(get|post)\('/interviews/:id/recap" $route 3 "the three recap routes (GET, open, ask)"
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the recap-ask route in the guest sweep, and the recap guard's limits, size and counters" \
      src/routes/__tests__/interviews-invite-sweep.test.ts src/lib/interviews/recap/__tests__/parse.test.ts src/lib/interviews/recap/__tests__/prompt.test.ts src/lib/interviews/recap/__tests__/service.test.ts
    refuses_404 I5.2
    run_journey
    for s in I5.2a I5.2b I5.2c I5.2d I5.2e; do journey_step "$s"; done
  else
    refuses_404 I5.2
  fi
}

built_row I5.2 row_I5.2
