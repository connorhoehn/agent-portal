#!/usr/bin/env bash
# The judge for docs/access-tenant-goal.md — the `access` tenant (requests,
# approvals, provisioning). Exits 0 only when every check in the judged phases
# passes; prints every failing line so one run shows the whole backlog.
#
#   ./scripts/validate-access-tenant.sh --quick          # static checks only
#   ./scripts/validate-access-tenant.sh --phase A0       # A0 incl. routes, pages, journeys
#   ./scripts/validate-access-tenant.sh                  # everything through E
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
    A0|A1|A2|E) PHASE="$arg" ;;
  esac
done
phase_rank() { case "$1" in A0) echo 0;; A1) echo 1;; A2) echo 2;; E) echo 3;; *) echo -1;; esac; }
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
  need "setGrants" middleware/src/lib/access-provision.ts "provisions through providers/identity setGrants"
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
if judged E; then
  section "E · evidence"
  ls docs/realtime-validation/*/access-tenant.md >/dev/null 2>&1 && ok "gate record exists" || fail "docs/realtime-validation/<date>/access-tenant.md missing"
fi

if [ "$QUICK" -eq 0 ]; then
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
