#!/usr/bin/env bash
# The judge for docs/meeting-rooms-app-goal.md — Teams-style meetings (raise
# hand, reactions, breakout rooms, room chat, announcements) wired into the
# portal and the BFF on the calls people already make.
# Exits 0 only when every check passes; prints every failing line.
#
#   ./scripts/validate-meeting-rooms-app.sh --quick   # static checks only
#   ./scripts/validate-meeting-rooms-app.sh           # + middleware guard tests, portal tests, fixture e2e (long; run alone)
#
# The real-media acceptance (M5 · E2) is a dated record under
# docs/realtime-validation/; this judge checks the record exists, it does not
# start the SFU.
set -u
cd "$(dirname "$0")/.."
P=${UPSTREAM_PROJECTS:-$HOME/Projects}
RM=$P/realtime-modules UI=$P/ui-components PA=$P/platform-api LV=$P/live-video-streaming

QUICK=0
for arg in "$@"; do case "$arg" in --quick) QUICK=1 ;; esac; done

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else fail "$2"; fi; }
none() { # pattern, path(s)..., label
  local pat=$1 label=${@: -1}; local paths=("${@:2:$#-2}")
  local n; n=$(grep -rEn -- "$pat" "${paths[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = 0 ]; then ok "$label"; else fail "$label — $n hits"; fi
}
vge() { node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}process.exit(0)' "$1" "$2"; }
installed() { # dir pkg → installed version
  node -p "require(require('path').resolve('$1','node_modules','$2','package.json')).version" 2>/dev/null
}
exports() { # dir subpath names... → every name is exported by the installed dist
  local dir=$1 sub=$2; shift 2
  (cd "$dir" && node --input-type=module -e "const m=await import('$sub');for(const n of process.argv.slice(1)){if(!(n in m)){console.error('missing',n);process.exit(1)}}" "$@")
}
RMPKG=$(node -p "Object.keys(require('./portal/package.json').dependencies).find(k=>k.endsWith('/realtime-modules'))" 2>/dev/null)
UIPKG=$(node -p "Object.keys(require('./portal/package.json').dependencies).find(k=>k.endsWith('/ui-components'))" 2>/dev/null)
GW=middleware/src/lib
SHELL_UI=portal/src/components/shell

section "goal exists"
check "[ -f docs/meeting-rooms-app-goal.md ]" "goal doc"
check "grep -q 'validate-meeting-rooms-app.sh' CLAUDE.md" "CLAUDE.md docs map names the judge"

section "M0 · ready to wire (pins)"
check "vge '$(installed portal "$RMPKG")' 0.134.0" "P0 portal installs realtime-modules ≥ 0.134.0 ($(installed portal "$RMPKG"))"
check "vge '$(installed middleware "$RMPKG")' 0.134.0" "P0 middleware installs realtime-modules ≥ 0.134.0 ($(installed middleware "$RMPKG"))"
check "vge '$(installed portal "$UIPKG")' 2.478.0" "P0 portal installs ui-components ≥ 2.478.0 ($(installed portal "$UIPKG"))"
check "[ \"\$(node -p \"require('./portal/package.json').dependencies['$RMPKG']\")\" = \"\$(node -p \"require('./middleware/package.json').dependencies['$RMPKG']\" | sed 's#\.\./portal/##')\" ]" "P0 portal and middleware pin the same realtime-modules tarball"
# The Pins sentence wraps across lines; read it as one.
pins_ok() {
  local pins; pins=$(tr '\n' ' ' < CLAUDE.md | grep -oE 'Pins: .{0,240}' | head -1)
  echo "$pins" | grep -qE 'ui-components` +\*\*2\.4(7[8-9]|[89][0-9])' && echo "$pins" | grep -qE 'realtime-modules`[^*]*\*\*0\.1(3[4-9]|[4-9][0-9])'
}
check pins_ok "P0 CLAUDE.md pins line names the new versions"
check "exports middleware '$RMPKG/meeting' meeting MeetingService RedisMeetingStateStore" "P0 installed dist: realtime-modules/meeting (server)"
check "exports portal '$RMPKG/client/meeting' useMeeting useFollowMeetingLobby" "P0 installed dist: realtime-modules/client/meeting"
check "exports portal '$UIPKG/integrations/realtime' meetingToolbarItems meetingRosterProps withMeetingHands useMeetingChat WrappedBreakoutRoomsPanel WrappedBreakoutRoomBanner" "P0 installed dist: ui-components meeting bindings"
# P1: validate-upstream-refinement (C2) wants no slalom-scoped realtime-modules
# alias; validate-component-discipline requires the vite alias to the slalom
# scope. Resolved means the two scripts no longer demand opposite things.
check "! { grep -q \"'@connorhoehn/realtime-modules': '@connorhoehnslalom/realtime-modules'\" scripts/validate-component-discipline.sh && grep -q '@connorhoehnslalom/realtime-modules' scripts/validate-upstream-refinement.sh; }" "P1 upstream-refinement (C2) and component-discipline (alias bridge) no longer contradict each other"

section "M1 · library seams (upstream first)"
check "grep -qE '\\(lane L1\\)' '$RM/CHANGELOG.md'" "L1 realtime-modules: the conversation call changes lobby in place (lane L1)"
check "grep -qE '\\(lane L2\\)' '$UI/CHANGELOG.md' && grep -qE '\\(lane L4\\)' '$UI/CHANGELOG.md' && grep -qE '\\(lane L5\\)' '$UI/CHANGELOG.md' && grep -qE '\\(lane L6\\)' '$UI/CHANGELOG.md'" "L2 ui-components: HuddleBar / call dock take meeting items and a stage slot (lane L2)"
check "grep -qE '\\(lane L3\\)' '$RM/CHANGELOG.md' && grep -rqE 'export function (breakoutChannel|parseBreakoutChannel)' '$RM/src/meeting'" "L3 realtime-modules: breakoutChannel / parseBreakoutChannel (lane L3)"

section "M2 · the BFF"
# The library feature is built in lib/gateway/meeting.ts (tenantMeeting) and registered in the gateway.
check "grep -qE 'tenantMeeting\\(' $GW/realtime-gateway.ts && grep -qE '(^|[^A-Za-z])meeting\\(\\{' $GW/gateway/meeting.ts" "B1 meeting() registered in attachRealtime"
check "grep -qE 'export async function meetingOrganizer' $GW/gateway/authority.ts && grep -qE 'isOrganizer:.*' $GW/gateway/meeting.ts && grep -qE 'return meetingOrganizer\\(' $GW/gateway/meeting.ts" "B1 isOrganizer is the facade's meetingOrganizer"
check "grep -qE 'opts\\.redis \\? \\{ store: new RedisMeetingStateStore' $GW/gateway/meeting.ts" "B1 Redis meeting store when clustered"
check "grep -rqE 'parseBreakout(Lobby|Channel)' $GW/gateway/authority.ts $GW/tenant-channels.ts" "B2/B3 guards strip the breakout suffix before family matching"
check "grep -qE 'admitsBreakoutLobby' middleware/src/routes/realtime-lobby-access.ts $GW/gateway/authority.ts" "B3 lobby-access and lobbyGuard ask admitsBreakoutLobby"
# /call-seat hands the seat to lib/call-media-proof.ts, which seats a call's room lobbies.
check "grep -qE \"post\\('/call-seat'\" middleware/src/routes/realtime-lobby-access.ts && grep -qE 'callMediaProofRuntime' middleware/src/routes/realtime-lobby-access.ts && grep -qE 'admitMeetingRoom\\(userId' middleware/src/lib/call-media-proof.ts" "B3 /call-seat accepts a breakout lobby for its call"
check "ls middleware/src/lib/gateway/__tests__/*meeting* middleware/src/routes/__tests__/*meeting* 2>/dev/null | grep -q ." "B2/B3 middleware tests for meeting admission exist"
check "grep -rlE 'breakout' middleware/src/lib/gateway/__tests__ middleware/src/routes/__tests__ 2>/dev/null | xargs grep -lE 'forged|closed|non-member|RID|family' 2>/dev/null | grep -q ." "B3 tests cover forged, closed and family-collision breakout names"
none "'/api/meeting" middleware/src/mock/core/wire/snapshots/routes.json "B no new REST route (meetings ride /ws; mock floor unchanged)"

section "M3 · the portal"
# The library call host (ui-components 2.476+) runs useMeeting and follows the room's lobby itself;
# the shell hands it the meeting option. Checked in the installed dist, not the library source.
UIRT=portal/node_modules/$UIPKG/dist/integrations/realtime.js
check "grep -qE 'meeting=\\{SHELL_MEETING\\}' $SHELL_UI/ShellCallHost.tsx && grep -rlqE 'useMeeting' portal/node_modules/$UIPKG/dist/integrations/ 2>/dev/null" "U1 the call host runs useMeeting"
check "grep -qE 'mediaLobby' $UIRT && grep -qE 'activeLobby' portal/node_modules/$UIPKG/dist/integrations/realtime.d.ts" "U1 the call follows the meeting's active lobby"
check "grep -rqE 'meetingToolbarItems\\(' $SHELL_UI portal/src" "U2/U3 toolbar items come from the binding"
check "grep -rqE '<MeetingToolbar' portal/src" "U3 MeetingToolbar on the expanded stage"
check "grep -rqE '<CallMediaOutlet' portal/src && grep -qE 'handFor' portal/node_modules/$UIPKG/dist/integrations/realtime.d.ts" "U3 hands on tiles"
check "grep -rqE 'meetingRosterProps\\(' portal/src" "U3 hands queue in People"
check "grep -rqE 'WrappedBreakoutRoomsPanel' portal/src && grep -rqE 'WrappedBreakoutRoomBanner' portal/src" "U3 rooms pane and in-room banner"
# The library's CallMediaOutlet draws RecordingConsentNotice from the call's recording state
# (ui-components 2.480.1 over realtime-modules 0.137.0); the shell must not turn it off.
check "grep -qE 'recordingConsent' portal/node_modules/$UIPKG/dist/integrations/realtime.d.ts && grep -qE 'recording\\?:' portal/node_modules/$RMPKG/dist/client/video/useConversationCall.d.ts && ! grep -rqE 'recordingConsent=\\{false\\}' portal/src" "U3 recording consent when the call records"
check "grep -rqE 'useMeetingChat\\(' portal/src" "U4 call chat bound with useMeetingChat"
# A surface is on when lib/meetingRooms.ts's meetingEnabledFor admits its lobby family (decision 5:
# initiative huddles, then social rooms, then document calls); a sample lobby of each family asks it.
surface_on() {
  node --input-type=module -e "const m = await import('./portal/src/lib/meetingRooms.ts'); process.exit(m.meetingEnabledFor(process.argv[1], true) ? 0 : 1)" "$1"
}
check "surface_on orgiq:initiative:p-auth-migration" "U5 surface wired: initiative"
# Decision 5 (user, 2026-10-17): initiative huddles only for this goal. Every other surface stays off
# until it ships whole; turning one on early fails here.
check "! surface_on social:ch:general" "U5 social rooms stay off (decision 5: later)"
check "! surface_on assessment:doc:d-1" "U5 document calls stay off (decision 5: later)"
check "./scripts/validate-component-discipline.sh >/dev/null" "U component discipline holds (shell budget 0:0:0)"

section "M4 · media admission across repos"
check "grep -rqE 'breakout' '$PA/src' 2>/dev/null || grep -rqE 'breakout' docs/realtime-validation 2>/dev/null" "X1 platform-api admits breakout lobbies (its test or the E2 record)"
check "grep -qE 'LOBBY_AUTHORITY_REQUIRED[:=] *(\"?true|\\\$\\{[A-Z_]+:-true\\})' docker-compose.yml" "X1 the local stack runs platform-api with LOBBY_AUTHORITY_REQUIRED=true (breakouts are guarded by the BFF)"
check "grep -rqE 'lobbyAuthority|LOBBY_AUTHORITY' portal/src 2>/dev/null || grep -rqE 'breakoutsEnabled|meetingRooms' middleware/src/routes 2>/dev/null" "X1 Rooms is offered only where lobby authority is on"
check "grep -qE 'X2.*(fixed|closed).*[0-9a-f]{7}' docs/meeting-rooms-app-goal.md" "X2 the LVS streamKey read hole is closed by its owner (commit recorded)"

section "M5 · proof"
check "[ -f portal/e2e/meeting-rooms.spec.ts ]" "E1 fixture e2e: two clones, hands, rooms, announcement, return"
check "[ -f portal/e2e/huddle-breakout-real.spec.ts ]" "E2 real-media spec exists (REAL_MEDIA_ACCEPTANCE=1)"
check "ls docs/realtime-validation/*/meeting-breakout.md 2>/dev/null | grep -q ." "E2 dated real-media acceptance record"
check "[ -n \"\$(find docs/journeys/maps -name 'call-rooms.ts' -path '*org-leader*')\" ] && [ -n \"\$(find docs/journeys/maps -name 'call-rooms.ts' -path '*sme*')\" ]" "E3 journey maps for calls with rooms (organizer and participant)"
check "grep -qE 'rooms pane|meeting' portal/e2e/ui-dom-audit.adapter.ts" "E3 ui-dom-audit has a call-open, rooms-pane state"

section "M6 · docs"
check "grep -qE 'meeting' docs/journeys.md" "D1 journeys doc names the meeting walks"
check "ls docs/claude-code-handoff-*.md 2>/dev/null | xargs grep -lE 'meeting' 2>/dev/null | grep -q ." "D1 handoff doc records the pins and what is owed"

if [ "$QUICK" = 0 ]; then
  section "suites (run alone)"
  check "(cd middleware && npm run -s typecheck)" "middleware typecheck"
  check "(cd middleware && npx jest src/lib/gateway src/routes/__tests__/realtime-lobby-access --silent)" "middleware gateway + lobby-access tests"
  check "(cd portal && npx tsc --noEmit -p .)" "portal typecheck"
  check "(cd portal && npx playwright test e2e/meeting-rooms.spec.ts)" "E1 fixture e2e"
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
echo "${#FAILS[@]} check(s) failing"; exit 1
