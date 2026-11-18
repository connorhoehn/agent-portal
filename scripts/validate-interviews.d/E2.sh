# Row E2: isolation walks (lane H6). Sourced by scripts/validate-interviews.sh. The table E2.404 (every other tenant, every
# other interview, the export, the runs stream, the reverse at the tenant gate), the walk's channels, two live rounds and a
# running call (E2a to E2d), the guest sweep that names every route from the routers, and the authz matrix.
row_E2() {
  local SWEEP=$MW/routes/__tests__/interviews-invite-sweep.test.ts
  exists "scripts/journeys/interviews/E2.mjs" "the isolation walk piece"
  needF "names every guest route the router mounts, and no more" "$SWEEP" "the guest sweep fails on a guest route it does not name (O-275)"
  needF "const ROUNDS_3_TO_6" "$SWEEP" "the guest sweep names the routes rounds 3 to 6 added (O-184)"
  needF "answers the Work-only persona 403 and the guest cookie 401 on every route, enumerated" "$SWEEP" "the reverse: every interviews route, a Work-only person and a guest cookie"
  needF "guest out of another live round" "$SWEEP" "an admitted guest of one live round reaches none of another's runs"
  needF "MEETING_ASSISTANT_ENABLED: 'true'" "$SWEEP" "the sweep's server runs with Milo on, as the walk does"
  needF "the development mode: no session is the demo identity" "$MW/lib/interviews/__tests__/gate-answer.H6.test.ts" "the gate's answer to no session and a guest, in the product (401) and the dev mode (403)"
  # The table names the pad's channel stream and the runs stream for the other tenant's person and a guest of another
  # interview (O-276); the pad's channel itself is walk step E2a.
  needF "/runs/events | workOnly=403 guest=403 guest:kwameLive=403 guest:aikoCoding=403" "scripts/validate-interviews.d/E2.404" "the runs stream refuses another tenant's person and every guest (O-276)"
  needF "PAD(KL)" "scripts/journeys/interviews/E2.mjs" "the walk asks for another interview's pad on the gateway (O-276)"
  # The authz matrix still names every interviews action and role (the UI rounds added none).
  local m=$MW/lib/__tests__/authz-matrix.test.ts a
  for a in "${ACTIONS[@]}"; do needF "'$a'" "$m" "the authz matrix names $a"; done
  for r in "${ROLES[@]}"; do needF "'interviews/$r'" "$m" "the authz matrix names interviews/$r"; done
  # O-094 (row I2.6's platform-api half): the platform-api commit the social profile builds has the guest test and the
  # interviews tenant in its lobby authority's default. Read from the sibling checkout beside the main checkout.
  local pin pa
  pin=$(node -e 'console.log(require("./scripts/docker/document-workspace-sources.json").socialSources["platform-api"].commit)' 2>/dev/null)
  pa="$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd)/../platform-api"
  if [ -z "$pin" ] || ! git -C "$pa" cat-file -e "$pin^{commit}" 2>/dev/null; then
    pending "O-094: the platform-api pin cannot be read here (no sibling platform-api checkout with $pin)"
  else
    if git -C "$pa" show "$pin:src/lib/guestToken.ts" 2>/dev/null | grep -q "export function isGuestClaims"; then ok "O-094: the social profile's platform-api pin has isGuestClaims"; else fail "O-094: the social profile's platform-api pin ${pin:0:8} has no isGuestClaims (scripts/docker/document-workspace-sources.json socialSources)"; fi
    if git -C "$pa" show "$pin:src/lib/lobbyAuthority.ts" 2>/dev/null | grep -qE "\['orgiq'.*'interviews'\]"; then ok "O-094: its lobby authority's default holds the interviews tenant"; else fail "O-094: the platform-api pin ${pin:0:8} has no interviews tenant in the lobby authority's default"; fi
  fi
  refuses_404 E2
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the guest sweep and the authz matrix" src/routes/__tests__/interviews-invite-sweep.test.ts src/lib/__tests__/authz-matrix.test.ts src/lib/interviews/__tests__/gate-answer.H6.test.ts
    run_journey
    for s in a b c d; do journey_step "E2$s"; done
  fi
}
built_row E2 row_E2
