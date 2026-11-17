# Phase 0 rows. Sourced by scripts/validate-interviews.sh (see the note at the top of that script).

row_I0.1() {
  exists scripts/validate-interviews.sh "the judge is scripts/validate-interviews.sh"
  needF '--quick) QUICK=1' scripts/validate-interviews.sh "it takes --quick"
  needF 'PR=$(phase_rank "$PHASE")' scripts/validate-interviews.sh "phases nest by rank"
  ok "it runs: every failing check prints with its row, and the last line is the count"
}

row_I0.2() {
  local f
  if node -e "const m=require('./tenants/manifest.json');const t=m.tenants.find(x=>x.id==='$T');process.exit(t&&t.displayName==='Candidates'&&t.apiPrefix==='/api/interviews'&&t.portalRoot==='/interviews'&&JSON.stringify(t.roles)==='[\"recruiter\",\"interviewer\",\"hiring-manager\"]'&&t.channelPartition===true&&t.demoGrant===false?0:1)"; then
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
  if has "id: 'interviews:interview', tenant: 'interviews'" $MW/lib/tenant-channels.ts && has "read: tenantOnly\('interviews', 'ViewInterviews'\)" $MW/lib/tenant-channels.ts; then ok "the interviews channel family exists (row I2.2) and is the guarded one: the tenant's own members with ViewInterviews read it, nobody writes"; else fail "the interviews channel family is missing or no longer guarded by ViewInterviews"; fi
  needF "interviews: 'Candidates'" $MW/lib/social-notify.ts "notification label"
  needF "interviews: ['/interviews/']" $MW/lib/social-notify.ts "notification paths stay inside /interviews/"
  if grep -E "^export const VOICE_TENANTS" $MW/lib/voice/catalogue.ts | grep -q interviews; then fail "VOICE_TENANTS lists interviews, but its roles hold no VoiceNavigate"; else ok "voice: interviews is not a voice tenant (VOICE_TENANTS), and says why"; fi
  for p in candidates my-openings my-interviews; do needF "id: '$p', path: '/interviews/$p'" $MW/lib/voice/catalogue.ts "voice page list mirrors the palette: $p"; done
  if node scripts/voice/inventory.mjs --check >"$LOGS/voice-inventory.log" 2>&1; then ok "voice inventory is current (docs/voice-tool-inventory.json)"; else fail "voice inventory: $(tail -1 "$LOGS/voice-inventory.log")"; fi
  needF 'path="interviews"' portal/src/App.tsx "App.tsx mounts the /interviews tree"
  needF '<RequireTenant tenant="interviews" fallback={<OtherWorkspace tenant="interviews" />}>' portal/src/App.tsx "under RequireTenant, refusing with the other-workspace page"
  needF "INTERVIEWS_ENABLED" portal/src/lib/features.ts "portal flag INTERVIEWS_ENABLED (VITE_ENABLE_INTERVIEWS)"
  needF "INTERVIEWS_ENABLED ?" portal/src/App.tsx "App.tsx honours the portal flag"
  n=$(count "tenant: 'interviews', group:" portal/src/components/shell/Layout.tsx); if [ "${n:-0}" -ge 3 ]; then ok "rail rows for interviews ($n: the three homes and the rows later lanes add)"; else fail "rail rows for interviews: $n, want at least the three homes"; fi
  needF "interviews: 'Candidates'" portal/src/components/shell/Layout.tsx "TENANT_LABELS.interviews"
  needF "interviews: ['Hire', 'Interview', 'System']" portal/src/components/shell/portalCommands.ts "palette group order"
  want_count "tenant: 'interviews', group:" portal/src/components/shell/portalCommands.ts 4 "palette rows for interviews: Candidates, My openings, My interviews and Upcoming (the recruiter's own page, the fourth), each a real destination"
  needF "interviews: { label: 'Candidates'" portal/src/pages/SelectContextPage.tsx "the picker's tile"
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

built_row I0.1 row_I0.1
built_row I0.2 row_I0.2
built_row I0.3 row_I0.3
built_row I0.4 row_I0.4
built_row I0.5 row_I0.5
