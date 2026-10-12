#!/usr/bin/env bash
# validate-pipelines-tenant.sh — the definition of done for the `pipelines`
# tenant (docs/pipelines-tenant-goal.md), as a script. This is the ONLY judge:
# nothing about the tenant is done until a line below says so. Every failing
# check prints, not just the first, so one run is the whole backlog.
#
# The design is docs/social-tenant-design.md §5–§7 (lanes P0, P1, P2, E); the
# registration checklist is docs/social-tenant-and-pipelines-research-2026-09-29.md
# §A.4 (21 points), the model and crosswalk are its §D.3.
#
# Usage:  scripts/validate-pipelines-tenant.sh                # every phase (P0 → E)
#         scripts/validate-pipelines-tenant.sh --phase=P0     # judge one lane: P0 | P1 | P2 | E
#         scripts/validate-pipelines-tenant.sh --quick        # skip the slow suites (jest, vite build, venv, neighbour validators)
#         scripts/validate-pipelines-tenant.sh --no-time      # skip the optional time gate (PIPELINES_UNTIL=HH)
#         scripts/validate-pipelines-tenant.sh --seal         # retired: scripts/journeys/seal.sh <dir> seals, after a walk
#
# Phases are cumulative: --phase=P2 judges P0, P1 and P2. The default is E,
# i.e. the whole definition of done. A phase beyond the one asked for is
# printed as skipped and does not count.
#
# Exit 0 only when EVERY judged check passes.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state

QUICK=0; NO_TIME=0; PHASE=E
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    --no-time) NO_TIME=1 ;;
    --seal) echo "--seal is retired: walk the logs, then run scripts/journeys/seal.sh <dir> (docs/journeys.md)" >&2; exit 2 ;;
    --phase=*) PHASE="${a#--phase=}" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a (see --help)"; exit 2 ;;
  esac
done
phase_rank() { case "$1" in P0) echo 0;; P1) echo 1;; P2) echo 2;; E) echo 3;; *) echo -1;; esac; }
PR=$(phase_rank "$PHASE")
[ "$PR" -ge 0 ] || { echo "unknown phase '$PHASE' (P0 | P1 | P2 | E)"; exit 2; }
judged() { [ "$(phase_rank "$1")" -le "$PR" ]; }

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
skipped_phase() { printf '\n== %s ==\n  – skipped (--phase=%s stops before %s)\n' "$2" "$PHASE" "$1"; }
has() { grep -qE -- "$1" "$2" 2>/dev/null; }
# need <regex> <file> <what>: one registration fact, one line of output.
need() { if has "$1" "$2"; then ok "$3"; else fail "$3 — not found in $2"; fi; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

T=pipelines
ROLES=(author operator pipeline-admin)
ACTIONS=(ViewPipelines AuthorDefinition RunPipeline ApproveStep CancelRun ManagePipelineConfig)
# The cast. Named in docs/pipelines-tenant-goal.md §"Cast"; ids chosen not to
# collide with the fourteen existing app_users nor the social cast.
CAST_IDS=(u-ines u-kofi u-dara)
CAST_ROLE=(author operator pipeline-admin)
CAST_EMAIL=(ines.moreau@orgiq.example kofi.mensah@orgiq.example dara.whitfield@orgiq.example)
CAST_NAME=("Ines Moreau" "Kofi Mensah" "Dara Whitfield")

SESSION=middleware/src/lib/session.ts
AUTHZ=middleware/src/lib/authz.ts
CEDAR=middleware/seeds/roles/$T
SCHEMA_JSON=middleware/seeds/schema.json
REGISTRY=middleware/src/lib/role-registry.ts
ID_SQL=schema/identity_schema.sql
ID_TS=middleware/src/providers/identity.ts
INDEX=middleware/src/index.ts
ENTITIES=middleware/src/mock/core/parity/entities.ts
PROJ=middleware/src/lib/pipeline-runs.ts
PROJ_TEST=middleware/src/lib/__tests__/pipeline-runs.projection.test.ts
ROUTER=middleware/src/routes/pipelines.ts
ROUTE_TESTS=middleware/src/routes/__tests__
ROUTE_TEST=$ROUTE_TESTS/pipelines.test.ts
AUTH_TSX=portal/src/lib/auth.tsx
LAYOUT=portal/src/components/shell/Layout.tsx
CMDS=portal/src/components/shell/portalCommands.ts
HOME_TS=portal/src/lib/tenantHome.ts
FEATURES=portal/src/lib/features.ts
APP=portal/src/App.tsx
PICKER=portal/src/pages/SelectContextPage.tsx
CSS=portal/src/app.css
COGNITO=infra/lib/authentication-stack.ts
PAGES=portal/src/pages/$T
BOT_DETAIL=portal/src/pages/bots/BotDetailPage.tsx
JDIR=docs/pipelines-journeys
PY=.venv-synth/bin/python

# The social tenant is being registered in parallel (lane S0). Its isolation
# walks are owed only once it exists — judged by the same array this file reads.
SOCIAL=0; grep -qE "TENANTS\s*=\s*\[[^]]*'social'" "$SESSION" 2>/dev/null && SOCIAL=1

run_jest() { # run_jest <label> <test paths...> — targeted, never the whole suite
  local label="$1"; shift
  local missing=""
  for t in "$@"; do [ -f "$t" ] || missing="$missing $t"; done
  if [ -n "$missing" ]; then fail "$label — test file(s) missing:$missing"; return; fi
  if [ "$QUICK" = 1 ]; then ok "$label — test present (run skipped: --quick)"; return; fi
  local rel=(); for t in "$@"; do rel+=("${t#middleware/}"); done
  if (cd middleware && npx jest --config jest.config.cjs --silent "${rel[@]}") >"$TMP/jest.log" 2>&1; then ok "$label — green"
  else fail "$label — failing"; grep -E '✕|●' "$TMP/jest.log" | head -8 | sed 's/^/      /'; fi
}

neighbour() { # neighbour <script> <args...> — another judge must stay green; its own output stays in $TMP
  local s="$1"; shift
  if jg_judge "$s" "$@" >"$TMP/$s.log" 2>&1; then ok "$s${*:+ $*} exits 0"
  else fail "$s${*:+ $*} is red"; grep -E 'CHECK\(S\) FAILING' "$TMP/$s.log" | head -1 | sed 's/^/      /'; grep -E '^  - ' "$TMP/$s.log" | head -4 | sed 's/^/      /'; fi
}

# ═════════════════════════════════════════════════════════════════════════════
# P0 — registration (the 21 points of research §A.4) + the projection + the
#      routes + the Runs/Artifacts pages + the maintenance-bot slice.
# ═════════════════════════════════════════════════════════════════════════════

section "P0 · registration — server (A.4 rows 1–10)"
# 1. session.ts
need "TENANTS\s*=\s*\[[^]]*'$T'" "$SESSION" "A.4#1 TENANTS lists '$T'"
need "^\s*$T:\s*\['author',\s*'operator',\s*'pipeline-admin'\]" "$SESSION" "A.4#1 ROLES_BY_TENANT.$T = [author, operator, pipeline-admin]"
role_line=$(grep -E '^export type Role\s*=' "$SESSION" 2>/dev/null)
r_miss=""; for r in "${ROLES[@]}"; do printf '%s' "$role_line" | grep -qF "'$r'" || r_miss="$r_miss $r"; done
[ -z "$r_miss" ] && ok "A.4#1 Role union carries the three roles" || fail "A.4#1 Role union in $SESSION is missing:$r_miss"
rank_block=$(awk '/const ROLE_RANK/,/};/' "$SESSION" 2>/dev/null)
k_miss=""; for r in author operator "'pipeline-admin'"; do printf '%s' "$rank_block" | grep -qE "(^|[ {,])$r:" || k_miss="$k_miss $r"; done
[ -z "$k_miss" ] && ok "A.4#1 ROLE_RANK ranks the three roles" || fail "A.4#1 ROLE_RANK in $SESSION has no rank for:$k_miss"

# 2. Cedar — one file per role, tenant-conditioned, with the separation-of-duties forbids.
for r in "${ROLES[@]}"; do
  f="$CEDAR/$r.cedar"
  if [ ! -f "$f" ]; then fail "A.4#2 $f missing"; continue; fi
  has "principal\.role == \"$r\" && principal has tenant && principal\.tenant == \"$T\"" "$f" \
    && ok "A.4#2 $r.cedar permits only inside the $T tenant" || fail "A.4#2 $f: permit is not conditioned on principal.role == \"$r\" && principal.tenant == \"$T\""
  has 'OrgIQ::Action::"ViewPipelines"' "$f" || fail "A.4#2 $f does not permit ViewPipelines"
done
forbid_of() { awk '/^forbid/{p=1} p{print} /;/{if(p){p=0}}' "$1" 2>/dev/null; }
permit_of() { awk '/^permit/{p=1} p{print} /;/{if(p){p=0}}' "$1" 2>/dev/null; }
check_forbids() { # <role> <must-forbid...>
  local r="$1"; shift; local f="$CEDAR/$r.cedar"; [ -f "$f" ] || return
  local fb; fb=$(forbid_of "$f"); local miss=""
  for a in "$@"; do printf '%s' "$fb" | grep -qF "\"$a\"" || miss="$miss $a"; done
  [ -z "$miss" ] && ok "A.4#2 $r forbids $* (separation of duties)" || fail "A.4#2 $f must forbid:$miss"
}
check_permits() { # <role> <must-permit...>
  local r="$1"; shift; local f="$CEDAR/$r.cedar"; [ -f "$f" ] || return
  local pm; pm=$(permit_of "$f"); local miss=""
  for a in "$@"; do printf '%s' "$pm" | grep -qF "\"$a\"" || miss="$miss $a"; done
  [ -z "$miss" ] && ok "A.4#2 $r permits $*" || fail "A.4#2 $f must permit:$miss"
}
# author writes and dry-runs definitions; never approves, cancels or configures.
check_permits author ViewPipelines AuthorDefinition RunPipeline
check_forbids author ApproveStep CancelRun ManagePipelineConfig
# operator runs, approves, cancels; never writes the definition it approves, never configures.
check_permits operator ViewPipelines RunPipeline ApproveStep CancelRun
check_forbids operator AuthorDefinition ManagePipelineConfig
# pipeline-admin = operator + configuration + the tenant's users; top of the ladder, no forbid on config.
check_permits pipeline-admin ViewPipelines RunPipeline ApproveStep CancelRun ManagePipelineConfig ManageUsers
if [ -f "$CEDAR/pipeline-admin.cedar" ] && forbid_of "$CEDAR/pipeline-admin.cedar" | grep -qF '"ManagePipelineConfig"'; then fail "A.4#2 pipeline-admin.cedar forbids ManagePipelineConfig — it is the role that holds it"; fi
leak=$(grep -lE "\"($(IFS='|'; echo "${ACTIONS[*]}"))\"" middleware/seeds/roles/orgiq/*.cedar middleware/seeds/roles/assessment/*.cedar 2>/dev/null | tr '\n' ' ')
[ -z "$leak" ] && ok "A.4#2 no orgiq/assessment role is permitted a pipelines action" || fail "A.4#2 pipelines actions leak into other tenants' Cedar: $leak"

# 3. schema.json, 4. CAPABILITY_ACTIONS
cap_block=$(awk '/export const CAPABILITY_ACTIONS/,/\] as const/' "$AUTHZ" 2>/dev/null)
s_miss=""; c_miss=""
for a in "${ACTIONS[@]}"; do
  has "\"$a\"\s*:" "$SCHEMA_JSON" || s_miss="$s_miss $a"
  printf '%s' "$cap_block" | grep -qF "'$a'" || c_miss="$c_miss $a"
done
[ -z "$s_miss" ] && ok "A.4#3 schema.json declares the six actions" || fail "A.4#3 $SCHEMA_JSON is missing actions:$s_miss"
[ -z "$c_miss" ] && ok "A.4#4 CAPABILITY_ACTIONS lists the six actions" || fail "A.4#4 CAPABILITY_ACTIONS ($AUTHZ) is missing:$c_miss (an unlisted action hides its control for every role)"

# 5. role-registry
p_miss=""; for k in "author" "operator" "'pipeline-admin'"; do has "^\s*$k:\s*\{\s*label:" "$REGISTRY" || p_miss="$p_miss $k"; done
[ -z "$p_miss" ] && ok "A.4#5 role-registry PRESENTATION labels the three roles" || fail "A.4#5 $REGISTRY PRESENTATION missing:$p_miss"

# 6. identity seed, 7. identity fallback
need "\('$T',\s*'Pipelines'\)" "$ID_SQL" "A.4#6 identity_schema.sql seeds the '$T' tenant row"
need "\{ id: '$T', displayName: 'Pipelines'" "$ID_TS" "A.4#7 FALLBACK_TENANTS carries '$T'"
for i in 0 1 2; do
  u=${CAST_IDS[$i]}; r=${CAST_ROLE[$i]}; e=${CAST_EMAIL[$i]}
  has "\('$u',\s*'${CAST_NAME[$i]}',\s*'$e'" "$ID_SQL" && has "\('$u',\s*'$T',\s*'$r'\)" "$ID_SQL" \
    && ok "A.4#6 $u (${CAST_NAME[$i]}, $r) seeded with its grant" || fail "A.4#6 $ID_SQL: app_users row ('$u', '${CAST_NAME[$i]}', '$e', …) and grant ('$u', '$T', '$r') required"
  has "id: '$u'.*email: '$e'" "$ID_TS" && has "grants: \{ $T: \['$r'\] \}" "$ID_TS" \
    && ok "A.4#7 fallback mirrors $u with grants { $T: ['$r'] } only" || fail "A.4#7 $ID_TS FALLBACK_USERS: $u must carry email $e and grants { $T: ['$r'] } (no other tenant — the outbound walks need a pure identity)"
done
has "\('u-operator',\s*'$T',\s*'admin'\)" "$ID_SQL" && has "id: 'u-operator'.*" "$ID_TS" && awk "/id: 'u-operator'/{getline n; print \$0 n}" "$ID_TS" | grep -qE "$T: \['admin'\]" \
  && ok "A.4#6/7 u-operator holds admin in $T (seed + fallback)" || fail "A.4#6/7 u-operator needs an admin grant in $T in both $ID_SQL and $ID_TS"

# 8. route mount
need "app\.use\('/api/$T',\s*requireTenant\('$T'\)" "$INDEX" "A.4#8 /api/$T mounted under requireTenant('$T')"
# 9. agent↔tenant map: not applicable — the tenant owns no agents (goal doc §Registration, row 9).
ok "A.4#9 agent↔tenant map — n/a (pipelines owns no agents; recorded in the goal doc)"
# 10. mock fixtures + parity pin
need "name: 'tenants'" "$ENTITIES" "A.4#10 tenants entity still pinned (it reads listTenants(), so it now covers '$T')"
need "name: 'pipeline runs'" "$ENTITIES" "A.4#10 parity entity 'pipeline runs' pins the projection mock ↔ SQL seed"
has "pipeline-runs" "$ENTITIES" || fail "A.4#10 $ENTITIES: the 'pipeline runs' entity must read lib/pipeline-runs (mock rows = the projection)"

section "P0 · registration — portal (A.4 rows 11–18)"
need "export type Tenant = [^;]*'$T'" "$AUTH_TSX" "A.4#11 auth.tsx Tenant union carries '$T'"
need "^type Tenant = [^;]*'$T'" "$LAYOUT" "A.4#11 Layout.tsx Tenant union carries '$T'"
need "Tenant = [^;]*'$T'" "$CMDS" "A.4#11 portalCommands.ts Tenant union carries '$T'"
need "^\s*$T:\s*'/$T/runs'" "$HOME_TS" "A.4#12 TENANT_HOME.$T = '/$T/runs' (the front door)"
ok "A.4#12 tenantCaches — no tenant-scoped key is required by the design; any key a page adds must be listed (grep below)"
if grep -rqE "localStorage\.(setItem|getItem)\(['\"]pipelines\." "$PAGES" 2>/dev/null; then
  keys=$(grep -rhoE "localStorage\.(setItem|getItem)\(['\"]pipelines\.[A-Za-z0-9_.-]+" "$PAGES" | grep -oE "pipelines\.[A-Za-z0-9_.-]+" | sort -u)
  for k in $keys; do has "'$k'" portal/src/lib/tenantCaches.ts || fail "A.4#12 localStorage key '$k' is not cleared by tenantCaches.ts"; done
fi
need "VITE_ENABLE_PIPELINES" "$FEATURES" "A.4#13 VITE_ENABLE_PIPELINES flag in features.ts"
need "PIPELINES_ENABLED" "$APP" "A.4#13 App.tsx honours PIPELINES_ENABLED"
nav_rows=$(grep -E "tenant: '$T'" "$LAYOUT" 2>/dev/null)
g_miss=""; for g in Catalog Runs Sources System; do printf '%s' "$nav_rows" | grep -qF "group: '$g'" || g_miss="$g_miss $g"; done
[ -n "$nav_rows" ] && [ -z "$g_miss" ] && ok "A.4#14 NAV_ITEMS carry $T rows in Catalog / Runs / Sources / System" || fail "A.4#14 $LAYOUT NAV_ITEMS: no tenant: '$T' row in group(s):${g_miss:- (none at all)}"
need "^\s*$T:\s*'Pipelines'" "$LAYOUT" "A.4#14 TENANT_LABELS.$T = 'Pipelines'"
need "^\s*$T:\s*\['Catalog',\s*'Runs',\s*'Sources',\s*'System'\]" "$CMDS" "A.4#15 GROUP_ORDER_BY_TENANT.$T = [Catalog, Runs, Sources, System]"
pal=$(grep -c "tenant: '$T'" "$CMDS" 2>/dev/null); pal=${pal:-0}
[ "$pal" -ge 10 ] && ok "A.4#15 command palette knows $pal $T pages" || fail "A.4#15 command palette lists $pal $T pages (expect ≥10)"
p_miss=""
for p in definitions runbooks runs approvals artifacts agents bots commands configuration; do
  grep -E "tenant: '$T'" "$CMDS" 2>/dev/null | grep -qF "'/$T/$p'" || p_miss="$p_miss /$T/$p"
done
[ -z "$p_miss" ] && ok "A.4#15 palette rows cover the nine $T pages of design §5.3" || fail "A.4#15 palette missing:$p_miss"
need "RequireTenant tenant=\"$T\"" "$APP" "A.4#16 /$T/* route tree under RequireTenant tenant=\"$T\""
need "path=\"$T\"" "$APP" "A.4#16 App.tsx mounts path=\"$T\""
need "^\s*$T:\s*\{\s*label: 'Pipelines'" "$PICKER" "A.4#17 picker TENANT_META.$T"
rm_miss=""; for k in "author" "operator" "'pipeline-admin'"; do awk '/const ROLE_META/,/^};/' "$PICKER" 2>/dev/null | grep -qE "^\s*$k:" || rm_miss="$rm_miss $k"; done
[ -z "$rm_miss" ] && ok "A.4#17 picker ROLE_META labels the three roles" || fail "A.4#17 $PICKER ROLE_META missing:$rm_miss"
cu_miss=""; for u in "${CAST_IDS[@]}"; do has "\{ id: '$u'," "$PICKER" || cu_miss="$cu_miss $u"; done
[ -z "$cu_miss" ] && ok "A.4#17 picker CURATED cast includes ${CAST_IDS[*]}" || fail "A.4#17 $PICKER CURATED missing:$cu_miss"
need "tenant === '$T'" "$PICKER" "A.4#17 TenantMark draws a $T glyph"
need "^\[data-tenant=\"$T\"\]" "$CSS" "A.4#18 app.css [data-tenant=\"$T\"] light tokens"
need "html\[data-theme=\"dark\"\]\[data-tenant=\"$T\"\]" "$CSS" "A.4#18 app.css dark tokens for $T"

section "P0 · registration — infra, validators, docs (A.4 rows 19–21)"
for i in 0 1 2; do need "email: '${CAST_EMAIL[$i]}'" "$COGNITO" "A.4#19 Cognito seedUsers carries ${CAST_EMAIL[$i]}"; done
# The retired-tenant judge (research §A.3). Its name is assembled rather than
# spelled because that judge fails any script that spells the retired
# tenant's name — including this one.
RETIRED_JUDGE="validate-$(printf 'news%s' room)-removal.sh"
# -F on purpose: these are the literal regex texts that judge carries today;
# their presence is the exact-two-tenants pin that must go.
if grep -qF "'orgiq'\s*,\s*'assessment'\s*\]" "scripts/$RETIRED_JUDGE" || grep -qF "'orgiq'\s*\|\s*'assessment'\"" "scripts/$RETIRED_JUDGE"; then
  fail "A.4#20 scripts/$RETIRED_JUDGE still pins exactly two tenants (re-point it at 'the retired tenant is absent', research §A.3)"
else ok "A.4#20 $RETIRED_JUDGE no longer pins an exact tenant list"; fi
[ -f docs/pipelines-tenant-goal.md ] && ok "A.4#20 docs/pipelines-tenant-goal.md exists" || fail "A.4#20 docs/pipelines-tenant-goal.md missing"
need "\`$T\`.*\`author\`.*\`operator\`.*\`pipeline-admin\`" CLAUDE.md "A.4#21 CLAUDE.md names the $T tenant and its roles"
need "pipelines-tenant-goal\.md.*validate-pipelines-tenant\.sh" CLAUDE.md "A.4#21 CLAUDE.md docs map lists pipelines-tenant-goal.md → validate-pipelines-tenant.sh"
n_val=$(ls scripts/validate-*.sh | wc -l | tr -d ' ')
claimed=$(grep -oE '\(([0-9]+) validators\)' CLAUDE.md | grep -oE '[0-9]+' | head -1)
[ "${claimed:-x}" = "$n_val" ] && ok "A.4#21 CLAUDE.md validator count ($claimed) matches scripts/ ($n_val)" || fail "A.4#21 CLAUDE.md says (${claimed:-?} validators); scripts/ holds $n_val"
has "second tenant" docs/assessment-tenant.md && head -5 docs/assessment-tenant.md | grep -qi "second tenant" && fail "A.4#21 docs/assessment-tenant.md:3 still calls assessment 'the second tenant' without naming the others" || ok "A.4#21 docs/assessment-tenant.md header no longer implies two tenants"

section "P0 · the projection ($PROJ)"
if [ ! -f "$PROJ" ]; then fail "$PROJ missing (the projection + crosswalk, pure)"; else
  s_miss=""; for s in pending running awaiting_approval paused_at_breakpoint completed rejected failed cancelled stuck; do has "'$s'" "$PROJ" || s_miss="$s_miss $s"; done
  [ -z "$s_miss" ] && ok "PipelineRunStatus carries pipeline-runtime's nine values" || fail "$PROJ PipelineRunStatus missing:$s_miss"
  x_miss=""; for s in queued claimed awaiting_review done succeeded skipped; do has "\b$s\b" "$PROJ" || x_miss="$x_miss $s"; done
  [ -z "$x_miss" ] && ok "crosswalk names every source status (research §D.3)" || fail "$PROJ crosswalk does not map:$x_miss"
  has "sourceStatus" "$PROJ" && ok "original status kept as context.sourceStatus" || fail "$PROJ never sets context.sourceStatus"
  has "sources" "$PROJ" && ok "context.sources records every row folded into a Run" || fail "$PROJ has no context.sources (bot_runs fold into their job's Run — the once-each property needs the list)"
  grep -qE "^import .*from '(express|\.\./routes|\.\./providers/aurora)" "$PROJ" && fail "$PROJ imports I/O — the projection must be pure" || ok "projection is pure (no express / route / aurora import)"
fi
if [ -f "$PROJ_TEST" ]; then
  f_miss=""; for fx in agentJobs botRuns agentProjectRuns runsFixture compactionJobs; do has "\b$fx\b" "$PROJ_TEST" || f_miss="$f_miss $fx"; done
  [ -z "$f_miss" ] && ok "projection test loads all five fixtures" || fail "$PROJ_TEST does not load:$f_miss"
  has "sourceStatus" "$PROJ_TEST" && ok "projection test asserts sourceStatus" || fail "$PROJ_TEST never asserts context.sourceStatus"
fi
run_jest "projection property (every seed row of the five sources once, valid status)" "$PROJ_TEST"

section "P0 · routes ($ROUTER)"
if [ ! -f "$ROUTER" ]; then fail "$ROUTER missing"; else
  for r in "'/runs'" "'/runs/:id'" "'/runs/:id/steps'" "'/runs/:id/events'"; do
    grep -qE "Router\.get\($r" "$ROUTER" && ok "GET /api/$T${r//\'/}" || fail "$ROUTER: no GET ${r//\'/}"
  done
  has "text/event-stream" "$ROUTER" && ok ":id/events is SSE (text/event-stream)" || fail "$ROUTER: :id/events does not answer text/event-stream"
  has "pipeline:(run|step):" "$ROUTER" && ok "events use event-catalog names (pipeline:run:* / pipeline:step:*)" || fail "$ROUTER: SSE frames do not use event-catalog names"
  has "requireAction\('ViewPipelines'\)" "$ROUTER" && ok "reads gated on ViewPipelines" || fail "$ROUTER: reads are not gated on requireAction('ViewPipelines')"
  missing=0
  while IFS= read -r path; do
    pat=$(printf '%s' "$path" | sed -E 's#:[A-Za-z_]+#[^/?'"'"'"]+#g')
    grep -rqE "/api/$T${pat}" "$ROUTE_TESTS" 2>/dev/null || { note "untested: $path"; missing=$((missing+1)); }
  done < <(grep -oE "[A-Za-z]+Router\.(get|post|put|patch|delete)\('[^']+'" "$ROUTER" | sed -E "s/.*\('//; s/'$//" | sort -u)
  [ "$missing" = 0 ] && ok "route ↔ test parity: every route in $ROUTER has a test" || fail "route ↔ test parity: $missing route(s) in $ROUTER have no test"
fi
if [ -f "$ROUTE_TEST" ]; then
  grep -qE "(member|sme|assessor|participant)" "$ROUTE_TEST" && grep -qE "403" "$ROUTE_TEST" && ok "route test pins 403 for an outside tenant's role" || fail "$ROUTE_TEST does not assert an outside role gets 403"
  grep -qE "text/event-stream" "$ROUTE_TEST" && ok "route test asserts the SSE content type" || fail "$ROUTE_TEST does not assert text/event-stream on :id/events"
fi
run_jest "pipelines route suite" "$ROUTE_TEST"

section "P0 · pages ($PAGES)"
n_pages=$(find "$PAGES" -name '*.tsx' 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_pages" -lt 3 ]; then fail "$PAGES holds $n_pages .tsx files — the Runs, run-detail and Artifacts pages are owed in P0 (a discipline check over nothing is not a pass)"; fi
for pg in RunsPage RunDetailPage ArtifactsPage; do [ -f "$PAGES/$pg.tsx" ] || fail "$PAGES/$pg.tsx missing"; done
[ -f "$PAGES/RunsPage.tsx" ] && { has "RunsLedger" "$PAGES/RunsPage.tsx" && has "DataTable" "portal/src/components/runs/RunsLedger.tsx" && ok "Runs uses the shared DataTable ledger" || fail "Runs must use the shared DataTable ledger"; }
[ -f "$PAGES/RunDetailPage.tsx" ] && { has "RunTimeline" "$PAGES/RunDetailPage.tsx" && ok "run detail uses RunTimeline" || fail "$PAGES/RunDetailPage.tsx does not render RunTimeline"; }
[ -f "$PAGES/ArtifactsPage.tsx" ] && { has "DataTable" "$PAGES/ArtifactsPage.tsx" && ok "Artifacts page is a DataTable" || fail "$PAGES/ArtifactsPage.tsx renders no DataTable"; }
t_miss=""; for tid in pipeline-run pipeline-steps pipeline-artifacts pipeline-events; do
  grep -rqE "(data-testid|testId)=\"$tid\"" "$PAGES" 2>/dev/null || t_miss="$t_miss $tid"
done
[ -z "$t_miss" ] && ok "run detail renders Run → Steps → Artifacts → Events (test ids)" || fail "run detail under $PAGES lacks data-testid:$t_miss"
# Component discipline — the one brace-aware counter (scripts/lib/discipline.sh,
# shared with validate-component-discipline.sh; the line regex this used beside
# it cannot see past an arrow function, CLAUDE.md "Facts that bite").
source scripts/lib/discipline.sh
PAGE_FILES=$(dc_area_files "$PAGES" "$PAGES/")
if [ -n "$PAGE_FILES" ]; then
  n_btn=$(dc_count_re '<button[ >]' $PAGE_FILES); n_sty=$(dc_count_re 'style=\{\{' $PAGE_FILES)
  n_brace=$(dc_count_raw $PAGE_FILES)
  [ "$n_brace" = 0 ] && ok "raw styled elements: 0 (brace-aware)" || fail "raw styled elements under $PAGES: $n_brace (brace-aware) — must be 0; compose from ui-components or queue the gap"
  [ "$n_btn" = 0 ] && ok "no raw <button>" || fail "raw <button> under $PAGES: $n_btn"
  [ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}} under $PAGES: $n_sty"
  leaks=$(grep -rnE "['\"\`]/(iq|admin|assessment|social)(/|['\"\`])" "$PAGES" --include='*.tsx' | wc -l | tr -d ' ')
  [ "$leaks" = 0 ] && ok "no other tenant's paths inside $PAGES" || { fail "$leaks cross-tenant paths inside $PAGES"; grep -rnE "['\"\`]/(iq|admin|assessment|social)(/|['\"\`])" "$PAGES" --include='*.tsx' | head -5 | sed 's/^/      /'; }
  grep -rq "ui-components/integrations/realtime-modules" "$PAGES" --include='*.tsx' && fail "$PAGES imports integrations/realtime-modules (breaks vite build without @tiptap/react)" || ok "no integrations/realtime-modules imports"
fi

section "P0 · the vertical slice (maintenance bot cron firing → Run → Steps → Artifact → Events)"
# The bot detail page is an orgiq page, so it reads runs through the orgiq
# façade (context.tenant = 'orgiq' only), never /api/pipelines/* — goal doc §Slice.
need "app\.use\('/api/runs',\s*requireTenant\('orgiq'\)" "$INDEX" "orgiq façade /api/runs mounted under requireTenant('orgiq')"
need "/api/runs" "$BOT_DETAIL" "BotDetailPage reads its runs from /api/runs"
for tid in pipeline-run pipeline-steps pipeline-artifacts pipeline-events; do
  has "(data-testid|testId)=\"$tid\"" "$BOT_DETAIL" && ok "BotDetailPage renders $tid" || fail "$BOT_DETAIL: no data-testid=\"$tid\""
done
run_jest "orgiq façade serves only context.tenant=orgiq runs, 403 for assessment/pipelines roles" "$ROUTE_TESTS/runs-facade.test.ts"
f="$JDIR/slice/bot-detail.md"
if [ ! -f "$f" ]; then fail "slice journey log $f missing"; else
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
  grep -qiE '^run-rendered: *yes' "$f" || bad="$bad run-rendered"
  n=$(grep -iE '^steps-rendered: *[0-9]+' "$f" | grep -oE '[0-9]+' | head -1); [ "${n:-0}" -ge 3 ] || bad="$bad steps-rendered<3"
  grep -qiE '^artifact-rendered: *yes' "$f" || bad="$bad artifact-rendered"
  grep -qiE '^events-streamed: *yes' "$f" || bad="$bad events-streamed"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -z "$bad" ] && ok "slice journey log passes" || fail "slice journey log $f fails:$bad"
fi

section "P0 · type + test gates"
if jg_mw_tsc >/dev/null 2>&1; then ok "middleware tsc clean"; else fail "middleware: tsc errors"; fi
if jg_portal_tsc >/dev/null 2>&1; then ok "portal tsc clean"; else fail "portal: tsc errors"; fi
if ls "$PAGES"/__tests__/*.test.ts >/dev/null 2>&1; then
  if (cd portal && node --test "src/pages/$T/__tests__/"*.test.ts 2>&1 | grep -qE '^ℹ fail 0$'); then ok "portal $T node tests green"; else fail "portal: $T node tests failing"; fi
else fail "no node tests under $PAGES/__tests__ (the run-status formatting and crosswalk labels owe one)"; fi
if [ "$QUICK" = 0 ] && [ "$n_pages" -ge 3 ]; then
  if jg_vite_build 2>&1 | grep -q '✓ built'; then ok "vite build"; else fail "portal: vite build fails"; fi
fi

section "P0 · journey logs ($JDIR)"
[ -f "$JDIR/PROTOCOL.md" ] && ok "$JDIR/PROTOCOL.md exists" || fail "$JDIR/PROTOCOL.md missing"
J_ROLES=(author operator pipeline-admin admin)
P0_SURFACES=(runs run-detail artifacts agents bots commands configuration)
P2_SURFACES=(definitions runbooks approvals)
judge_logs() { # <phase-label> <surfaces...>
  local label="$1"; shift; local miss=0 bad_n=0 total=0
  for r in "${J_ROLES[@]}"; do for s in "$@"; do
    total=$((total+1)); f="$JDIR/$r/$s.md"
    [ -f "$f" ] || { miss=$((miss+1)); continue; }
    bad=""
    grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
    grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
    grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
    grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
    grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
    grep -qiE '^role-gating: *\S+' "$f" || bad="$bad role-gating"
    grep -qiE '^pages: *\S+' "$f" || bad="$bad pages-line"
    shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
    [ -n "$shot" ] || bad="$bad screenshot-line"
    [ -n "$shot" ] && [ ! -f "$JDIR/$r/$shot" ] && bad="$bad screenshot-missing($shot)"
    grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
    [ -n "$bad" ] && { bad_n=$((bad_n+1)); note "$r/$s:$bad"; }
  done; done
  [ "$miss" = 0 ] && ok "$label: all $total role×surface logs present" || fail "$label: $miss of $total journey logs missing (roles: ${J_ROLES[*]}; surfaces: $*)"
  [ "$bad_n" = 0 ] && ok "$label: every present log passes all fields" || fail "$label: $bad_n journey logs fail a required field"
}
judge_logs "P0 surfaces" "${P0_SURFACES[@]}"

section "P0 · role isolation ($JDIR/isolation)"
ISO="$JDIR/isolation"
IN_ROLES=(member sme program-owner org-leader hr-admin assessor lead-assessor program-lead)
[ "$SOCIAL" = 1 ] && IN_ROLES+=(participant moderator community-admin)
imiss=0; ibad=0
for r in "${IN_ROLES[@]}"; do
  f="$ISO/$r.md"; [ -f "$f" ] || { imiss=$((imiss+1)); note "missing: isolation/$r.md"; continue; }
  bad=""
  grep -qiE '^pipelines-tile-visible: *no' "$f" || bad="$bad tile"
  grep -qiE '^pipelines-nav-visible: *no' "$f" || bad="$bad nav"
  grep -qiE '^direct-route-result: *(not-found|redirect)' "$f" || bad="$bad route"
  grep -qiE '^api-status: *403' "$f" || bad="$bad api"
  grep -qiE '^events-status: *403' "$f" || bad="$bad events-sse"
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -n "$bad" ] && { ibad=$((ibad+1)); note "isolation/$r:$bad"; }
done
for r in "${ROLES[@]}"; do
  f="$ISO/$r-outbound.md"; [ -f "$f" ] || { imiss=$((imiss+1)); note "missing: isolation/$r-outbound.md"; continue; }
  bad=""
  grep -qiE '^other-nav-visible: *no' "$f" || bad="$bad other-nav"
  grep -qiE '^iq-route-result: *(not-found|redirect)' "$f" || bad="$bad iq-route"
  grep -qiE '^iq-api-status: *403' "$f" || bad="$bad iq-api"
  grep -qiE '^assessment-route-result: *(not-found|redirect)' "$f" || bad="$bad assessment-route"
  grep -qiE '^assessment-api-status: *403' "$f" || bad="$bad assessment-api"
  if [ "$SOCIAL" = 1 ]; then
    grep -qiE '^social-route-result: *(not-found|redirect)' "$f" || bad="$bad social-route"
    grep -qiE '^social-api-status: *403' "$f" || bad="$bad social-api"
  fi
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -n "$bad" ] && { ibad=$((ibad+1)); note "isolation/$r-outbound:$bad"; }
done
n_iso=$(( ${#IN_ROLES[@]} + ${#ROLES[@]} ))
[ "$SOCIAL" = 1 ] && sn="social registered: its three roles are owed" || sn="social not registered yet: its three inbound roles and the social half of the outbound walks are not owed"
[ "$imiss" = 0 ] && ok "all $n_iso isolation logs present ($sn)" || fail "$imiss of $n_iso isolation logs missing under $ISO ($sn)"
[ "$ibad" = 0 ] && ok "every present isolation log passes" || fail "$ibad isolation logs fail a required field"
# Server side pinned by a test, not a curl someone once ran.
if grep -rqE "requireTenant\('$T'\)|/api/$T" "$ROUTE_TESTS" 2>/dev/null && grep -rqE "403" "$ROUTE_TEST" 2>/dev/null; then ok "middleware tests pin the $T tenant gate"; else fail "no middleware test asserts an outside role gets 403 on /api/$T/*"; fi
# Computer-Lab chrome must stay orgiq-only (the assessment judge counts it; a
# third tenant is exactly where an ungated mount would show).
compute=$(grep -oE '<[A-Za-z]*(Devbox|Compute|Machine)[A-Za-z]*' "$LAYOUT" | tr -d '<' | sort -u)
ungated=""; for c in $compute; do grep -qE "session\?\.tenant === 'orgiq' && <$c\b" "$LAYOUT" || ungated="$ungated $c"; done
[ -z "$ungated" ] && ok "Computer-Lab chrome stays orgiq-only in the shell" || fail "Computer-Lab chrome would mount in the $T shell:$ungated"

section "P0 · freshness (each log's walked routes: rendered contract vs its sealed walk, docs/journeys.md)"
source scripts/lib/journeys.sh
if [ -d "$JDIR" ]; then
  jr_freshness "$JDIR" $(find "$JDIR" -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' ! -path '*/fixtures/*' 2>/dev/null | sort)
fi
if [ "${JR_TOTAL:-0}" = 0 ]; then fail "no journey or isolation logs to judge for freshness"; else jr_report; fi

section "P0 · neighbour judges still green"
if [ "$QUICK" = 1 ]; then ok "skipped (--quick)"; else
  neighbour "$RETIRED_JUDGE" --quick
  neighbour validate-nav-parity.sh --quick
  neighbour validate-route-coverage.sh
  neighbour validate-mock-floor.sh --quick
fi

# ═════════════════════════════════════════════════════════════════════════════
# P1 — the agent half. Rule 2: every fleet invocation is a run.
# ═════════════════════════════════════════════════════════════════════════════
if judged P1; then
section "P1 · every fleet invocation is a run (rule 2)"
INSTR=agents/_shared/instrumentation.py
need "[\"']runId[\"']" "$INSTR" "trace bundle carries the AG-UI runId ($INSTR)"
need "agui_run_id" schema/observability_schema.sql "observability.invocation_traces has an agui_run_id column"
need "runId" middleware/src/lib/trace-sink.ts "trace-sink reads the bundle's runId"
if [ -f "$PROJ" ]; then
  has "kind: 'agent'" "$PROJ" && ok "projection yields Definition kind 'agent' runs" || fail "$PROJ: no kind: 'agent' projection of invocations"
  has "STEP_STARTED" "$PROJ" && has "TOOL_CALL_" "$PROJ" && ok "steps from STEP_* and attempts from TOOL_CALL_*" || fail "$PROJ: steps are not built from STEP_* / TOOL_CALL_*"
  has "'trace'" "$PROJ" && ok "the trace is filed as a 'trace' Artifact" || fail "$PROJ: no 'trace' artifact kind"
else fail "$PROJ missing"; fi
run_jest "rule 2 — a bundle with runId is exactly one agent Run with steps + trace artifact; one without is counted unlinked, not dropped" middleware/src/lib/__tests__/pipeline-runs.agent.test.ts
run_jest "harness suite (the trace callback)" "$ROUTE_TESTS/harness-mock.test.ts" "$ROUTE_TESTS/harness-runner-service-auth.test.ts"
if [ ! -f agents/tests/test_trace_run_id.py ]; then fail "agents/tests/test_trace_run_id.py missing (the bundle carries RUN_STARTED's run id)"
elif [ "$QUICK" = 1 ]; then ok "agents/tests/test_trace_run_id.py present (run skipped: --quick)"
elif [ ! -x "$PY" ]; then fail "missing $PY — cannot run the agent test (CLAUDE.md 'Local dev')"
elif (cd agents/tests && "../../$PY" -m unittest test_trace_run_id) >"$TMP/runid.log" 2>&1; then ok "test_trace_run_id green"
else fail "test_trace_run_id failing"; tail -8 "$TMP/runid.log" | sed 's/^/      /'; fi
if [ "$QUICK" = 1 ]; then ok "golden runner structural — skipped (--quick)"
elif bash scripts/validate-agent-eval.sh >"$TMP/eval.log" 2>&1; then ok "validate-agent-eval.sh (golden runner structural) exits 0"
else fail "validate-agent-eval.sh is red"; grep -E '^  ✗' "$TMP/eval.log" | head -4 | sed 's/^/      /'; fi
else skipped_phase P1 "P1 · the agent half"; fi

# ═════════════════════════════════════════════════════════════════════════════
# P2 — definitions. Rule 1: a RUNBOOK cannot become a SKILL without a
#      completed run of its definition.
# ═════════════════════════════════════════════════════════════════════════════
if judged P2; then
section "P2 · schema/pipeline_schema.sql"
PSQL=schema/pipeline_schema.sql
if [ ! -f "$PSQL" ]; then fail "$PSQL missing"; else
  for t in pipeline_definitions pipeline_runs pipeline_steps pipeline_artifacts; do
    need "CREATE TABLE IF NOT EXISTS $t\b" "$PSQL" "table $t"
  done
  s_miss=""; for s in pending running awaiting_approval paused_at_breakpoint completed rejected failed cancelled stuck; do has "'$s'" "$PSQL" || s_miss="$s_miss $s"; done
  [ -z "$s_miss" ] && ok "pipeline_runs.status CHECK carries the nine statuses" || fail "$PSQL status CHECK missing:$s_miss"
  k_miss=""; for k in runbook agent bot assessment-command compaction; do has "'$k'" "$PSQL" || k_miss="$k_miss $k"; done
  [ -z "$k_miss" ] && ok "pipeline_definitions.kind CHECK carries the five kinds" || fail "$PSQL kind CHECK missing:$k_miss"
  has "context_tenant" "$PSQL" && ok "runs carry context_tenant (what the embedded Runs sections filter on)" || fail "$PSQL: no context_tenant column on pipeline_runs"
  a_miss=""; for k in change document scores trace transcript image; do has "'$k'" "$PSQL" || a_miss="$a_miss $k"; done
  [ -z "$a_miss" ] && ok "pipeline_artifacts.kind CHECK carries the six kinds" || fail "$PSQL artifact kind CHECK missing:$a_miss"
fi
need "name: 'pipeline_definitions'" "$ENTITIES" "parity entity pins pipeline_definitions (mock ↔ seed)"
need "defineFixture" middleware/src/mock/pipeline-definitions.ts "registered pipeline-definitions fixture"

section "P2 · a RUNBOOK needs a completed run to become a SKILL (rule 1)"
need "dryRunRunId" middleware/src/providers/promotions.ts "promotions carry the dry-run's run id, not a bare boolean"
run_jest "rule 1 — promotion refuses without a completed run of its own definition, accepts with one" middleware/src/lib/__tests__/promotion-requires-run.test.ts
if [ -f middleware/src/lib/__tests__/promotion-requires-run.test.ts ]; then
  t=middleware/src/lib/__tests__/promotion-requires-run.test.ts
  c=0; for w in "no run" "not completed|'failed'|'running'" "another definition|other definition|different definition" "'completed'"; do grep -qiE "$w" "$t" && c=$((c+1)); done
  [ "$c" = 4 ] && ok "rule-1 test covers: no run, run not completed, run of another definition, completed run" || fail "$t covers $c of 4 cases (no run / not completed / another definition's run / completed)"
fi
need "definitions" "$ROUTER" "routes: /api/$T/definitions"
need "approvals" "$ROUTER" "routes: /api/$T/approvals"
need "requireAction\('AuthorDefinition'\)" "$ROUTER" "definition writes gated on AuthorDefinition"
need "requireAction\('ApproveStep'\)" "$ROUTER" "approval decisions gated on ApproveStep"
need "requireAction\('CancelRun'\)" "$ROUTER" "cancel gated on CancelRun"
need "requireAction\('ManagePipelineConfig'\)" "$ROUTER" "configuration writes gated on ManagePipelineConfig"
for pg in DefinitionsPage RunbooksPage ApprovalsPage; do
  [ -f "$PAGES/$pg.tsx" ] && has "/api/$T/" "$PAGES/$pg.tsx" && ok "$pg reads /api/$T/*" || fail "$PAGES/$pg.tsx missing or not wired to /api/$T/* (an empty state is P0's, not P2's)"
done
judge_logs "P2 surfaces" "${P2_SURFACES[@]}"
else skipped_phase P2 "P2 · definitions"; fi

# ═════════════════════════════════════════════════════════════════════════════
# E — embedding. The Runs section in orgiq (Operate) and assessment (Activity),
#     fed by context tenant; the other tenants' walks still green.
# ═════════════════════════════════════════════════════════════════════════════
if judged E; then
section "E · Runs embedded in orgiq (Operate) and assessment (Activity)"
grep -E "path: '/iq/runs'" "$LAYOUT" 2>/dev/null | grep -qF "group: 'Operate'" && ok "orgiq rail: Runs under Operate (/iq/runs)" || fail "$LAYOUT: no /iq/runs NAV_ITEMS row in group 'Operate'"
has "path: '/iq/runs'" "$CMDS" && ok "palette knows /iq/runs" || fail "$CMDS: no /iq/runs row"
need "/api/assessment/pipeline-runs" "$ROUTE_TESTS/runs-facade.test.ts" "façade test covers /api/assessment/pipeline-runs"
grep -rqF "/api/assessment/pipeline-runs" portal/src/pages/assessment 2>/dev/null && ok "assessment Activity reads /api/assessment/pipeline-runs" || fail "portal/src/pages/assessment: Activity is not fed from /api/assessment/pipeline-runs"
# Comment lines (// … , * … , /* … , {/* … */}) are prose, not calls — a page
# that says "never /api/pipelines/*" in a comment is obeying the rule.
grep -rnF "/api/pipelines/" portal/src/pages/assessment portal/src/pages/iq portal/src/pages/bots 2>/dev/null | grep -qvE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*|\{/\*)' && fail "an orgiq/assessment page calls /api/pipelines/* (it must read its own tenant's façade)" || ok "no orgiq/assessment page reaches into /api/pipelines/*"
if [ -f "$ROUTE_TESTS/runs-facade.test.ts" ]; then
  grep -qE "context.*tenant|contextTenant" "$ROUTE_TESTS/runs-facade.test.ts" && ok "façade test asserts filtering by context tenant" || fail "runs-facade.test.ts never asserts the context-tenant filter"
fi
section "E · the other tenants' walks still green"
if [ "$QUICK" = 1 ]; then ok "skipped (--quick)"; else
  neighbour validate-assessment-tenant.sh --quick --no-time
  neighbour validate-orgiq-audit.sh --quick
  neighbour validate-rail-parity.sh --quick
fi
else skipped_phase E "E · embedding"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "time gate"
if [ "$NO_TIME" = 1 ]; then ok "skipped (--no-time)"
elif [ -z "${PIPELINES_UNTIL:-}" ]; then ok "off (PIPELINES_UNTIL unset)"; else
  H=$(date +%H)
  if [ "$((10#$H))" -ge "$((10#$PIPELINES_UNTIL))" ]; then ok "past $PIPELINES_UNTIL:00 local"; else fail "keep going — it is $(date +%H:%M), the gate opens at $PIPELINES_UNTIL:00 (work the stretch list in docs/pipelines-tenant-goal.md)"; fi
fi

printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — the pipelines tenant meets its definition of done through phase $PHASE."
  exit 0
fi
echo "${#FAILS[@]} CHECK(S) FAILING (judged through phase $PHASE):"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
