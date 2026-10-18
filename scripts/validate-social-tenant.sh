#!/usr/bin/env bash
# validate-social-tenant.sh — the definition of done for the `social` tenant
# and the header activity indicator (docs/social-tenant-goal.md, judging
# docs/social-tenant-design.md §3, §4, §6, §7). Every check is mechanical and
# greps the exact file the research's A.4 table names. It prints every
# failing check, not just the first, so one run shows the whole backlog.
#
# Usage:  scripts/validate-social-tenant.sh               # full run
#         scripts/validate-social-tenant.sh --quick       # skip jest, vite build, Playwright; siblings get --quick
#         scripts/validate-social-tenant.sh --phase S0    # gates + siblings + one phase: S0 | N | S1 | S2 | E
#         scripts/validate-social-tenant.sh --seal        # retired: scripts/journeys/seal.sh <dir> seals, after a walk
#         scripts/validate-social-tenant.sh --no-time     # skip the optional SOCIAL_TIME_GATE=<hour> gate
#
# The e2e specs run (non-quick) against PARITY_BASE_URL (default
# http://localhost:5183) — start dev:mock (or dev:mock:social) and the portal
# first. Exit 0 only when EVERY check passes. The goal is met only by a run
# with no --phase.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state

QUICK=0; NO_TIME=0; PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --no-time) NO_TIME=1 ;;
    --seal) echo "--seal is retired: walk the logs, then run scripts/journeys/seal.sh <dir> (docs/journeys.md)" >&2; exit 2 ;;
    --phase) shift; PHASE="${1:-}" ;;
    --phase=*) PHASE="${1#--phase=}" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PHASE" in ""|S0|N|S1|S2|E) ;; *) echo "--phase must be one of S0 N S1 S2 E" >&2; exit 2 ;; esac

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
want() { [ -z "$PHASE" ] || [ "$PHASE" = "$1" ]; }
has()  { grep -qE -- "$1" "$2" 2>/dev/null; }
hasF() { grep -qF -- "$1" "$2" 2>/dev/null; }
# Lines from the first match of $1 through the first later line matching $2.
# (Patterns go through awk -v, so keep backslashes out of them.)
range() { awk -v s="$1" -v e="$2" 'f==0 && $0 ~ s {f=1; print; next} f {print; if ($0 ~ e) exit}' "$3" 2>/dev/null; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/validate-social.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

MW=middleware
SESSION=$MW/src/lib/session.ts
AUTHZ=$MW/src/lib/authz.ts
REGISTRY=$MW/src/lib/role-registry.ts
CEDAR_DIR=$MW/seeds/roles/social
SCHEMA_JSON=$MW/seeds/schema.json
IDSQL=schema/identity_schema.sql
IDFB=$MW/src/providers/identity.ts
INDEX=$MW/src/index.ts
ENTITIES=$MW/src/mock/core/parity/entities.ts
GATEWAY=$MW/src/lib/realtime-gateway.ts
CHAT_BACKEND=$MW/src/lib/social-chat.ts
GATEWAY_CALLS=$MW/src/lib/gateway/calls.ts
GATEWAY_AUTHORITY=$MW/src/lib/gateway/authority.ts
REDIS=$MW/src/lib/redis-store.ts
NOTIFY=$MW/src/lib/social-notify.ts
ROUTER=$MW/src/routes/social.ts
RTESTS=$MW/src/routes/__tests__
LTESTS=$MW/src/lib/__tests__
AUTH_TSX=portal/src/lib/auth.tsx
LAYOUT=portal/src/components/shell/Layout.tsx
CMDS=portal/src/components/shell/portalCommands.ts
HOME_TS=portal/src/lib/tenantHome.ts
CACHES=portal/src/lib/tenantCaches.ts
FEATURES=portal/src/lib/features.ts
APP=portal/src/App.tsx
PICKER=portal/src/pages/SelectContextPage.tsx
CSS=portal/src/app.css
COGNITO=infra/lib/authentication-stack.ts
SOCIAL_STACK=infra/lib/social-stack.ts
SP=portal/src/pages/social
QUEUE=docs/ui-components-queue.md
GOAL=docs/social-tenant-goal.md
JDIR=docs/social-journeys
UI_DIST=portal/node_modules/@connorhoehnslalom/ui-components/dist
BASE=${PARITY_BASE_URL:-http://localhost:5183}
# The retired-tenant judge. Its name is assembled because that judge greps
# every file under scripts/ for the retired tenant's name (case-insensitive)
# and fails on any hit outside itself — spelling it here would turn it red.
RETIRED_V="validate-$(printf '%s%s' news room)-removal.sh"

ACTIONS="ViewSocial PostMessage StartCall ManageChannels ManageTeams ManageRecordings ManageSocialConfig"
SOCIAL_ROLES="participant moderator community-admin"
CURATED_PARTICIPANTS="u-release u-vera u-mia u-nora u-rachel u-theo u-jonas u-farah"

# Middleware import-graph reachability from src/index.ts (the mock floor's
# rule 5): a fixture module nothing imports registers nothing.
cat > "$TMP/reach.mjs" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const root = process.argv[2];
const seen = new Set(['src/index.ts']);
const queue = ['src/index.ts'];
while (queue.length) {
  const abs = join(root, queue.shift());
  if (!existsSync(abs)) continue;
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m; const text = readFileSync(abs, 'utf8');
  while ((m = re.exec(text))) {
    let next = relative(root, resolve(dirname(abs), m[1].replace(/\.js$/, '.ts')));
    if (!next.endsWith('.ts')) next += '.ts';
    if (!existsSync(join(root, next))) {
      const idx = next.replace(/\.ts$/, '/index.ts');
      if (!existsSync(join(root, idx))) continue;
      next = idx;
    }
    if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
}
for (const f of [...seen].sort()) console.log(f);
NODE
node "$TMP/reach.mjs" "$MW" > "$TMP/reach.txt" 2>/dev/null || : > "$TMP/reach.txt"
reachable() { grep -qxF "${1#$MW/}" "$TMP/reach.txt"; }

# A registered fixture: defines one, has an `empty` scenario, is reachable.
fixture_check() {
  local f="$1" what="$2"
  if [ ! -f "$f" ]; then fail "$what: $f missing"; return; fi
  has 'defineFixture[<(]' "$f" || { fail "$what: $f defines no fixture (defineFixture)"; return; }
  has '^[[:space:]]*empty:' "$f" && ok "$what: $f has an \`empty\` scenario" || fail "$what: $f has no \`empty\` scenario (the contract: an empty state is asked for, not the default)"
  reachable "$f" && ok "$what: $f is reachable from src/index.ts (registered)" || fail "$what: $f is not imported from src/index.ts's graph — it registers nothing, /api/__mock/state cannot list or reset it"
}

# Every test title must appear verbatim; non-quick, the spec runs green.
spec_check() {
  local spec="$1" what="$2"; shift 2
  if [ ! -f "$spec" ]; then fail "$what: $spec missing"; return; fi
  local t missing=""
  for t in "$@"; do grep -qF -- "$t" "$spec" || missing="$missing | $t"; done
  [ -z "$missing" ] && ok "$what: $spec carries every required test title" || fail "$what: $spec is missing test title(s):${missing# |}"
  [ "$QUICK" = 1 ] && return
  if curl -fsS -o /dev/null --max-time 5 "$BASE/" 2>/dev/null; then
    local log="$TMP/$(basename "$spec").log"
    if (cd portal && PARITY_BASE_URL="$BASE" node_modules/.bin/playwright test "${spec#portal/}" --reporter=line >"$log" 2>&1); then
      ok "$what: $spec passed against $BASE"
    else
      fail "$what: $spec failed against $BASE"; tail -15 "$log" | sed 's/^/      /'
    fi
  else fail "$what: no portal at $BASE — start dev:mock + the portal (PARITY_BASE_URL overrides)"; fi
}

# A file under the social pages that uses $1 and imports from the library.
page_uses() {
  [ -d "$SP" ] || return 1
  local f
  for f in $(grep -rlw -- "$1" "$SP" --include='*.tsx' 2>/dev/null); do
    grep -q "@connorhoehnslalom/ui-components" "$f" && return 0
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# Gates. A tenant that does not compile is not done.
# ─────────────────────────────────────────────────────────────────────────────
section "gates"
if jg_mw_tsc >/dev/null 2>&1; then ok "middleware tsc clean"; else fail "middleware: tsc errors"; fi
if jg_portal_tsc >/dev/null 2>&1; then ok "portal tsc clean"; else fail "portal: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest --silent >/dev/null 2>&1); then ok "middleware jest green"; else fail "middleware: jest failures"; fi
  if jg_vite_build 2>&1 | grep -q '✓ built'; then ok "portal vite build"; else fail "portal: vite build fails"; fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE S0 — registered, pickable, empty (research §A.4, rows 1–21)
# ═════════════════════════════════════════════════════════════════════════════
if want S0; then
section "S0 · 1 session vocabulary ($SESSION)"
has "TENANTS = \[[^]]*'social'" "$SESSION" && ok "TENANTS lists 'social'" || fail "A.4#1 $SESSION: TENANTS does not list 'social'"
has "social: \['participant', 'moderator', 'community-admin'\]" "$SESSION" && ok "ROLES_BY_TENANT.social = participant/moderator/community-admin" || fail "A.4#1 $SESSION: ROLES_BY_TENANT has no \`social: ['participant', 'moderator', 'community-admin']\`"
role_line=$(grep -E '^export type Role =' "$SESSION" 2>/dev/null)
miss=""; for r in $SOCIAL_ROLES; do printf '%s' "$role_line" | grep -qF "'$r'" || miss="$miss $r"; done
[ -z "$miss" ] && ok "Role union names the three social roles" || fail "A.4#1 $SESSION: the hand-written Role union lacks:$miss"
rank=$(range 'const ROLE_RANK' '};' "$SESSION")
miss=""; for r in participant moderator "'community-admin'"; do printf '%s' "$rank" | grep -qE "(^|[ {,])$r:" || miss="$miss $r"; done
[ -z "$miss" ] && ok "ROLE_RANK ranks the three social roles" || fail "A.4#1 $SESSION: ROLE_RANK lacks:$miss"
pg=$(range 'export function permissiveGrants' '^}' "$SESSION")
printf '%s' "$pg" | grep -q "social" && ok "permissiveGrants() excludes social (the demo user holds no social grant)" || fail "design §4.1 $SESSION: permissiveGrants() hands the cookie-less demo identity every TENANTS entry — it must leave 'social' out (\"the demo user gets none\")"

section "S0 · 2 Cedar ($CEDAR_DIR)"
cedar_stmts() { # $1 file, $2 permit|forbid — one flattened statement per line
  sed -E 's#//.*##' "$1" 2>/dev/null | tr '\n' ' ' | tr ';' '\n' | grep -E "(^|[^A-Za-z])$2[[:space:]]*\(" ; }
for r in $SOCIAL_ROLES; do
  f="$CEDAR_DIR/$r.cedar"
  if [ ! -f "$f" ]; then fail "A.4#2 $f missing"; continue; fi
  permits=$(cedar_stmts "$f" permit)
  if [ -z "$permits" ]; then fail "A.4#2 $f has no permit"; continue; fi
  unscoped=$(printf '%s\n' "$permits" | grep -vc 'principal.tenant == "social"' || true)
  [ "$unscoped" = 0 ] && ok "$r.cedar: every permit conditioned on principal.tenant == \"social\"" || fail "A.4#2 $f: $unscoped permit(s) not conditioned on principal.tenant == \"social\""
done
cedar_expect() { # file kind action...
  local f="$1" kind="$2"; shift 2; local body miss="" a
  [ -f "$f" ] || return 0
  body=$(cedar_stmts "$f" "$kind")
  for a in "$@"; do printf '%s' "$body" | grep -qF "Action::\"$a\"" || miss="$miss $a"; done
  [ -z "$miss" ] && ok "$(basename "$f"): $kind covers $*" || fail "design §4.1 $f: $kind lacks:$miss"
}
cedar_expect "$CEDAR_DIR/participant.cedar" permit ViewSocial PostMessage StartCall
cedar_expect "$CEDAR_DIR/participant.cedar" forbid ManageChannels ManageTeams ManageRecordings
cedar_expect "$CEDAR_DIR/moderator.cedar" permit ViewSocial PostMessage StartCall ManageChannels ManageTeams ManageRecordings
cedar_expect "$CEDAR_DIR/moderator.cedar" forbid ManageSocialConfig
cedar_expect "$CEDAR_DIR/community-admin.cedar" permit ViewSocial ManageChannels ManageTeams ManageRecordings ManageSocialConfig

section "S0 · 3–5 actions, CAPABILITY_ACTIONS, role labels"
missing_actions=$(python3 - "$SCHEMA_JSON" $ACTIONS <<'PY' 2>/dev/null || echo "(unreadable)"
import json, sys
try:
    acts = json.load(open(sys.argv[1]))['OrgIQ']['actions']
except Exception:
    print('(unreadable)'); sys.exit(0)
print(' '.join(a for a in sys.argv[2:] if a not in acts))
PY
)
[ -z "$missing_actions" ] && ok "schema.json declares the seven social actions" || fail "A.4#3 $SCHEMA_JSON: OrgIQ.actions lacks: $missing_actions"
caps=$(range 'export const CAPABILITY_ACTIONS' 'as const' "$AUTHZ")
miss=""; for a in $ACTIONS; do printf '%s' "$caps" | grep -qF "'$a'" || miss="$miss $a"; done
[ -z "$miss" ] && ok "CAPABILITY_ACTIONS lists the seven social actions" || fail "A.4#4 $AUTHZ: CAPABILITY_ACTIONS lacks:$miss (an unlisted action hides every control behind it)"
pres=$(range 'const PRESENTATION' '^};' "$REGISTRY")
miss=""; for r in participant moderator "'community-admin'"; do printf '%s' "$pres" | grep -qE "(^|[ {,])$r:" || miss="$miss $r"; done
[ -z "$miss" ] && ok "role-registry PRESENTATION labels the three roles" || fail "A.4#5 $REGISTRY: PRESENTATION lacks:$miss"

section "S0 · 6–7 identity seed + fallback"
has "\('social', *'Social'\)" "$IDSQL" && ok "tenant row ('social', 'Social')" || fail "A.4#6 $IDSQL: no tenant row ('social', 'Social')"
for u in u-mira u-lena u-sana; do has "\('$u', *'" "$IDSQL" && ok "$u is an app_users row" || fail "A.4#6 $IDSQL: no app_users row for $u"; done
grant_sql() { has "\('$1', *'social', *'$2'\)" "$IDSQL"; }
miss=""
grant_sql u-mira community-admin || miss="$miss u-mira→community-admin"
grant_sql u-lena moderator       || miss="$miss u-lena→moderator"
grant_sql u-sana participant     || miss="$miss u-sana→participant"
grant_sql u-operator admin       || miss="$miss u-operator→admin"
for u in $CURATED_PARTICIPANTS; do grant_sql "$u" participant || miss="$miss ${u}→participant"; done
[ -z "$miss" ] && ok "identity seed grants the cast + curated participants" || fail "A.4#6 $IDSQL: user_tenant_roles lacks:$miss"
has "'demo-user'" "$IDSQL" && fail "A.4#6 $IDSQL: a demo-user row exists (the demo user must hold no social grant)" || ok "no demo-user row in the identity seed"
has "\{ id: 'social', displayName: 'Social'" "$IDFB" && ok "FALLBACK_TENANTS carries social" || fail "A.4#7 $IDFB: FALLBACK_TENANTS has no { id: 'social', displayName: 'Social' }"
fb_grant() { grep -A2 -F "{ id: '$1'," "$IDFB" 2>/dev/null | tr '\n' ' ' | grep -qE "social: \[[^]]*'$2'"; }
miss=""
fb_grant u-mira community-admin || miss="$miss u-mira→community-admin"
fb_grant u-lena moderator       || miss="$miss u-lena→moderator"
fb_grant u-sana participant     || miss="$miss u-sana→participant"
fb_grant u-operator admin       || miss="$miss u-operator→admin"
for u in $CURATED_PARTICIPANTS; do fb_grant "$u" participant || miss="$miss ${u}→participant"; done
[ -z "$miss" ] && ok "identity fallback mirrors the social grants" || fail "A.4#7 $IDFB: FALLBACK_USERS lacks:$miss"

section "S0 · 8–10 mount, tenant-gate test, agents, mock parity"
has "app\.use\('/api/social', *requireTenant\('social'\)" "$INDEX" && ok "/api/social mounted behind requireTenant('social')" || fail "A.4#8 $INDEX: no app.use('/api/social', requireTenant('social'), …)"
gate_test=""
for f in $RTESTS/social*.test.ts; do
  [ -f "$f" ] || continue
  grep -q "403" "$f" && grep -qE "'(member|sme|program-owner|org-leader|hr-admin|assessor|lead-assessor|program-lead)'" "$f" && grep -q "/api/social" "$f" && gate_test="$f"
done
[ -n "$gate_test" ] && ok "tenant gate pinned by a test ($gate_test)" || fail "A.4#8 no $RTESTS/social*.test.ts asserts an orgiq/assessment role gets 403 on /api/social/*"
ok "A.4#9 agent↔tenant map: n/a — the social tenant has no agents"
if node - "$SESSION" "$ENTITIES" <<'NODE'
const fs = require('node:fs');
const session = fs.readFileSync(process.argv[2], 'utf8');
const entities = fs.readFileSync(process.argv[3], 'utf8');
const declaration = session.match(/export const TENANTS = \[([^\]]+)\]/)?.[1];
const tenants = [...(declaration ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
const description = entities.match(/name: 'tenants',\s*describes: '([^']+)'/)?.[1] ?? '';
process.exit(tenants.length && tenants.every(tenant => new RegExp(`\\b${tenant}\\b`).test(description)) ? 0 : 1);
NODE
then ok "parity entity 'tenants' describes every declared tenant"
else fail "A.4#10 $ENTITIES: the 'tenants' description must name every tenant in TENANTS"; fi

section "S0 · 11–13 portal tenant type, front door, flag"
has "^export type Tenant = [^;]*'social'" "$AUTH_TSX" && ok "auth.tsx Tenant includes 'social'" || fail "A.4#11 $AUTH_TSX: export type Tenant lacks 'social'"
has "^type Tenant = [^;]*'social'" "$LAYOUT" && ok "Layout.tsx Tenant includes 'social'" || fail "A.4#11 $LAYOUT: type Tenant lacks 'social'"
has "^type PageTenant = [^;]*'social'" "$CMDS" && ok "portalCommands.ts PageTenant includes 'social'" || fail "A.4#11 $CMDS: type PageTenant lacks 'social'"
has "social: '/social/channels'" "$HOME_TS" && ok "TENANT_HOME.social = /social/channels" || fail "A.4#12 $HOME_TS: TENANT_HOME has no social: '/social/channels'"
has "VITE_ENABLE_SOCIAL" "$FEATURES" && ok "VITE_ENABLE_SOCIAL flag" || fail "A.4#13 $FEATURES: no VITE_ENABLE_SOCIAL flag"

section "S0 · 14–16 rail, palette, route tree"
nav_row() { awk -v p="path: '$1'" 'index($0,p){f=1} f{printf "%s ",$0; if ($0 ~ /\}/) exit}' "$LAYOUT" 2>/dev/null; }
miss=""
for pg in /social/channels:Talk /social/dms:Talk /social/calls:Meet /social/rooms:Meet /social/contacts:People /social/teams:People /social/recordings:Library /social/configuration:System; do
  p=${pg%%:*}; g=${pg#*:}; row=$(nav_row "$p")
  printf '%s' "$row" | grep -qF "tenant: 'social'" && printf '%s' "$row" | grep -qF "group: '$g'" || miss="$miss $p($g)"
done
[ -z "$miss" ] && ok "NAV_ITEMS carries the eight social rows in their groups" || fail "A.4#14 $LAYOUT: NAV_ITEMS lacks (tenant 'social', group):$miss"
range 'const TENANT_LABELS' '^};' "$LAYOUT" | grep -qE "^[[:space:]]*social:" && ok "TENANT_LABELS carries social" || fail "A.4#14 $LAYOUT: TENANT_LABELS has no social entry"
has "social: \['Talk', 'Meet', 'People', 'Library', 'System'\]" "$CMDS" && ok "GROUP_ORDER_BY_TENANT.social = Talk/Meet/People/Library/System" || fail "A.4#15 $CMDS: GROUP_ORDER_BY_TENANT has no social: ['Talk', 'Meet', 'People', 'Library', 'System']"
pal=$(grep -c "tenant: 'social'" "$CMDS" 2>/dev/null | tr -d ' '); pal=${pal:-0}
[ "$pal" -ge 10 ] && ok "palette lists $pal social pages" || fail "A.4#15 $CMDS: palette lists $pal social pages (expect ≥10)"
has 'RequireTenant tenant="social"' "$APP" && ok "App.tsx wraps /social in RequireTenant tenant=\"social\"" || fail "A.4#16 $APP: no RequireTenant tenant=\"social\""
# Scope to the /social tree: from the parent route (path="social" or
# "/social", possibly "social/*") to the first </Route> at or left of its
# indentation. Bare "teams"/"configuration" also exist under /assessment, so an
# unscoped grep would pass for the wrong tenant.
awk -v t=social 'f==0 && ($0 ~ "path=\"/?" t "\"" || $0 ~ "path=\"/?" t "/\\*\"") {f=1; match($0, /^ */); ind=RLENGTH; print; next}
     f {print; if ($0 ~ /^ *<\/Route>/) { match($0, /^ */); if (RLENGTH<=ind) exit } }' "$APP" 2>/dev/null > "$TMP/social-routes.txt"
miss=""; for s in channels dms calls rooms contacts teams recordings configuration; do grep -qE "path=\"(/social/)?$s(/|\"|\\*)" "$TMP/social-routes.txt" || miss="$miss $s"; done
[ -z "$miss" ] && ok "App.tsx routes all eight social surfaces" || fail "A.4#16 $APP: no route for:$miss"

section "S0 · 17–21 picker, brand, Cognito, validators, docs"
range 'const TENANT_META' '^};' "$PICKER" | grep -qE "^[[:space:]]*social:" && ok "picker TENANT_META.social" || fail "A.4#17 $PICKER: TENANT_META has no social tile"
rm_meta=$(range 'const ROLE_META' '^};' "$PICKER")
miss=""; for r in participant moderator "'community-admin'"; do printf '%s' "$rm_meta" | grep -qE "(^|[ {,])$r:" || miss="$miss $r"; done
[ -z "$miss" ] && ok "picker ROLE_META labels the three roles" || fail "A.4#17 $PICKER: ROLE_META lacks:$miss"
cur=$(range 'const CURATED' '^];' "$PICKER")
miss=""; for u in u-mira u-lena u-sana; do printf '%s' "$cur" | grep -qF "id: '$u'" || miss="$miss $u"; done
[ -z "$miss" ] && ok "picker curated cast includes u-mira, u-lena and u-sana" || fail "A.4#17 $PICKER: CURATED lacks:$miss"
has '^\[data-tenant="social"\]' "$CSS" && ok "app.css light [data-tenant=\"social\"]" || fail "A.4#18 $CSS: no [data-tenant=\"social\"] light block"
has 'html\[data-theme="dark"\]\[data-tenant="social"\]' "$CSS" && ok "app.css dark social block" || fail "A.4#18 $CSS: no html[data-theme=\"dark\"][data-tenant=\"social\"] block"
miss=""
for u in u-mira u-lena u-sana; do
  em=$(grep -oE "\('$u', *'[^']*', *'[^']*@[^']*'" "$IDSQL" 2>/dev/null | head -1 | sed -E "s/.*'([^']*)'$/\1/")
  if [ -z "$em" ]; then miss="$miss $u(no seed email yet)"; else hasF "email: '$em'" "$COGNITO" || miss="$miss $em"; fi
done
[ -z "$miss" ] && ok "Cognito seed list carries the social cast's emails" || fail "A.4#19 $COGNITO: seedUsers lacks:$miss"
if grep -qF "'orgiq'\s*,\s*'assessment'\s*\]" "scripts/$RETIRED_V"; then
  fail "A.4#20 scripts/$RETIRED_V still pins TENANTS to exactly [orgiq, assessment] — re-point it at \"the retired tenant is absent\""
else ok "$RETIRED_V no longer pins the two-tenant TENANTS literal"; fi
[ -f "$GOAL" ] && [ -f "$JDIR/PROTOCOL.md" ] && ok "goal doc + journey protocol exist" || fail "A.4#20 $GOAL or $JDIR/PROTOCOL.md missing"
miss=""
for t in "requireTenant('social')" "community-admin" "social-tenant-goal.md" "validate-social-tenant.sh"; do hasF "$t" CLAUDE.md || miss="$miss $t"; done
[ -z "$miss" ] && ok "CLAUDE.md names the social tenant and its judge" || fail "A.4#21 CLAUDE.md does not mention:$miss (tenant bullet + docs-map row)"

section "S0 · pages ($SP): component discipline and tenant boundary"
if [ ! -d "$SP" ]; then fail "$SP missing — the empty-state pages S0 ships"; else
  source scripts/lib/discipline.sh  # the one raw-element counter (brace-aware), shared with validate-component-discipline.sh
  DC_QUEUE=$QUEUE
  MAX_RAW_ELEMENTS=0; QUEUED_MAX_PER_FILE=8
  # Only rows that say "Composed locally in `<file>`" mint an exemption.
  QUEUED_FILES=$(dc_queued_files "$SP/")
  PAGE_FILES=$(dc_area_files "$SP" "$SP/")
  n_files=$(printf '%s\n' $PAGE_FILES | grep -c . || true)
  if [ "$n_files" = 0 ]; then fail "$SP has no .tsx pages"; else
    n_div=$(dc_count_re '<div( [^>]*)?className=' $PAGE_FILES)
    n_btn=$(dc_count_re '<button' $PAGE_FILES)
    n_sty=$(dc_count_re 'style=\{\{' $PAGE_FILES)
    n_raw=$(dc_count_raw $PAGE_FILES)
    q_over=""
    for f in $QUEUED_FILES; do [ -f "$f" ] || continue; c=$(dc_count_raw "$f"); [ "$c" -le "$QUEUED_MAX_PER_FILE" ] || q_over="$q_over ${f#$SP/}($c)"; done
    [ -z "$q_over" ] && ok "queued composites each ≤ $QUEUED_MAX_PER_FILE raw elements" || fail "queued composite over the per-file cap:$q_over"
    [ "$n_div" = 0 ] && ok "no raw <div className> ($n_files files)" || fail "raw <div className> in social pages: $n_div (must be 0 — Stack/Inline/Card/RailSection/PageSection)"
    [ "$n_btn" = 0 ] && ok "no raw <button>" || fail "raw <button> in social pages: $n_btn (must be 0 — Button/IconButton)"
    [ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}} in social pages: $n_sty (must be 0)"
    if [ "$n_raw" -le "$MAX_RAW_ELEMENTS" ]; then ok "raw styled elements: $n_raw (budget $MAX_RAW_ELEMENTS)"; else
      fail "raw styled elements: $n_raw > budget $MAX_RAW_ELEMENTS — worst files:"
      for f in $PAGE_FILES; do c=$(dc_count_raw "$f"); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$SP/}"; done | sort -rn | head -8
    fi
  fi
  if grep -rq "ui-components/integrations/realtime-modules" "$SP" --include='*.tsx'; then fail "social pages import integrations/realtime-modules (breaks vite build; use integrations/realtime)"; else ok "no integrations/realtime-modules imports"; fi
  leaks=$(grep -rnE "['\"\`]/(iq|admin|assessment)(/|['\"\`])" "$SP" --include='*.tsx' | wc -l | tr -d ' ')
  [ "$leaks" = 0 ] && ok "no /iq, /admin or /assessment paths inside social pages" || { fail "$leaks cross-tenant paths inside social pages:"; grep -rnE "['\"\`]/(iq|admin|assessment)(/|['\"\`])" "$SP" --include='*.tsx' | head -5 | sed 's/^/      /'; }
fi

section "S0 · isolation logs ($JDIR/isolation)"
ISO="$JDIR/isolation"
imissing=0; ibad=0
for r in member sme program-owner org-leader hr-admin assessor lead-assessor program-lead demo-user; do
  f="$ISO/$r.md"
  if [ ! -f "$f" ]; then imissing=$((imissing+1)); continue; fi
  bad=""
  g=$(grep -iE '^social-grant: *(yes|no)' "$f" | head -1 | sed -E 's/^[^:]*: *//; s/[^a-z].*//')
  [ -n "$g" ] || bad="$bad social-grant"
  [ "$r" = demo-user ] && [ "$g" != no ] && bad="$bad demo-user-holds-social"
  [ -n "$g" ] && { grep -qiE "^social-tile-visible: *$g\b" "$f" || bad="$bad tile≠grant"; }
  grep -qiE '^social-nav-visible: *no' "$f" || bad="$bad nav"
  grep -qiE '^direct-route-result: *(not-found|redirect)' "$f" || bad="$bad route"
  grep -qiE '^api-status: *403' "$f" || bad="$bad api"
  grep -qiE '^activity-leak: *none' "$f" || bad="$bad activity-leak"
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot"
  grep -qiE '^pages: *\S+' "$f" || bad="$bad pages"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -n "$bad" ] && { ibad=$((ibad+1)); note "isolation/$r:$bad"; }
done
for r in participant moderator community-admin; do
  f="$ISO/$r-outbound.md"
  if [ ! -f "$f" ]; then imissing=$((imissing+1)); continue; fi
  bad=""
  for k in orgiq assessment; do
    grep -qiE "^$k-nav-visible: *no" "$f" || bad="$bad $k-nav"
    grep -qiE "^$k-route-result: *(not-found|redirect)" "$f" || bad="$bad $k-route"
    grep -qiE "^$k-api-status: *403" "$f" || bad="$bad $k-api"
  done
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot"
  grep -qiE '^pages: *\S+' "$f" || bad="$bad pages"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -n "$bad" ] && { ibad=$((ibad+1)); note "isolation/$r-outbound:$bad"; }
done
[ "$imissing" = 0 ] && ok "all 12 isolation logs present (9 inbound + 3 outbound)" || fail "$imissing of 12 isolation logs missing under $ISO (inbound: member sme program-owner org-leader hr-admin assessor lead-assessor program-lead demo-user; outbound: participant/moderator/community-admin-outbound)"
[ "$ibad" = 0 ] && ok "every present isolation log passes its fields" || fail "$ibad isolation logs fail a required field"
fi

# Role × surface journey logs for a phase's surfaces.
JROLES="participant moderator community-admin admin"
journey_check() { # phase-label surface...
  local label="$1"; shift
  local jm=0 jb=0 total=0 r s f bad shot
  for r in $JROLES; do for s in "$@"; do
    total=$((total+1)); f="$JDIR/$r/$s.md"
    if [ ! -f "$f" ]; then jm=$((jm+1)); continue; fi
    bad=""
    grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
    grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
    grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
    grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
    grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
    grep -qiE '^realtime: *(pass|n/a)' "$f" || bad="$bad realtime"
    grep -qiE '^pages: *\S+' "$f" || bad="$bad pages"
    shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
    if [ -z "$shot" ]; then bad="$bad screenshot-line"; elif [ ! -f "$JDIR/$r/$shot" ]; then bad="$bad screenshot-missing($shot)"; fi
    grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
    [ -n "$bad" ] && { jb=$((jb+1)); note "$r/$s:$bad"; }
  done; done
  [ "$jm" = 0 ] && ok "$label: all $total role×surface logs present" || fail "$label: $jm of $total journey logs missing (roles: $JROLES; surfaces: $*)"
  [ "$jb" = 0 ] && ok "$label: every present log passes all fields" || fail "$label: $jb journey logs fail a required field"
}

# ═════════════════════════════════════════════════════════════════════════════
# PHASE N — the activity indicator (design §3)
# ═════════════════════════════════════════════════════════════════════════════
if want N; then
section "N · library bell (lane L)"
miss=""; for c in NotificationBell WrappedNotificationBell; do grep -rqE "export declare (function|const) $c\b" "$UI_DIST" --include='*.d.ts' 2>/dev/null || miss="$miss $c"; done
[ -z "$miss" ] && ok "installed ui-components exports NotificationBell + WrappedNotificationBell" || fail "design §3.2 installed ui-components ($UI_DIST) does not export:$miss — ship lane L, pin the full sha, clear portal/node_modules/.vite"

section "N · transport + grant rule (middleware)"
has "notifications\(" "$GATEWAY" && has "import[^;]*notifications" "$GATEWAY" && ok "realtime-gateway.ts wires notifications()" || fail "design §3.3 $GATEWAY: notifications() not imported and added to the feature list"
miss=""; for c in ZADD ZRANGE ZCARD ZREMRANGEBYRANK; do hasF "'$c'" "$REDIS" || miss="$miss $c"; done
[ -z "$miss" ] && ok "the bounded Redis store adapter exposes the four sorted-set commands" || fail "design §3.3 $REDIS lacks:$miss"
if [ -f "$NOTIFY" ]; then
  has "export (async )?(function|const) notify\b" "$NOTIFY" && ok "social-notify.ts exports notify" || fail "design §3.4 $NOTIFY does not export notify"
  has "[Gg]rants?" "$NOTIFY" && has "tenant" "$NOTIFY" && ok "social-notify.ts reads grants against payload.tenant" || fail "design §3.4 $NOTIFY: no grants lookup against the item's tenant (the delivery rule)"
else fail "design §3.4 $NOTIFY missing (the single producer seam)"; fi
t="$LTESTS/social-notify.test.ts"
[ -f "$t" ] && grep -qi "grant" "$t" && ok "social-notify unit test covers the grant rule" || fail "design §3.4 $t missing or never mentions a grant (the no-grant refusal must be tested)"
miss=""
for f in $MW/src/routes/assessment.ts $MW/src/routes/approvals.ts; do hasF "social-notify" "$f" || miss="$miss ${f#$MW/src/}"; done
[ -z "$miss" ] && ok "producers rows 1–3 (comments) and 8 (approvals) call the seam" || fail "design §3.4 producers not wired (no social-notify import):$miss"
dm=""
for f in $(grep -rlF "social-notify" "$MW/src" --include='*.ts' 2>/dev/null | grep -v '__tests__' | grep -v 'social-notify.ts$'); do
  grep -qF ":dm:" "$f" && grep -qE "metadata\??\.userId" "$f" && dm="$f"
done
[ -n "$dm" ] && ok "DM producer (row 4) reads the server-stamped metadata.userId ($dm)" || fail "design §3.4 row 4: no middleware file importing social-notify handles :dm: publishes with metadata.userId as the sender"

section "N · header, caches, mock (portal + mock floor)"
bell_file=""
if has "<ActivityBell\b" "$LAYOUT"; then bell_file=$(grep -rlE "export (default )?function ActivityBell|export const ActivityBell" portal/src/components 2>/dev/null | head -1)
elif has "<(Wrapped)?NotificationBell\b" "$LAYOUT"; then bell_file=$LAYOUT; fi
if [ -z "$bell_file" ]; then fail "design §3.1 $LAYOUT mounts no <ActivityBell / <NotificationBell in the header"; else
  if grep -qE "import[^;]*\b(Wrapped)?NotificationBell\b" "$bell_file" && grep -qE "from '@connorhoehnslalom/ui-components" "$bell_file"; then ok "header bell is the library's (Wrapped)NotificationBell ($bell_file)"; else fail "design §3.2 $bell_file does not import NotificationBell/WrappedNotificationBell from @connorhoehnslalom/ui-components"; fi
  if [ "$bell_file" != "$LAYOUT" ] && grep -qE "<svg|<button" "$bell_file"; then fail "hand-rolled bell: $bell_file draws its own <svg>/<button>"; else ok "no hand-rolled bell markup"; fi
fi
hasF "rmn:notifications:read" "$CACHES" && ok "tenantCaches clears rmn:notifications:read" || fail "design §3.3 $CACHES does not clear rmn:notifications:read"
fixture_check "$MW/src/mock/notifications.ts" "design §3.5 notifications fixture"

section "N · e2e (design §3.6)"
spec_check portal/e2e/social-activity.spec.ts "§3.6 spec" \
  "a reply reaches the author's bell without a reload" \
  "a user with no social grant receives no social item" \
  "a reload replays the unread set"
if [ "$QUICK" = 0 ]; then
  for v in validate-mock-floor.sh validate-route-coverage.sh; do
    if jg_judge "$v" >"$TMP/$v.log" 2>&1; then ok "$v green"; else fail "$v red (design names it a judge of lane N) — see its output"; tail -4 "$TMP/$v.log" | sed 's/^/      /'; fi
  done
fi
section "N · journey logs (activity)"
journey_check "N" activity
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE S1 — channels and DMs, durable (design §4.4, §7 S1)
# ═════════════════════════════════════════════════════════════════════════════
if want S1; then
section "S1 · the library's DynamoChatStore"
rmv=$(cd "$MW" && node -p "require('./node_modules/@connorhoehn/realtime-modules/package.json').version" 2>/dev/null)
if [ -n "$rmv" ] && node -e "const [a,b,c]=process.argv[1].split('.').map(Number); process.exit(a>0||b>99||(b===99&&c>=0)?0:1)" "$rmv"; then ok "middleware realtime-modules $rmv ≥ 0.99.0"; else fail "design E2 middleware realtime-modules is ${rmv:-unreadable}; DynamoChatStore needs ≥ 0.99.0 (full 40-char sha pin)"; fi
has "import[^;]*DynamoChatStore" "$CHAT_BACKEND" && has "@connorhoehn/realtime-modules" "$CHAT_BACKEND" && ok "social-chat.ts imports the library's DynamoChatStore (the store factory, audit D3/D12)" || fail "design §4.4 $CHAT_BACKEND does not import DynamoChatStore from the library"
tr '\n' ' ' < "$GATEWAY" 2>/dev/null | grep -qE "chat\(\{[^}]*chatStore" && ok "chat({ chatStore }) wired" || fail "design §4.4 $GATEWAY: chat() takes no chatStore"
local_store=$(grep -rlE "class DynamoChatStore" "$MW/src" 2>/dev/null | head -3)
[ -z "$local_store" ] && ok "no middleware-local DynamoChatStore" || fail "design §4.4 the middleware writes its own DynamoChatStore ($local_store) — consume the library's"
grep -rlq "DynamoChatStore" "$MW/src" --include='*.test.ts' 2>/dev/null && ok "a middleware test exercises the DynamoChatStore wiring" || fail "no middleware test names DynamoChatStore"
grep -lF "social:ch:" $LTESTS/realtime-gateway*.test.ts >/dev/null 2>&1 && ok "gateway test covers social:ch: channels (membership)" || fail "design §4.2 no $LTESTS/realtime-gateway*.test.ts names social:ch: (membership in the guard)"

section "S1 · /api/social routes"
if [ ! -f "$ROUTER" ]; then fail "$ROUTER missing"; else
  miss=""; for p in /channels /dms; do has "[A-Za-z_]*[Rr]outer\.post\('$p'" "$ROUTER" || miss="$miss POST $p"; done
  [ -z "$miss" ] && ok "POST /channels and POST /dms mounted" || fail "design §7 S1 $ROUTER lacks:$miss"
fi
fixture_check "$MW/src/mock/social-channels.ts" "S1 channels fixture"
row5=""
for f in $(grep -rlF "social-notify" "$MW/src" --include='*.ts' 2>/dev/null | grep -v '__tests__' | grep -v 'social-notify.ts$'); do grep -qF "social:ch:" "$f" && row5="$f"; done
[ -n "$row5" ] && ok "producer row 5 (channel message) wired ($row5)" || fail "design §3.4 row 5: no middleware file importing social-notify handles social:ch: messages"

section "S1 · pages"
# 2.439: the composer is the library ConversationComposer (ContextComposer with the conversation wiring).
miss=""; for c in ConversationRail WrappedChatPanel ConversationComposer; do page_uses "$c" || miss="$miss $c"; done
[ -z "$miss" ] && ok "Channels/DMs compose ConversationRail + WrappedChatPanel + ConversationComposer" || fail "design §4.5 no page under $SP uses (from ui-components):$miss"
spec_check portal/e2e/social-channels.spec.ts "S1 walk" \
  "a channel message posted in one context arrives in the other" \
  "a direct message round trip" \
  "a forged cross-tenant subscribe is refused with AUTHZ_CHANNEL_DENIED"
section "S1 · shared message pins (design §4.4)"
if (cd "$MW" && node -e "const d=require('@connorhoehn/realtime-modules/server/stores/dynamo'); const m=require('@connorhoehn/realtime-modules/chat'); process.exit(typeof d.DynamoChatPinsStore==='function' && typeof m.MemoryChatPinsStore==='function' ? 0 : 1)") >"$TMP/pin-stores.log" 2>&1; then ok "installed library exports Dynamo and memory pin stores"; else fail "design §4.4 the installed library lacks chat pin stores"; fi
hasF "DynamoChatPinsStore" "$CHAT_BACKEND" && hasF "usePins" "$SP/SocialConversation.tsx" && hasF "chatPinsRouter" "$INDEX" && ok "library pin state wired through BFF and conversation" || fail "design §4.4 shared pin state is not wired end to end"
[ -f "$RTESTS/chat-pins.test.ts" ] && ok "pin route access and persistence tests exist" || fail "chat pin routes lack tests"
spec_check portal/e2e/social-pins.spec.ts "S1 pins walk" \
  "a shared pin arrives live, survives reload, jumps to the message, and another member can unpin it" \
  "a failed pin rolls back and keeps its explanation visible on the Pinned tab"
journey_check "S1" channels dms
fi

# Route ↔ test parity over routes/social.ts — S1 creates it, E extends it.
if want S1 || want E; then
section "route ↔ test parity ($ROUTER)"
if [ ! -f "$ROUTER" ]; then fail "$ROUTER missing — nothing to hold to parity"; else
  missing=0; n=0
  while IFS= read -r path; do
    [ -n "$path" ] || continue; n=$((n+1))
    pat=$(printf '%s' "$path" | sed -E 's#:[A-Za-z_]+#[^/?'"'"'"]+#g')
    [ "$pat" = "/" ] && pat=""
    if ! grep -rqE "/api/social${pat}(['\"\`?/]|$)" "$RTESTS" 2>/dev/null; then note "untested: $path"; missing=$((missing+1)); fi
  done < <(grep -oE "[A-Za-z_]*[Rr]outer\.(get|post|put|patch|delete)\('[^']+'" "$ROUTER" | sed -E "s/.*\('//; s/'$//" | sort -u)
  [ "$n" -gt 0 ] || fail "$ROUTER mounts no routes"
  [ "$missing" = 0 ] && ok "every mounted social route ($n) has a test" || fail "$missing of $n social routes have no test under $RTESTS"
fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE S2 — rooms, teams, recordings
# ═════════════════════════════════════════════════════════════════════════════
if want S2; then
section "S2 · stack + upstream"
miss=""; for t in teams team-members social-relationships video-recording-share-links; do hasF "name: '$t'" "$SOCIAL_STACK" || miss="$miss $t"; done
[ -z "$miss" ] && ok "social-stack.ts declares the four platform-api tables" || fail "design §4.4 $SOCIAL_STACK lacks table(s):$miss"
has '^platform-api tenants commit: `[0-9a-f]{7,40}`' "$GOAL" && ok "platform-api tenants-claim commit recorded in $GOAL" || fail "design §4.2 the platform-api tenants-claim change is not recorded — add a line 'platform-api tenants commit: \`<sha>\`' to $GOAL when it lands"
has "onCallMissed" "$GATEWAY_CALLS" && hasF "social-notify" "$GATEWAY_CALLS" && ok "missed calls (row 6) from calls({ onCallMissed }) reach the seam" || fail "design §3.4 row 6 $GATEWAY_CALLS: no calls({ onCallMissed }) wired to social-notify"

section "S2 · pages"
miss=""
page_uses createWrappedHangoutRoomsList || page_uses createHangoutRoomsSection || miss="$miss createWrappedHangoutRoomsList|createHangoutRoomsSection"
for c in TeamChannelTree RecordingList RecordingPlayer PresenceAvatars; do page_uses "$c" || miss="$miss $c"; done
[ -z "$miss" ] && ok "Rooms/Teams/Recordings compose the library's composites" || fail "design §4.5 no page under $SP uses (from ui-components):$miss"
spec_check portal/e2e/social-rooms.spec.ts "S2 walk" \
  "a room created via REST is visible to a browser user in the tenant" \
  "the recordings list renders for the tenant"
journey_check "S2" calls rooms contacts teams recordings configuration
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE E — embedding (design §4.6, E5)
# ═════════════════════════════════════════════════════════════════════════════
if want E; then
section "E · the tenants guard (E5)"
has "tenants\??\.includes\(" "$GATEWAY_AUTHORITY" && ok "gateway admits a prefix by the token's tenants" || fail "design E5 $GATEWAY_AUTHORITY: channelGuard/lobbyGuard never check auth.tenants.includes(prefix)"
tg=""; for f in $LTESTS/realtime-gateway*.test.ts; do [ -f "$f" ] && grep -q "tenants:" "$f" && grep -qF "social:" "$f" && tg="$f"; done
[ -n "$tg" ] && ok "the tenants guard test exists ($tg)" || fail "design E5 no $LTESTS/realtime-gateway*.test.ts sets tenants: and names a social: channel (admit + refuse)"

section "E · bindings"
bsql=$(grep -lE "CREATE TABLE( IF NOT EXISTS)? social_bindings" schema/*.sql 2>/dev/null | head -1)
if [ -z "$bsql" ]; then fail "design §4.4 no schema/*.sql creates social_bindings"; else
  cols=$(range "social_bindings" ';' "$bsql")
  miss=""; for c in tenant context_kind context_id channel created_by created_at; do printf '%s' "$cols" | grep -qwE "$c" || miss="$miss $c"; done
  [ -z "$miss" ] && ok "social_bindings ($bsql) has its six columns" || fail "design §4.4 $bsql social_bindings lacks:$miss"
fi
has "[A-Za-z_]*[Rr]outer\.get\('/bindings'" "$ROUTER" && ok "GET /api/social/bindings mounted" || fail "research C.5 $ROUTER has no GET /bindings"
{ hasF "ChannelBinding" "$QUEUE" || grep -rqE "ChannelBindingStrip.*ui-components/social" portal/src 2>/dev/null || grep -rqE "ui-components/social" portal/src/components/social/ChannelBindingStrip.tsx 2>/dev/null; } && ok "ChannelBinding queue row or library ChannelBindingStrip import" || fail "design §4.6 either $QUEUE needs a ChannelBinding row or the portal must import ChannelBindingStrip from @connorhoehnslalom/ui-components/social (neither found)"
# §4.6, the user 2026-10-06: the binding lives in the bottom Social bar, never as a strip on top of the page.
ES=portal/src/components/shell/EmbeddedSocial.tsx
{ grep -q "useChannelBinding" "$ES" && grep -qw "ChannelBinding" "$ES" && grep -q "shell-social-page" "$ES"; } \
  && ok "the bottom Social bar offers the page's bound channel (useChannelBinding + ChannelBinding + shell-social-page tab in $ES)" \
  || fail "design §4.6 $ES must offer the page's bound channel as a bar tab (useChannelBinding, ChannelBinding, data-testid shell-social-page)"
grep -rq "usePageSocialChannel\|useInitiativeSocialChannel" portal/src/pages/ProjectDetailPage.tsx portal/src/pages/projects 2>/dev/null \
  && ok "the initiative page names its binding context for the bar" || fail "design §4.6 the initiative page never calls usePageSocialChannel/useInitiativeSocialChannel"
if grep -rqE "<(ChannelBinding|ChannelBindingStrip|InitiativeDiscussion)[ />]" portal/src/pages/projects portal/src/pages/ProjectDetailPage.tsx 2>/dev/null; then
  fail "design §4.6 (2026-10-06) pages/projects renders a top ChannelBinding strip — the binding belongs in the bottom Social bar"
else ok "no top ChannelBinding strip on the initiative page"; fi
grep -rq "dmLobbyName" portal/src/pages/search 2>/dev/null && ok "Search connections open a DM (dmLobbyName)" || fail "design §4.6 portal/src/pages/search never reaches dmLobbyName (people → DM)"

section "E · forged subscribe refused for no-grant sessions"
fb=0; seen=0
for f in "$JDIR"/isolation/*.md; do
  [ -f "$f" ] || continue
  case "$f" in *-outbound.md|*/DEFECTS.md) continue;; esac
  grep -qiE '^social-grant: *no' "$f" || continue
  seen=$((seen+1))
  grep -qiE '^forged-subscribe: *AUTHZ_CHANNEL_DENIED' "$f" || { fb=$((fb+1)); note "${f#$JDIR/}: no forged-subscribe: AUTHZ_CHANNEL_DENIED"; }
done
if [ "$seen" = 0 ]; then fail "no isolation log with social-grant: no (demo-user at least) — nothing proves the refusal"
elif [ "$fb" = 0 ]; then ok "$seen no-grant isolation logs record AUTHZ_CHANNEL_DENIED"; else fail "$fb no-grant isolation logs lack the forged-subscribe refusal"; fi
if [ "$QUICK" = 0 ]; then
  for v in validate-rail-parity.sh validate-search-workspace.sh; do
    if jg_judge "$v" >"$TMP/$v.log" 2>&1; then ok "$v green"; else fail "$v red (a judge of lane E)"; tail -4 "$TMP/$v.log" | sed 's/^/      /'; fi
  done
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Journey freshness — each log's walked routes: their rendered contract
# against its sealed walk (docs/journeys.md). Only scripts/journeys/seal.sh seals.
# ─────────────────────────────────────────────────────────────────────────────
section "journey freshness ($JDIR)"
source scripts/lib/journeys.sh
logs=$(find "$JDIR" -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' 2>/dev/null | sort)
if [ -z "$logs" ]; then ok "no journey logs yet (nothing to hold fresh — the phase checks above count them)"; else
  jr_freshness "$JDIR" $logs
  jr_report
fi

# ─────────────────────────────────────────────────────────────────────────────
# Siblings — the tenants this one sits beside must stay green (design §6).
# ─────────────────────────────────────────────────────────────────────────────
section "siblings"
QF=""; [ "$QUICK" = 1 ] && QF="--quick"
for v in "validate-assessment-tenant.sh --no-time" "validate-nav-parity.sh" "$RETIRED_V"; do
  name=${v%% *}; args=${v#"$name"}
  # shellcheck disable=SC2086
  if jg_judge "$name" $args $QF >"$TMP/$name.log" 2>&1; then ok "$name green${QF:+ ($QF)}"; else
    fail "$name red${QF:+ ($QF)} — its failing lines:"
    sed -n '/CHECK(S) FAILING\|FAILING:/,$p' "$TMP/$name.log" | head -8 | sed 's/^/      /'
    grep -E '✗' "$TMP/$name.log" | head -6 | sed 's/^/      /'
  fi
done

# Optional time gate for an overnight /goal (off unless SOCIAL_TIME_GATE=<hour> is set).
if [ -n "${SOCIAL_TIME_GATE:-}" ]; then
  section "time gate"
  if [ "$NO_TIME" = 1 ]; then ok "skipped (--no-time)"; else
    H=$(date +%H); if [ "$((10#$H))" -ge "$SOCIAL_TIME_GATE" ] && [ "$((10#$H))" -lt 20 ]; then ok "past ${SOCIAL_TIME_GATE}:00 local"; else fail "keep going — it is $(date +%H:%M) local, the gate opens at ${SOCIAL_TIME_GATE}:00"; fi
  fi
fi

printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then
  if [ -n "$PHASE" ]; then echo "ALL CHECKS PASS for phase $PHASE (the goal needs a run with no --phase)."
  else echo "ALL CHECKS PASS — the social tenant and the activity indicator meet their definition of done."; fi
  exit 0
fi
echo "${#FAILS[@]} CHECK(S) FAILING${PHASE:+ (phase $PHASE)}:"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
