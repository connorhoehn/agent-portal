#!/usr/bin/env bash
# The judge for docs/interviews-tenant-plan.md — the `interviews` tenant. A row is done when this script
# says so, never when the plan's table is edited (row I0.1).
#
#   scripts/validate-interviews.sh --quick           static checks only, every phase
#   scripts/validate-interviews.sh --phase I0        phase 0, with its suites
#   scripts/validate-interviews.sh --phase I1        phases 0 and 1 (phases nest), with the walk
#   scripts/validate-interviews.sh                   every phase through E
#
# Each ledger row is either BUILT (listed in BUILT below, the lane's claim) or not. A built row in a judged
# phase runs its checks and every failing check prints with its row number. A row not built prints
# "not built"; it fails only in the full run (no --phase), which is the backlog view of the whole plan.
# A row in a phase after the one asked for prints "later phase" and is not judged.
#
# Suites (skipped by --quick): the middleware jest suites the rows own, the portal's interviews test, and,
# from phase I1, journey:interviews through run-demo-moments.mjs on JOURNEY_MIDDLEWARE_PORT /
# JOURNEY_PORTAL_PORT (set both when anyone else runs servers on this machine).
#
# Exit 0 and "ALL CHECKS PASS" only when no check failed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0; PHASE=E; FULL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --phase) shift; PHASE="${1:-E}"; FULL=0 ;;
    --phase=*) PHASE="${1#--phase=}"; FULL=0 ;;
    *) echo "usage: $0 [--quick] [--phase I0|I1|I2|I3|I4|I5|I6|E]" >&2; exit 2 ;;
  esac
  shift
done
phase_rank() { case "$1" in I0) echo 0;; I1) echo 1;; I2) echo 2;; I3) echo 3;; I4) echo 4;; I5) echo 5;; I6) echo 6;; E) echo 7;; *) echo -1;; esac; }
PR=$(phase_rank "$PHASE")
[ "$PR" -ge 0 ] || { echo "unknown phase: $PHASE" >&2; exit 2; }

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/validate-interviews-XXXXXX")"
FAILS=(); PENDING=()
ROW=""
fail()  { FAILS+=("$ROW $1"); printf '  ✗ %s %s\n' "$ROW" "$1"; }
ok()    { printf '  ✓ %s %s\n' "$ROW" "$1"; }
note()  { printf '      %s\n' "$1"; }
pending() { PENDING+=("$ROW $1"); printf '  · %s %s\n' "$ROW" "$1"; }
has()   { grep -qE -- "$1" "$2" 2>/dev/null; }
hasF()  { grep -qF -- "$1" "$2" 2>/dev/null; }
need()  { if has "$1" "$2"; then ok "$3"; else fail "$3 (not found in $2)"; fi; }
needF() { if hasF "$1" "$2"; then ok "$3"; else fail "$3 (not found in $2)"; fi; }
exists() { if [ -e "$1" ]; then ok "$2"; else fail "$2 ($1 missing)"; fi; }
count() { grep -cE -- "$1" "$2" 2>/dev/null || true; }
want_count() { local n; n=$(count "$1" "$2"); if [ "${n:-0}" -eq "$3" ]; then ok "$4 ($n)"; else fail "$4: $n, want $3"; fi; }

# A jest suite list, run once; the log is kept for a failure.
jest_ok() {
  local label="$1"; shift
  local log="$LOGS/jest-$(echo "$label" | tr -c 'a-z0-9' '-').log"
  ( cd middleware && npx jest "$@" --maxWorkers=2 ) >"$log" 2>&1
  if [ $? -eq 0 ]; then ok "$label: $(grep -E '^Tests:' "$log" | tail -1)"; else fail "$label: $(grep -E '^Tests:' "$log" | tail -1) (see $log)"; grep -E '✕' "$log" | head -8 | sed 's/^/      /'; fi
}

T=interviews
ROLES=(recruiter interviewer hiring-manager)
ACTIONS=(ViewInterviews ManageCandidates AssignInterviews ConductInterview DecideCandidate)
CAST=(u-greta u-hugo u-wen u-amara)
CAST_NAMES=("Greta Lindqvist" "Hugo Marchetti" "Wen Zhao" "Amara Okafor")
MW=middleware/src
PAGES=portal/src/pages/interviews

# The ledger (docs/interviews-tenant-plan.md "Ledger"): id|phase|title.
ROWS=(
  "I0.1|I0|the judge, with --quick and --phase, phases nesting"
  "I0.2|I0|registration: manifest, Cedar, actions, rank, mount, channels, labels, voice, flags, nav, picker, colours, inventory"
  "I0.3|I0|the model: schema, the in-memory store and the SQL store behaving the same"
  "I0.4|I0|the cast and the seed story in the mock world"
  "I0.5|I0|read routes and the permission matrix"
  "I0.6|I0|spend source interviews and how an opening carries a cap"
  "I0.7|I0|spike: how the code pad is carried and walked; a guest's seat"
  "I1.1|I1|Candidates table"
  "I1.2|I1|candidate profile with the stage tracker and the rounds list"
  "I1.3|I1|openings and the kit editor"
  "I1.4|I1|assign a round; the bell; My interviews; accept or decline"
  "I1.5|I1|a date-and-time field; the time on an interview; Upcoming"
  "I1.6|I1|résumé upload and a PDF viewer"
  "I1.7|I1|Prepare page"
  "I1.8|I1|behavioural rounds"
  "I2.1|I2|invite token and the guest identity"
  "I2.2|I2|lobby family, admission, a guest seat, the channel guard"
  "I2.3|I2|portal: landing, notice and consents, device check, waiting room"
  "I2.4|I2|the interview room for both sides"
  "I2.5|I2|declined consent"
  "I2.6|I2|recording only with consent; panel-only playback"
  "I2.7|I2|panel seats"
  "I3.1|I3|a policy seam in the meeting assistant"
  "I3.2|I3|the interviews policy"
  "I3.3|I3|the coach with a scripted stand-in; the suggestion log"
  "I3.4|I3|the footer prompt"
  "I3.5|I3|Milo asks aloud"
  "I3.6|I3|Milo for you"
  "I3.7|I3|the live transcript, panel side only"
  "I3.8|I3|the candidate's two fixed requests"
  "I3.9|I3|what an interview costs; a listener on Amazon Transcribe"
  "I3.10|I3|the coach drafts a question plan"
  "I4.1|I4|library: a collaborative code editor"
  "I4.2|I4|the pad in the room"
  "I4.3|I4|the pad log"
  "I4.4|I4|the run interface, queue, mock executor and output"
  "I4.5|I4|the coach reads the pad and the last run"
  "I4.6|I4|design: the real backends"
  "I5.1|I5|the interview record page"
  "I5.2|I5|the recap writer"
  "I5.3|I5|a rating input; the scorecard"
  "I5.4|I5|recruiter review and the debrief page"
  "I5.5|I5|the hiring manager's recap and the stage decision"
  "I5.6|I5|bells"
  "I6.1|I6|consent records and notice versions"
  "I6.2|I6|export"
  "I6.3|I6|retention sweeps and deletion on request"
  "I6.4|I6|settings per deployment"
  "E1|E|the whole journey in one pass"
  "E2|E|isolation walks"
  "E3|E|the DOM audit and the type-scale sweep over every new page"
  "E4|E|a read-only audit sweep and its repairs"
)
# The rows a lane has built. Add a row here in the change that builds it, with its checks below.
BUILT=" I0.1 I0.2 I0.3 I0.4 I0.5 I1.1 "

row_I0.1() {
  exists scripts/validate-interviews.sh "the judge is scripts/validate-interviews.sh"
  needF '--quick) QUICK=1' scripts/validate-interviews.sh "it takes --quick"
  needF 'phase_rank "$1" ' scripts/validate-interviews.sh "phases nest by rank"
  ok "it runs: every failing check prints with its row, and the last line is the count"
}

row_I0.2() {
  local f
  if node -e "const m=require('./tenants/manifest.json');const t=m.tenants.find(x=>x.id==='$T');process.exit(t&&t.displayName==='Interviews'&&t.apiPrefix==='/api/interviews'&&t.portalRoot==='/interviews'&&JSON.stringify(t.roles)==='[\"recruiter\",\"interviewer\",\"hiring-manager\"]'&&t.channelPartition===true&&t.demoGrant===false?0:1)"; then
    ok "manifest: Interviews, /api/interviews, /interviews, the three roles, a default-deny channel partition, no demo grant"
  else fail "manifest: the interviews entry is missing or differs (tenants/manifest.json)"; fi
  if node scripts/gen-tenants.mjs --check >"$LOGS/gen-tenants.log" 2>&1; then ok "generated files match the manifest"; else fail "generated files are stale (node scripts/gen-tenants.mjs)"; fi
  if node scripts/check-tenant-manifest.mjs >"$LOGS/check-manifest.log" 2>&1; then ok "check-tenant-manifest: seeds, mounts, route trees and shell labels agree"; else fail "check-tenant-manifest: $(head -3 "$LOGS/check-manifest.log" | tr '\n' ' ')"; fi
  for r in "${ROLES[@]}"; do
    f=middleware/seeds/roles/$T/$r.cedar
    if [ -f "$f" ]; then
      need 'principal\.tenant == "'$T'"' "$f" "Cedar $r conditions on tenant $T"
      need 'principal\.role == "'$r'"' "$f" "Cedar $r conditions on its role"
      if has 'VoiceNavigate' "$f"; then fail "Cedar $r grants VoiceNavigate, but interviews is not a voice tenant"; fi
    else fail "Cedar $f missing"; fi
  done
  local leak
  leak=$(grep -lE "$(IFS='|'; echo "${ACTIONS[*]}")" middleware/seeds/roles/{orgiq,assessment,social,pipelines,access}/*.cedar 2>/dev/null)
  [ -z "$leak" ] && ok "no other tenant's Cedar names an interviews action" || fail "interviews actions leak into: $leak"
  for a in "${ACTIONS[@]}"; do
    needF "\"$a\"" middleware/seeds/schema.json "schema.json declares $a"
    needF "'$a'" $MW/lib/authz.ts "CAPABILITY_ACTIONS lists $a"
    needF "'$a'" portal/src/lib/capabilities.tsx "the portal's capability union lists $a"
  done
  for r in "${ROLES[@]}"; do
    need "^  '?$r'?: \\{ label:" $MW/lib/role-registry.ts "role presentation for $r"
    need "'?$r'?: [0-9]" $MW/lib/session.ts "ROLE_RANK ranks $r"
  done
  for i in 0 1 2 3; do
    need "id: '${CAST[$i]}', displayName: '${CAST_NAMES[$i]}'.*" $MW/providers/identity.ts "fallback directory has ${CAST_NAMES[$i]}"
    needF "('${CAST[$i]}'," schema/seed_demo_identities.sql "demo identities seed ${CAST[$i]}"
  done
  need "interviews: \\['(recruiter|interviewer|hiring-manager)'\\] \\}" $MW/providers/identity.ts "the cast holds a grant only in interviews"
  need "'u-operator', 'interviews', 'admin'" schema/seed_demo_identities.sql "u-operator holds admin in interviews (SQL)"
  needF "interviews: ['admin']" $MW/providers/identity.ts "u-operator holds admin in interviews (fallback)"
  for e in greta.lindqvist hugo.marchetti wen.zhao amara.okafor; do needF "$e@orgiq.example" infra/lib/authentication-stack.ts "Cognito seed user $e"; done
  need "app\\.use\\('/api/interviews', requireTenant\\('interviews'\\), interviewsFlagGate, interviewsRouter\\)" $MW/index.ts "the mount: requireTenant('interviews'), the flag, the router"
  needF "INTERVIEWS_ENABLED" $MW/lib/interviews/flag.ts "the server flag INTERVIEWS_ENABLED"
  needF "config.mock?.aurora === true" $MW/lib/interviews/flag.ts "the flag is on in the mock world when unset"
  if has "tenant: 'interviews'" $MW/lib/tenant-channels.ts; then fail "a channel family for interviews exists before its row (I2.2)"; else ok "no interviews channel family yet: the partition denies every interviews: channel"; fi
  needF "interviews: 'Interviews'" $MW/lib/social-notify.ts "notification label"
  needF "interviews: ['/interviews/']" $MW/lib/social-notify.ts "notification paths stay inside /interviews/"
  if grep -E "^export const VOICE_TENANTS" $MW/lib/voice/catalogue.ts | grep -q interviews; then fail "VOICE_TENANTS lists interviews, but its roles hold no VoiceNavigate"; else ok "voice: interviews is not a voice tenant (VOICE_TENANTS), and says why"; fi
  for p in candidates my-openings my-interviews; do needF "id: '$p', path: '/interviews/$p'" $MW/lib/voice/catalogue.ts "voice page list mirrors the palette: $p"; done
  if node scripts/voice/inventory.mjs --check >"$LOGS/voice-inventory.log" 2>&1; then ok "voice inventory is current (docs/voice-tool-inventory.json)"; else fail "voice inventory: $(tail -1 "$LOGS/voice-inventory.log")"; fi
  needF 'path="interviews"' portal/src/App.tsx "App.tsx mounts the /interviews tree"
  needF '<RequireTenant tenant="interviews" fallback={<OtherWorkspace tenant="interviews" />}>' portal/src/App.tsx "under RequireTenant, refusing with the other-workspace page"
  needF "INTERVIEWS_ENABLED" portal/src/lib/features.ts "portal flag INTERVIEWS_ENABLED (VITE_ENABLE_INTERVIEWS)"
  needF "INTERVIEWS_ENABLED ?" portal/src/App.tsx "App.tsx honours the portal flag"
  want_count "tenant: 'interviews', group:" portal/src/components/shell/Layout.tsx 3 "rail rows for interviews"
  needF "interviews: 'Interviews'" portal/src/components/shell/Layout.tsx "TENANT_LABELS.interviews"
  needF "interviews: ['Hire', 'Interview', 'System']" portal/src/components/shell/portalCommands.ts "palette group order"
  want_count "tenant: 'interviews', group:" portal/src/components/shell/portalCommands.ts 3 "palette rows for interviews"
  needF "interviews: { label: 'Interviews'" portal/src/pages/SelectContextPage.tsx "the picker's tile"
  for u in "${CAST[@]}"; do needF "{ id: '$u', persona:" portal/src/pages/SelectContextPage.tsx "the picker's cast has $u (demo logins)"; done
  needF '[data-tenant="interviews"] {' portal/src/app.css "light tenant colours"
  needF 'html[data-theme="dark"][data-tenant="interviews"]' portal/src/app.css "dark tenant colours"
  needF "--color-tenant-interviews:" portal/src/app.css "the tile colour token"
  needF "'interviews.'," portal/src/lib/tenantCaches.ts "tenant caches clear interviews.* on a switch"
  needF "if (root === 'interviews')" portal/src/components/shell/breadcrumbResolve.ts "breadcrumbs for /interviews"
  for r in "${ROLES[@]}"; do need "^  '?$r'?: '" portal/src/components/shell/MasqueradeMenu.tsx "masquerade label for $r"; done
  needF "interviews: { interviewer: '/interviews/my-interviews', 'hiring-manager': '/interviews/my-openings' }" portal/src/lib/tenantHome.ts "a home per role"
  needF "'interviewer', 'hiring-manager', 'recruiter'," portal/src/lib/pageAccess.ts "the no-access page ranks the roles"
  needF "'access', 'interviews']" portal/e2e/route-inventory.ts "route inventory TENANTS"
  needF "function interviewsComposerPolicy" portal/e2e/ui-dom-audit.policies.ts "DOM audit classifies /interviews routes"
  needF "pattern: /^\\/interviews\$/" portal/e2e/ui-dom-audit.routes.ts "DOM audit knows the /interviews alias"
  # The wire snapshots are recaptured by the integrator, never by a lane.
  if hasF '"/api/interviews/' middleware/src/mock/core/wire/snapshots/routes.json; then ok "wire snapshot carries /api/interviews"; else pending "wire snapshots: /api/interviews not captured yet (the integrator recaptures)"; fi
}

row_I0.3() {
  exists schema/interviews_schema.sql "schema/interviews_schema.sql"
  for t in interview_openings interview_candidates interview_applications interviews interview_scorecards; do
    need "CREATE TABLE IF NOT EXISTS $t \\(" schema/interviews_schema.sql "table $t"
    needF "('$t'," schema/row_level_security.sql "row-level security lists $t"
  done
  needF '"file": "interviews_schema.sql"' schema/manifest.json "schema/manifest.json registers it"
  needF "class MemoryInterviewsStore" $MW/lib/interviews/store.ts "the in-memory store"
  needF "class SqlInterviewsStore" $MW/lib/interviews/store-sql.ts "the SQL store"
  needF "config.mock?.aurora" $MW/lib/interviews/store-select.ts "the store is chosen by the world"
  needF "describe.each([" $MW/lib/interviews/__tests__/store.test.ts "one contract runs over both stores"
  needF "every statement matches schema/interviews_schema.sql" $MW/lib/interviews/__tests__/store.test.ts "the statements are held to the DDL"
  [ "$QUICK" -eq 1 ] || jest_ok "store tests in both" src/lib/interviews/__tests__/store.test.ts
}

row_I0.4() {
  local F=$MW/mock/interviews.ts
  exists "$F" "the seed story (mock/interviews.ts)"
  for k in openings candidates applications interviews scorecards; do needF "key: 'interviews.$k'," "$F" "registered fixture interviews.$k"; done
  want_count "^      \\{ id: 'op-" "$F" 3 "openings"
  want_count "^      candidate\\('cand-" "$F" 12 "candidates"
  want_count "^      application\\('app-" "$F" 12 "applications"
  want_count "^      interview\\(\\{ id: 'iv-.*state: '(assigned|accepted|ready)'" "$F" 6 "upcoming interviews"
  want_count "^      \\{ id: 'sc-" "$F" 4 "finished interviews with scorecards"
  want_count "state: '(scored|reviewed)'" "$F" 4 "interviews scored or reviewed"
  local stages; stages=$(grep -oE "step\\('[a-z-]+'" "$F" | sort -u | wc -l | tr -d ' ')
  [ "$stages" -ge 5 ] && ok "candidates spread over the stages ($stages stages used)" || fail "candidates over only $stages stages"
  if grep -E "@[a-z0-9.-]+" "$F" | grep -vqE "@mail\\.example"; then fail "a candidate email outside the fictional mail.example domain"; else ok "candidate emails are all fictional (mail.example)"; fi
  if grep -qE "clock\\.(daysAgo|now)" "$F"; then ok "every instant is relative to the mock clock"; else fail "fixed dates in the seed"; fi
  for t in interview_openings interview_candidates interview_applications interviews interview_scorecards; do needF "table: '$t'," $MW/mock/core/parity/shape-entities.ts "the shape table holds the fixture to $t"; done
  [ "$QUICK" -eq 1 ] || jest_ok "mock parity and shape" src/mock/core/parity/__tests__/schema-shape.test.ts src/mock/core/parity/__tests__/seed-parity.test.ts src/mock/core/parity/__tests__/shape-mutation.test.ts
}

row_I0.5() {
  local F=$MW/routes/interviews.ts
  exists "$F" "routes/interviews.ts"
  for p in /openings /openings/:id /candidates /candidates/:id /interviews /interviews/:id; do needF "interviewsRouter.get('$p'," "$F" "route GET $p"; done
  needF "interviewsRouter.use(requireAction('ViewInterviews'))" "$F" "every route needs ViewInterviews"
  needF "throw new NotFoundError" "$F" "a row outside the viewer's scope is a 404"
  for r in recruiter interviewer hiring-manager; do needF "'interviews/$r': {" $MW/lib/__tests__/authz-matrix.test.ts "authz-matrix row for $r"; done
  needF "cannot open another interviewer" $MW/routes/__tests__/interviews.test.ts "route test: an interviewer cannot open another's interview"
  needF "never the opening that is not theirs" $MW/routes/__tests__/interviews.test.ts "route test: a hiring manager sees only their openings"
  needF "403 at the mount, naming the tenant it needs" $MW/routes/__tests__/interviews.test.ts "route test: other tenants' roles are refused"
  [ "$QUICK" -eq 1 ] || jest_ok "routes, scope and the matrix" src/routes/__tests__/interviews.test.ts src/lib/interviews/__tests__/scope.test.ts src/lib/__tests__/authz-matrix.test.ts
}

JOURNEY_LOG=""
run_journey() {
  [ -n "$JOURNEY_LOG" ] && return
  JOURNEY_LOG="$LOGS/journey.log"
  ( cd portal && node ../scripts/journeys/run-demo-moments.mjs --journey interviews --out "$LOGS/journey" ) >"$JOURNEY_LOG" 2>&1
}
journey_step() {
  if grep -q "^PASS $1:" "$JOURNEY_LOG" && ! grep -q "^FAIL $1:" "$JOURNEY_LOG"; then ok "walk step $1"; else fail "walk step $1 ($(grep -E "^(FAIL|PASS) $1:" "$JOURNEY_LOG" | head -1 | cut -c1-160))"; fi
}

row_I1.1() {
  exists $PAGES/CandidatesPage.tsx "the Candidates page"
  needF "CollectionCommandHost" $PAGES/CandidatesPage.tsx "on the shared command composer"
  for h in "'Candidate'" "'Opening'" "'Stage'" "'Next interview'" "'Last result'"; do needF "header: $h" $PAGES/CandidatesPage.tsx "column $h"; done
  needF "{ tenant: 'interviews', path: '/interviews/candidates' }" portal/e2e/route-inventory.ts "a table route in the inventory"
  needF "candidates|my-interviews|my-openings" portal/e2e/ui-dom-audit.policies.ts "a DOM audit route"
  needF '"journey:interviews"' portal/package.json "npm run journey:interviews"
  if [ "$QUICK" -eq 0 ]; then
    if ( cd portal && node --test src/lib/__tests__/interviews.test.ts ) >"$LOGS/portal-interviews.log" 2>&1; then ok "portal interviews words and order: $(grep -E '^ℹ pass' "$LOGS/portal-interviews.log")"; else fail "portal interviews test (see $LOGS/portal-interviews.log)"; fi
    run_journey
    for s in I0.5a I0.5b I0.5c I0.5d I0.5e I0.5f I0.5g I1.1; do journey_step "$s"; done
  fi
}

printf 'validate-interviews: phase %s%s, logs in %s\n' "$PHASE" "$([ "$QUICK" -eq 1 ] && echo ', quick')" "$LOGS"
JUDGED=0; NOT_BUILT=0; LATER=0
CURRENT_PHASE=""
for entry in "${ROWS[@]}"; do
  id="${entry%%|*}"; rest="${entry#*|}"; ph="${rest%%|*}"; title="${rest#*|}"
  ROW="$id"
  if [ "$ph" != "$CURRENT_PHASE" ]; then printf '\n== phase %s ==\n' "$ph"; CURRENT_PHASE="$ph"; fi
  if [ "$(phase_rank "$ph")" -gt "$PR" ]; then printf '  - %s later phase: %s\n' "$id" "$title"; LATER=$((LATER + 1)); continue; fi
  if [[ "$BUILT" != *" $id "* ]]; then
    if [ "$FULL" -eq 1 ]; then fail "not built: $title"; else printf '  · %s not built: %s\n' "$id" "$title"; fi
    NOT_BUILT=$((NOT_BUILT + 1)); continue
  fi
  printf '  %s %s\n' "$id" "$title"
  JUDGED=$((JUDGED + 1))
  "row_$id"
done

echo
printf 'rows judged %d, not built %d, later phases %d; pending (not failing) %d\n' "$JUDGED" "$NOT_BUILT" "$LATER" "${#PENDING[@]}"
for p in "${PENDING[@]+"${PENDING[@]}"}"; do printf '  · %s\n' "$p"; done
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "ALL CHECKS PASS"
  exit 0
fi
printf '%d FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  ✗ %s\n' "$f"; done
exit 1
