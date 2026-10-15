#!/usr/bin/env bash
# The judge for docs/access-tenant-goal.md — the `access` tenant (requests,
# approvals, provisioning). Exits 0 only when every check in the judged phases
# passes; prints every failing line so one run shows the whole backlog.
#
#   ./scripts/validate-access-tenant.sh --quick          # static checks only
#   ./scripts/validate-access-tenant.sh --phase A0       # A0 incl. routes, pages, journeys
#   ./scripts/validate-access-tenant.sh --phase A3       # + escalation timers and delegation
#   ./scripts/validate-access-tenant.sh                  # everything through E (native PostgreSQL contracts)
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh 2>/dev/null || true
source scripts/lib/journeys.sh 2>/dev/null || true

QUICK=0; PHASE=E
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --phase) ;;
    --phase=*) PHASE="${arg#--phase=}" ;;
    A0|A1|A2|A3|E) PHASE="$arg" ;;
  esac
done
phase_rank() { case "$1" in A0) echo 0;; A1) echo 1;; A2) echo 2;; A3) echo 3;; E) echo 4;; *) echo -1;; esac; }
PR=$(phase_rank "$PHASE")
judged() { [ "$(phase_rank "$1")" -le "$PR" ]; }

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
has()  { grep -qE -- "$1" "$2" 2>/dev/null; }
hasF() { grep -qF -- "$1" "$2" 2>/dev/null; }
need() { if has "$1" "$2"; then ok "$3"; else fail "$3 — not found in $2"; fi; }
needF() { if hasF "$1" "$2"; then ok "$3"; else fail "$3 — not found in $2"; fi; }
exists() { if [ -e "$1" ]; then ok "$2"; else fail "$2 — $1 missing"; fi; }

T=access
ROLES=(requester approver access-admin)
ACTIONS=(ViewAccess RequestAccess DecideAccess ManageAccessCatalog ManageAccessPolicy ProvisionAccess)
CAST=(u-rhea u-omar u-priya)

section "goal + design exist"
exists docs/access-tenant-design.md "design doc"
exists docs/access-tenant-goal.md "goal doc"

section "A0 · registration (the 21 points)"
F=middleware/src/lib/session.ts
need "'$T'" $F "1 TENANTS names $T"
need "$T: \['requester', 'approver', 'access-admin'\]" $F "1 ROLES_BY_TENANT lists the three roles"
for r in "${ROLES[@]}"; do need "'$r'" $F "1 Role union / ROLE_RANK has $r"; done
need "DEMO_EXCLUDED_TENANTS.*'$T'|'$T'.*\]\);" $F "1 demo identity holds no $T grant"
for r in "${ROLES[@]}"; do
  F=middleware/seeds/roles/$T/$r.cedar
  if [ -f "$F" ]; then
    need 'principal\.tenant == "'$T'"' $F "2 $r.cedar conditions on tenant $T"
    need 'principal\.role == "'$r'"' $F "2 $r.cedar conditions on its role"
  else fail "2 $F missing"; fi
done
leak=$(grep -lE "$(IFS='|'; echo "${ACTIONS[*]}")" middleware/seeds/roles/orgiq/*.cedar middleware/seeds/roles/assessment/*.cedar middleware/seeds/roles/social/*.cedar middleware/seeds/roles/pipelines/*.cedar 2>/dev/null)
[ -z "$leak" ] && ok "2 no other tenant's Cedar names an access action" || fail "2 access actions leak into:$leak"
for a in "${ACTIONS[@]}"; do needF "\"$a\"" middleware/seeds/schema.json "3 schema.json declares $a"; needF "'$a'" middleware/src/lib/authz.ts "4 CAPABILITY_ACTIONS lists $a"; done
for r in "${ROLES[@]}"; do need "'?$r'?" middleware/src/lib/role-registry.ts "5 PRESENTATION has $r"; done
need "\('$T', *'Access'\)" schema/identity_schema.sql "6 tenants row"
for u in "${CAST[@]}"; do need "'$u'" schema/identity_schema.sql "6 app_users has $u"; need "'$u'" middleware/src/providers/identity.ts "7 identity fallback has $u"; done
need "'u-operator', *'$T', *'admin'" schema/identity_schema.sql "6 u-operator holds admin in $T"
need "manager_id" schema/access_schema.sql "model: people.manager_id is additive in access_schema.sql"
exists schema/access_schema.sql "model: schema/access_schema.sql"
for t in access_catalog_items access_requests access_request_steps access_policies access_events; do need "CREATE TABLE IF NOT EXISTS $t" schema/access_schema.sql "model: table $t"; done
need "access_schema" schema/load_schema.py "model: load_schema.py registers access_schema.sql"
need "app.use\('/api/$T', *requireTenant\('$T'\)" middleware/src/index.ts "8 /api/$T mounts behind requireTenant('$T')"
ok "9 n/a — the tenant owns no agents"
need "access (catalog|requests|policies)" middleware/src/mock/core/parity/entities.ts "10 parity entities cover the access fixtures"
for f in access-catalog access-requests access-policies; do exists middleware/src/mock/$f.ts "10 mock fixture $f"; done
for F in portal/src/lib/auth.tsx portal/src/components/shell/Layout.tsx portal/src/components/shell/portalCommands.ts; do need "'$T'" $F "11 $F names the tenant"; done
need "$T: '/access/requests'" portal/src/lib/tenantHome.ts "12 tenant home is /access/requests"
need "ACCESS_ENABLED" portal/src/lib/features.ts "13 ACCESS_ENABLED feature flag"
need "ACCESS_ENABLED" portal/src/App.tsx "13 App.tsx honours the flag"
need "tenant: '$T'" portal/src/components/shell/Layout.tsx "14 NAV_ITEMS rows for $T"
need "$T: 'Access'" portal/src/components/shell/Layout.tsx "14 TENANT_LABELS.$T"
need "$T: \['Request', 'Approve', 'Govern', 'System'\]" portal/src/components/shell/portalCommands.ts "15 GROUP_ORDER_BY_TENANT.$T"
n_pal=$(grep -cE "'/access/" portal/src/components/shell/portalCommands.ts 2>/dev/null || echo 0)
[ "${n_pal:-0}" -ge 10 ] && ok "15 ≥10 palette rows ($n_pal)" || fail "15 palette rows for /access/*: ${n_pal:-0} < 10"
need 'path="access"' portal/src/App.tsx "16 App.tsx mounts path=\"access\""
need 'RequireTenant tenant="access"' portal/src/App.tsx "16 under RequireTenant"
need "$T: \{" portal/src/pages/SelectContextPage.tsx "17 TENANT_META.$T"
for u in "${CAST[@]}"; do need "'$u'" portal/src/pages/SelectContextPage.tsx "17 CURATED has $u"; done
need "\[data-tenant=\"$T\"\]" portal/src/app.css "18 light tenant block"
need "data-theme=\"dark\"\]\[data-tenant=\"$T\"\]" portal/src/app.css "18 dark tenant block"
for u in rhea.castellanos omar.haddad priya.venkataraman; do need "$u@orgiq.example" infra/lib/authentication-stack.ts "19 Cognito seedUsers has $u"; done
if grep -qF "'orgiq'\s*,\s*'assessment'\s*\]" scripts/validate-newsroom-removal.sh; then fail "20 retired-tenant judge pins an exact tenant list"; else ok "20 retired-tenant judge pins no tenant list"; fi
need "\`$T\`.*\`requester\`.*\`approver\`.*\`access-admin\`" CLAUDE.md "21 CLAUDE.md names the tenant and roles"
need "access-tenant-goal\.md.*validate-access-tenant\.sh" CLAUDE.md "21 CLAUDE.md docs map lists the judge"
n_val=$(ls scripts/validate-*.sh | wc -l | tr -d ' ')
claimed=$(grep -oE '\(([0-9]+) validators\)' CLAUDE.md | grep -oE '[0-9]+' | head -1)
[ "${claimed:-x}" = "$n_val" ] && ok "21 CLAUDE.md validator count ($claimed) matches scripts/ ($n_val)" || fail "21 CLAUDE.md says (${claimed:-?} validators); scripts/ holds $n_val"
need "$T: 'Access'" portal/src/components/shell/TenantSwitcher.tsx "switcher LABELS.$T"
need "access:req:" middleware/src/lib/tenant-channels.ts "channel family access:req: registered"

section "A0 · routes + pages + policy"
exists middleware/src/routes/access.ts "routes/access.ts"
for p in "/summary" "/catalog" "/requests" "/requests/:id" "/requests/:id/withdraw" "/approvals" "/requests/:id/steps/:step/decide" "/policies" "/audit" "/reviews"; do need "'$p'" middleware/src/routes/access.ts "route $p"; done
exists middleware/src/routes/__tests__/access.test.ts "route tests"
need "decides a request they submitted|own request|self-approv" middleware/src/routes/__tests__/access.test.ts "contract: no self-approval"
need "409" middleware/src/routes/__tests__/access.test.ts "contract: a step is decided once"
exists portal/src/pages/access "pages/access/"
exists portal/src/pages/access/accessSurfaces.ts "accessSurfaces.ts"
need "/access/" portal/e2e/ui-dom-audit.policies.ts "DOM-audit policy classifies /access/* routes"
for f in Catalog Requests Approvals Policies Audit; do
  # bash 3.2 (macOS) has no ${f^}; the page files are named <Surface>Page.tsx
  if ls portal/src/pages/access/*${f}*.tsx >/dev/null 2>&1 && grep -lq "CollectionCommandHost" portal/src/pages/access/*${f}*.tsx 2>/dev/null; then ok "page $f carries the shared composer"; else fail "page $f has no CollectionCommandHost (portal/src/pages/access/*${f}*.tsx)"; fi
done

section "A0 · journeys"
if [ -d docs/access-journeys ]; then
  for r in "${ROLES[@]}"; do
    n=$(ls docs/access-journeys/$r/*.md 2>/dev/null | wc -l | tr -d ' ')
    [ "$n" -ge 8 ] && ok "$r: $n surface logs" || fail "$r: $n of 8 surface logs"
  done
  n=$(ls docs/access-journeys/isolation/*.md 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 7 ] && ok "isolation: $n logs" || fail "isolation: $n of 7 logs (4 inbound + 3 outbound)"
  # The shared freshness rule (docs/journeys.md): a log is stale when a walked route's
  # rendered contract changed since its seal, or it was never sealed.
  JR_TOTAL=0
  jr_freshness docs/access-journeys $(find docs/access-journeys -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' 2>/dev/null | sort)
  if [ "${JR_TOTAL:-0}" = 0 ]; then fail "no access journey logs to judge for freshness"; else jr_report; fi
else fail "docs/access-journeys/ missing"; fi

if judged A1; then
  section "A1 · provisioning, expiry, notifications, thread"
  exists middleware/src/lib/access-provision.ts "lib/access-provision.ts"
  need "grantRole" middleware/src/lib/access-provision.ts "provisions one role through providers/identity grantRole"
  need "bumpSessionEpoch" middleware/src/lib/access-provision.ts "bumps the beneficiary's session epoch"
  exists middleware/src/lib/access-expiry.ts "lib/access-expiry.ts"
  need "replica-fleet|replicaFleet|withFleetLock|hasPeers" middleware/src/lib/access-expiry.ts "sweeper is single-flight across replicas"
  need "tenant: 'access'" middleware/src/lib/social-notify.ts "bell items for access"
  exists middleware/src/lib/__tests__/access-provision.test.ts "provisioning contracts"
  exists middleware/src/lib/__tests__/access-expiry.test.ts "expiry contracts"
fi
if judged A2; then
  section "A2 · policies and reviews"
  need "sod|separation" middleware/src/routes/access.ts "SoD evaluation at submit/provision"
  need "access_reviews" schema/access_schema.sql "reviews table"
  need "'/reviews/:id'" middleware/src/routes/access.ts "review routes"
fi
if judged A3; then
  section "A3 · escalation timers and delegation (2026-10-14)"
  S=schema/access_schema.sql
  need "CREATE TABLE IF NOT EXISTS access_delegations" $S "model: table access_delegations"
  need "access_delegations_not_self" $S "model: a delegation is never to oneself (CHECK)"
  for c in current_since escalation_level escalated_at delegated_from; do need "ADD COLUMN IF NOT EXISTS $c" $S "model: access_request_steps.$c is additive"; done
  need "'escalated', 'delegated', 'delegation-ended'" $S "model: event kinds escalated / delegated / delegation-ended"
  need "CREATE TRIGGER access_step_decision_guard" $S "model: the table refuses self-decision and re-decision (trigger)"
  need "access_requests_one_open_idx" $S "model: one open request per beneficiary and item (partial unique index)"
  F=middleware/src/lib/access-escalation.ts
  exists $F "lib/access-escalation.ts"
  need "ACCESS_ESCALATION_SLA_MS" $F "escalation SLA is configured (ACCESS_ESCALATION_SLA_MS)"
  need "replicaFleet|withLock" $F "escalation timer is single-flight across replicas"
  need "casStep" $F "escalation claims the step once per level"
  need "kind: 'escalated'" $F "escalation records an event and rings the bell"
  need "startAccessEscalationSweeper\\(\\)" middleware/src/index.ts "index.ts starts the escalation timer"
  need "escalated:" middleware/src/lib/social-notify.ts "bell copy for an escalation"
  need "notifyAccessDelegation" middleware/src/lib/social-notify.ts "bell item for a delegation"
  F=middleware/src/lib/access/delegation.ts
  exists $F "lib/access/delegation.ts"
  need "to yourself" $F "delegation: never to oneself"
  need "no deciding role" $F "delegation: only to an eligible approver"
  need "never passed on" $F "delegation: no chains"
  need "is a party to" $F "delegation: never to the requester of a request waiting on the delegator"
  need "onBehalfOf" middleware/src/lib/access/chain.ts "resolver: delegates decide on behalf of their delegator"
  need "kind === 'access-admin' && !" middleware/src/lib/access/chain.ts "resolver: an access-admin step only to an access-admin delegate (SoD)"
  for p in "/delegations" "/delegations/:id/end" "/delegates"; do need "'$p'" middleware/src/routes/access.ts "route $p"; done
  exists middleware/src/mock/access-delegations.ts "mock fixture access-delegations"
  need "access delegations" middleware/src/mock/core/parity/entities.ts "parity entity covers access delegations"
  exists middleware/src/routes/__tests__/access-escalation-delegation.test.ts "route contracts: escalation + delegation"
  exists middleware/src/lib/__tests__/access-escalation.test.ts "lib contracts: escalation timer"
  exists middleware/src/lib/access/__tests__/delegation.test.ts "lib contracts: delegation rules + resolver"
  need "two replicas escalate a step once" middleware/src/routes/__tests__/access-escalation-delegation.test.ts "contract: escalation single-flight across replicas"
  need "PersonPicker" portal/src/pages/access/RequestNewPage.tsx "wizard picks the person with the library PersonPicker"
  need "PersonPicker" portal/src/pages/access/SettingsPage.tsx "delegation picks the delegate with the library PersonPicker"
  if grep -lE "<select|<input" portal/src/pages/access/*.tsx >/dev/null 2>&1; then fail "a native <select>/<input> in portal/src/pages/access: $(grep -lE '<select|<input' portal/src/pages/access/*.tsx | tr '\n' ' ')"; else ok "no native select/input in the access pages"; fi
  need "PersonPicker" portal/node_modules/@connorhoehnslalom/ui-components/dist/shared.d.ts "installed ui-components dist exports PersonPicker"
  exists portal/src/pages/access/__tests__/accessDelegation.test.ts "portal contracts: escalation lines + delegation form"
fi
if judged E; then
  section "E · evidence"
  ls docs/realtime-validation/*/access-tenant.md >/dev/null 2>&1 && ok "gate record exists" || fail "docs/realtime-validation/<date>/access-tenant.md missing"
  # Native PostgreSQL contracts (2026-10-14): the cluster statements over the unmodified schema file.
  F=middleware/src/lib/access/sql.ts
  exists $F "lib/access/sql.ts (the cluster statements)"
  for k in INSERT_REQUEST_SQL DECIDE_STEP_SQL PROVISION_CLAIM_SQL GRANT_ROLE_SQL END_GRANT_SQL WARN_EXPIRY_SQL ESCALATE_STEP_SQL END_DELEGATION_SQL; do need "export const $k" $F "statement $k"; done
  PGT=middleware/src/lib/access/__tests__/access-postgres.test.ts
  exists $PGT "native PostgreSQL contract suite"
  for c in "twelve concurrent approvers" "nobody decides a request they submitted" "provisioning is idempotent" "expiry sweep is single-flight" "escalates once per level" "delete-and-reinsert does"; do needF "$c" $PGT "PG contract: $c"; done
  REC=$(ls -t docs/realtime-validation/*/access-postgres.md 2>/dev/null | head -1)
  if [ -n "$REC" ] && grep -qE "Tests: +[0-9]+ passed, [0-9]+ total" "$REC" && ! grep -qE "Tests: +[0-9]+ failed" "$REC"; then ok "PG contract record: $REC"; else fail "docs/realtime-validation/<date>/access-postgres.md missing or not all passing"; fi
  if [ -n "$REC" ] && [ "$F" -nt "$REC" -o schema/access_schema.sql -nt "$REC" -o "$PGT" -nt "$REC" ] && [ "${ACCESS_PG_IGNORE_MTIME:-0}" != 1 ]; then
    if git diff --quiet HEAD -- "$F" schema/access_schema.sql "$PGT" 2>/dev/null && git log -1 --format=%ct -- "$REC" >/dev/null 2>&1 && [ "$(git log -1 --format=%ct -- "$REC")" -ge "$(git log -1 --format=%ct -- "$F" schema/access_schema.sql "$PGT")" ]; then ok "PG contract record is as new as the statements it proves (git)"; else fail "PG contract record is older than lib/access/sql.ts, access_schema.sql or the suite — re-run it"; fi
  else ok "PG contract record is as new as the statements it proves"; fi
  # Run it live when the dedicated container is up (never another container; never Aurora).
  PGC=orgiq-access-postgres-acceptance
  DOCKER=${ORGIQ_DOCKER:-colima ssh -- sudo docker}
  if [ "$QUICK" -eq 0 ] && $DOCKER inspect --format '{{index .Config.Labels "orgiq.validation"}}' $PGC 2>/dev/null | grep -qx access-postgres; then
    if (cd middleware && REAL_ACCESS_POSTGRES=1 ORGIQ_ACCESS_POSTGRES_CONTAINER=$PGC ORGIQ_DOCKER="$DOCKER" npx jest src/lib/access/__tests__/access-postgres.test.ts >/tmp/access-judge-pg.log 2>&1); then ok "native PostgreSQL contracts ($(grep -oE 'Tests:.*total' /tmp/access-judge-pg.log))"; else fail "native PostgreSQL contracts red"; grep -E '✕' /tmp/access-judge-pg.log | head -5 | while IFS= read -r l; do note "$l"; done; fi
  else note "dedicated container $PGC not running: judged on the record above"; fi
fi

if [ "$QUICK" -eq 0 ]; then
  section "contracts (access suites)"
  if (cd middleware && npx jest src/routes/__tests__/access src/lib/access src/lib/__tests__/access- src/routes/__tests__/agent-loop-access >/tmp/access-judge-jest.log 2>&1); then ok "middleware access jest ($(grep -oE 'Tests:.*total' /tmp/access-judge-jest.log | tail -1))"; else fail "middleware access jest red"; grep -E '^(FAIL|  ●)' /tmp/access-judge-jest.log | head -5 | while IFS= read -r l; do note "$l"; done; fi
  if (cd portal && node --test src/pages/access/__tests__/*.test.ts e2e/ui-dom-audit.policies.test.ts >/tmp/access-judge-portal.log 2>&1); then ok "portal access node tests ($(grep -E '^ℹ pass' /tmp/access-judge-portal.log))"; else fail "portal access node tests red"; grep -E '^not ok|✖' /tmp/access-judge-portal.log | head -5 | while IFS= read -r l; do note "$l"; done; fi
  section "neighbour judges"
  for j in route-coverage nav-parity component-discipline honest-numbers; do
    if ./scripts/validate-$j.sh --quick >/tmp/access-judge-$j.log 2>&1 || ./scripts/validate-$j.sh >/tmp/access-judge-$j.log 2>&1; then ok "validate-$j.sh"; else fail "validate-$j.sh red"; grep -E '✗' /tmp/access-judge-$j.log | head -5 | while IFS= read -r l; do note "$l"; done; fi
  done
  if ./scripts/validate-mock-floor.sh --quick >/tmp/access-judge-mock.log 2>&1; then ok "validate-mock-floor.sh --quick"; else fail "validate-mock-floor.sh --quick red"; fi
  section "DOM audit (tenant $T, strict coverage)"
  if npm --prefix portal run audit:ui -- --tenant $T --all --strict-coverage --themes light,dark --widths 1440,900 --out .scratch/ui-dom-audit-access >/tmp/access-judge-audit.log 2>&1; then ok "$(head -1 .scratch/ui-dom-audit-access/summary.txt 2>/dev/null)"; else fail "DOM audit red: $(head -1 .scratch/ui-dom-audit-access/summary.txt 2>/dev/null || echo 'did not run')"; fi
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS — the $T tenant meets docs/access-tenant-goal.md through phase $PHASE."; exit 0; fi
echo "${#FAILS[@]} CHECK(S) FAILING (judged through phase $PHASE):"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
