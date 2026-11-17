# Row I2.1: the invite token and the guest identity. Sourced by scripts/validate-interviews.sh (helpers, $MW, $QUICK).
# The phase's floor suites (phase_suites I2) run the invite suites, the invite routes and their H2 edge file.
row_I2_1() {
  local INV=$MW/lib/interviews/invite R=$MW/routes/interview-invite.ts H2T=$MW/routes/__tests__/interviews-invite.H2.test.ts
  for f in token guest store rules realtime; do exists "$INV/$f.ts" "lib/interviews/invite/$f.ts"; done
  exists "$R" "the guest's routes (routes/interview-invite.ts)"
  exists portal/src/pages/JoinPage.tsx "the candidate's page"
  # The five suites the row was built with.
  for t in rules store realtime admission; do exists "$INV/__tests__/$t.test.ts" "invite suite $t.test.ts"; done
  exists "$MW/routes/__tests__/interviews-invite.test.ts" "the invite routes' suite"
  # /join is mounted outside the app: main.tsx picks the page by path; the app has no /join route.
  needF "window.location.pathname === '/join'" portal/src/main.tsx "/join is mounted outside App (main.tsx)"
  if grep -qE "path=\"/?join\"" portal/src/App.tsx; then fail "App.tsx routes /join (it must stay outside the app)"; else ok "App.tsx has no /join route"; fi
  # The guest's realtime token is minted by the guest's own route only (round 4 added GET /realtime-token there).
  local minters; minters=$(grep -rl "mintGuestRealtimeToken" "$MW/routes" --include='*.ts' 2>/dev/null | grep -v __tests__ | sort | tr '\n' ' ')
  if [ "$minters" = "$R " ]; then ok "the guest's realtime mint is imported by the guest's own route only"; else fail "the guest's realtime mint is imported by: $minters"; fi
  needF "takeToken" portal/src/pages/JoinPage.tsx "the page takes the token out of the address"
  needF "window.history.replaceState" portal/src/pages/JoinPage.tsx "the fragment is removed at once"
  # The H2 edge tests (O-047 to O-050, O-052, O-072).
  for w in "behind a trusted proxy each forwarded client has its own window" "the same link opens a new session" \
    "moving the interview earlier ends the link sooner" "read on every request: off, every guest route" "is the bare path: never an origin made up"; do
    needF "$w" "$H2T" "edge: $w"
  done
  needF "drops the token at once" portal/src/pages/join/__tests__/guestRealtime.H2.test.ts "edge: the token refresh after the end (page half)"
  refuses_404 I2.1
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in a b c d e f g h; do journey_step "I2.1$s"; done
  fi
}
built_row I2.1 row_I2_1
