#!/usr/bin/env bash
# Definition of done for docs/communication-plane-goal.md — the Communication
# plane: the Social tenant's workspace seen from orgiq / assessment / pipelines,
# shaped by the signed-in user's org context. Judge items 1-6 of the goal doc.
# Exit 0 only when every check passes; every failing line prints, naming exactly
# what is missing.
#
# Usage: scripts/validate-communication-plane.sh [--quick]
#   --quick skips jest, tsc/build, the sibling gates' slow halves and the browser.
#
# The browser half runs portal/e2e/communication-plane.spec.ts and
# communication-shared-work.spec.ts against PARITY_BASE_URL (default
# http://localhost:5183; needs the Tilt / dev:mock:social stack). An
# unreachable portal is a FAILURE, not a skip.
#
# Journey logs are sealed per directory by scripts/journeys/seal.sh after a
# real walk, and judged by their routes' rendered contracts (docs/journeys.md).
# This judge never seals.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; *) echo "unknown flag: $a" >&2; exit 2;; esac; done

FAILS=()
ok()      { printf '  ✓ %s\n' "$1"; }
fail()    { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note()    { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/validate-communication.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

MW=middleware
PO=portal
JDIR=docs/communication-journeys
RTESTS=$MW/src/routes/__tests__
AUTH_TEST=$RTESTS/communication-plane-authority.test.ts
SPEC1=$PO/e2e/communication-plane.spec.ts
SPEC2=$PO/e2e/communication-shared-work.spec.ts
DESIGN=docs/social-tenant-design.md
NAVDOC=docs/nav-server-tier-decisions.md
BASE=${PARITY_BASE_URL:-http://localhost:5183}
Q=""; [ "$QUICK" = 1 ] && Q="--quick"

# titles of it(...) / test(...) cases in a file (one per line, lower-cased)
titles() { grep -hoE "\b(it|test)(\.each\([^)]*\))?\(\s*[\`'\"][^\`'\"]+" "$@" 2>/dev/null | sed -E "s/^[^\`'\"]*[\`'\"]//" | tr 'A-Z' 'a-z'; }
# does some test title in the given files match the ERE?
has_title() { local re=$1; shift; titles "$@" | grep -qE -- "$re"; }

# ─────────────────────────────────────────────────────────────────────────────
section "1. routes exist and are tested (static route inventory + request(...) calls)"
cat > "$TMP/routes.ts" <<TS
import { scanCoverage } from '$PWD/$MW/src/mock/core/coverage/scan.js';
const r = scanCoverage();
for (const row of r.rows) console.log(['ROW', row.route.method, row.route.path, row.tested ? 'tested' : 'untested', row.route.source].join(' '));
TS
if (cd "$MW" && node node_modules/.bin/tsx "$TMP/routes.ts" > "$TMP/routes.txt" 2>"$TMP/routes.err"); then
  check_route() { # method path
    local line; line=$(awk -v m="$1" -v p="$2" '$1=="ROW" && $2==m && $3==p {print; exit}' "$TMP/routes.txt")
    if [ -z "$line" ]; then fail "route missing from the static inventory: $1 $2"
    elif [ "$(echo "$line" | awk '{print $4}')" != tested ]; then fail "route exists but no request(...) test calls it: $1 $2 ($(echo "$line" | awk '{print $5}'))"
    else ok "$1 $2 exists and is tested"; fi
  }
  check_route GET /api/social/plane/active
  check_route GET /api/social/plane/people/:userId/shared-work
  check_route GET /api/social/plane/work-graph/conversations/:id/graph
  check_route GET /api/me/groups
else
  fail "route inventory scan crashed — see $(head -c 300 "$TMP/routes.err" | tr '\n' ' ')"
fi
# One "mine" reader (docs/audit/2026-10-07-audit-plan.md D4): every kind the plane lists comes from lib/mine.ts.
for k in initiative org-team assessment-team pipeline; do
  grep -qE "'$k'" $MW/src/lib/mine.ts 2>/dev/null && ok "lib/mine.ts reads kind=$k" || fail "middleware/src/lib/mine.ts missing or has no reader for kind=$k"
done
for gone in routes/org-teams.ts routes/plane-groups.ts providers/plane-groups.ts; do
  [ -e "$MW/src/$gone" ] && fail "retired reader still present: middleware/src/$gone (the one shape is GET /api/me/groups)" || ok "retired reader gone: $gone"
done
grep -rqE "norm\(team\.assessment_lead\)|displayName\) *=== *name" $MW/src/lib $MW/src/providers --include='*.ts' 2>/dev/null \
  && fail "assessment team membership still matched by display name" || ok "assessment team membership is a row (assessment_team_members), not a name match"
# the team binding kind: BINDING_CONTEXT_TENANT.team = 'orgiq'
bct=$(grep -rn "BINDING_CONTEXT_TENANT" $MW/src --include='*.ts' -l 2>/dev/null | grep -v __tests__ | head -1)
if [ -n "$bct" ] && awk '/BINDING_CONTEXT_TENANT/{f=1} f&&/team *: *.orgiq./{found=1} f&&/}/{if(found){print "y"; exit}}' "$bct" | grep -q y; then
  ok "social_bindings has a 'team' context kind mapped to orgiq ($bct)"
else fail "BINDING_CONTEXT_TENANT has no team: 'orgiq' entry (social_bindings team kind)"; fi
grep -rqE "context_kind.*team|'team'" schema/social_schema.sql 2>/dev/null \
  && ok "schema/social_schema.sql admits the team binding kind" \
  || fail "schema/social_schema.sql context_kind does not admit 'team'"
if jg_judge validate-route-coverage.sh >"$TMP/rc.log" 2>&1; then ok "validate-route-coverage.sh stays green"
else fail "validate-route-coverage.sh failing"; grep -E '✗' "$TMP/rc.log" | head -5 | sed 's/^/      /'; fi

# ─────────────────────────────────────────────────────────────────────────────
section "2. authority contracts"
if [ ! -f "$AUTH_TEST" ]; then
  fail "$AUTH_TEST missing"
else
  ok "$AUTH_TEST exists"
  for path in "plane/active" "shared-work" "work-graph/conversations"; do
    grep -qF "$path" "$AUTH_TEST" && ok "authority test exercises $path" || fail "$AUTH_TEST never exercises $path"
  done
  # GET /api/me/groups is a host-tenant route (the kind's tenant boundary inside), so its
  # linked-person / unlinked / forged-query / other-tenant / outage cases live in
  # their own suite rather than the Social-plane one.
  TEAMS_TEST=middleware/src/routes/__tests__/me-groups.test.ts
  if grep -qF "me/groups" "$AUTH_TEST" "$TEAMS_TEST" 2>/dev/null; then ok "authority test exercises me/groups ($TEAMS_TEST)"
  else fail "neither $AUTH_TEST nor $TEAMS_TEST exercises me/groups"; fi
  has_title "unlinked" "$TEAMS_TEST" && ok "me-groups case named for: unlinked account" || fail "$TEAMS_TEST has no case for an unlinked account"
  has_title "another tenant|cross.tenant" "$TEAMS_TEST" && ok "me-groups case named for: another tenant refused" || fail "$TEAMS_TEST has no case refusing another tenant"
  has_title "namesake|display name" "$TEAMS_TEST" && ok "me-groups case named for: a namesake is not a member" || fail "$TEAMS_TEST has no case for a namesake (display-name matching must stay retired)"
  for sc in "participant" "manager" "no.grant|without a (social )?grant|no social grant" "forged cookie|forged (cookie|grant)" "revoked" "epoch" "cross.tenant|forged tenant"; do
    has_title "$sc" "$AUTH_TEST" && ok "authority case named for: $sc" || fail "$AUTH_TEST has no it('…')/test('…') title matching: $sc"
  done
fi
SW_FILES=$(grep -rlE "shared-work" $RTESTS $MW/src/lib --include='*.test.ts' 2>/dev/null | tr '\n' ' ')
if [ -z "$SW_FILES" ]; then fail "no jest file covers shared-work (owner / audience / outsider / historical)"; else
  for sc in owner audience outsider historical; do
    # shellcheck disable=SC2086
    has_title "$sc" $SW_FILES && ok "shared-work case: $sc" || fail "shared-work tests have no case titled with '$sc' (searched: $SW_FILES)"
  done
fi
for f in social-work-sharing; do
  grep -rqE "register.*['\"]social-work-sharing['\"]|['\"]social-work-sharing['\"]" $MW/src/mock --include='*.ts' 2>/dev/null \
    && ok "mock fixture $f registered" || fail "mock fixture '$f' not registered under middleware/src/mock"
done
grep -rqE "filterForViewer" $MW/src --include='*.ts' --exclude-dir=__tests__ 2>/dev/null \
  && ok "shared-work filters with the library's filterForViewer" || fail "no non-test middleware file calls filterForViewer (shared-work filtering)"
grep -rqE "socialGate\(" $MW/src/routes/social-plane.ts 2>/dev/null && grep -rqE "socialGate\(" $MW/src/routes/social.ts 2>/dev/null \
  && ok "social-plane.ts and social.ts gate on the one socialGate (lib/social-authority.ts)" || fail "routes/social-plane.ts or routes/social.ts does not gate on socialGate"
grep -rqE "requireAction\(|markPlaneRequest|personalTeamSession|embedGate" $MW/src/routes/social.ts $MW/src/routes/social-plane.ts 2>/dev/null \
  && fail "a second Social gate survives in routes/social.ts or social-plane.ts" || ok "no second Social gate (requireAction / markPlaneRequest / personalTeamSession / embedGate) remains"

# ─────────────────────────────────────────────────────────────────────────────
section "3. portal composites (grep in pages/communication/** + components/communication/**)"
PLANE_DIRS=""; for d in $PO/src/pages/communication $PO/src/components/communication; do [ -d "$d" ] && PLANE_DIRS="$PLANE_DIRS $d"; done
if [ ! -f $PO/src/pages/communication/CommunicationPlane.tsx ]; then fail "$PO/src/pages/communication/CommunicationPlane.tsx missing"; fi
# The composites may be mounted by the plane, the rail model, SharedWorkView or the shared workspace.
SRC=""
for f in $PO/src/pages/communication $PO/src/components/communication $PO/src/pages/social/SocialChatWorkspace.tsx $PO/src/pages/social/SharedWorkView.tsx $PO/src/pages/social/socialChat.ts $PO/src/lib/communicationPlane.ts; do [ -e "$f" ] && SRC="$SRC $f"; done
need_comp() { # symbol
  # shellcheck disable=SC2086
  grep -rqE "\b$1\b" $SRC --include='*.ts' --include='*.tsx' 2>/dev/null && ok "composite used: $1" || fail "no $1 in the plane / workspace / rail-model sources"
}
for c in ConversationRail ActivePeopleGrid TeamChannelTree WorkGraph ActionRowList; do need_comp "$c"; done
[ -f $PO/src/pages/social/SharedWorkView.tsx ] && ok "pages/social/SharedWorkView.tsx exists" || fail "$PO/src/pages/social/SharedWorkView.tsx missing (Shared work view)"
for lbl in "My initiatives" "My teams" "My pipelines" "My org teams" "Active now" "Shared work"; do
  # shellcheck disable=SC2086
  grep -rqF "$lbl" $SRC --include='*.ts' --include='*.tsx' 2>/dev/null && ok "section label present: $lbl" || fail "section label \"$lbl\" not found in the plane sources"
done
grep -rqF "Link your account to a person" $SRC --include='*.ts' --include='*.tsx' 2>/dev/null \
  && ok "no-linked-person row copy present" || fail "\"Link your account to a person to see your groups\" row missing"
if [ -n "$PLANE_DIRS" ]; then
  n_div=$(grep -rE '<(div|span|section|header|main|aside|ul|li|p|a|img|table)[ >]' $PLANE_DIRS --include='*.tsx' 2>/dev/null | grep -v __tests__ | wc -l | tr -d ' ')
  n_btn=$(grep -rE '<(button|input|select|textarea)[ >/]' $PLANE_DIRS --include='*.tsx' 2>/dev/null | grep -v __tests__ | wc -l | tr -d ' ')
  n_sty=$(grep -rF 'style={{' $PLANE_DIRS --include='*.tsx' 2>/dev/null | grep -v __tests__ | wc -l | tr -d ' ')
  [ "$n_div" = 0 ] && ok "no raw layout elements in the plane dirs" || { fail "raw layout/text elements in plane dirs: $n_div"; grep -rnE '<(div|span|section|header|main|aside|ul|li|p|a|img|table)[ >]' $PLANE_DIRS --include='*.tsx' | grep -v __tests__ | head -5 | sed 's/^/      /'; }
  [ "$n_btn" = 0 ] && ok "no raw form elements in the plane dirs" || fail "raw button/input/select/textarea in plane dirs: $n_btn"
  [ "$n_sty" = 0 ] && ok "no inline style={{}} in the plane dirs" || fail "inline style={{}} in plane dirs: $n_sty"
fi
for gate in component-discipline nav-parity; do
  if jg_judge validate-$gate.sh $Q >"$TMP/$gate.log" 2>&1; then ok "validate-$gate.sh passes"
  else fail "validate-$gate.sh failing"; grep -E '✗|FAIL' "$TMP/$gate.log" | head -6 | sed 's/^/      /'; fi
done
if jg_judge validate-rail-parity.sh --quick >"$TMP/rail.log" 2>&1; then ok "validate-rail-parity.sh --quick passes"
else fail "validate-rail-parity.sh --quick failing (Communication section / chat-rail mode)"; grep -E '✗|FAIL' "$TMP/rail.log" | head -6 | sed 's/^/      /'; fi
if [ "$QUICK" = 0 ]; then
  if bash scripts/validate-rail-parity.sh >"$TMP/rail-full.log" 2>&1; then ok "validate-rail-parity.sh (full, chat-rail mode) passes"
  else fail "validate-rail-parity.sh full run failing"; grep -E '✗|FAIL' "$TMP/rail-full.log" | head -6 | sed 's/^/      /'; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "4. browser specs"
for s in "$SPEC1" "$SPEC2"; do [ -f "$s" ] && ok "$s exists" || fail "$s missing"; done
if [ -f "$SPEC2" ]; then
  for kw in "u-mira" "u-vera" "shared-work|shared work" "deck" "page reference|pageReference"; do
    grep -qiE "$kw" "$SPEC2" && ok "shared-work spec covers: $kw" || fail "$SPEC2 never mentions: $kw"
  done
fi
if [ -f "$SPEC1" ]; then
  for kw in "u-vera" "Active now" "My initiatives" "My org teams" "auth-migration" "u-asha" "u-tomas" "/iq/communication"; do
    grep -qF -- "$kw" "$SPEC1" && ok "plane spec covers: $kw" || fail "$SPEC1 never mentions: $kw"
  done
  # judge item 6: the /api/social allowlist
  blk=$(awk 'tolower($0) ~ /allowlist|allowed_social|allow_social/ {f=1; c=0} f {print; if (++c>14) exit}' "$SPEC1")
  if [ -z "$blk" ]; then fail "$SPEC1 has no /api/social allowlist (a constant named *allowlist* / ALLOWED_SOCIAL…)"
  else
    miss=""; for t in "plane/" embedded dms share-destinations bindings; do echo "$blk" | grep -qF -- "$t" || miss="$miss $t"; done
    [ -z "$miss" ] && ok "spec's /api/social allowlist names plane/, embedded, dms, share-destinations, bindings" || fail "spec's /api/social allowlist is missing:$miss"
    extra=$(echo "$blk" | grep -oE "['\"\`/](channels|teams|rooms|calls|recordings|contacts|configuration|summary|pins|activity)[/'\"\`]" | sort -u | tr '\n' ' ')
    [ -z "$extra" ] && ok "allowlist admits nothing beyond the five prefixes" || fail "spec's /api/social allowlist admits more than the five prefixes: $extra"
  fi
fi
if [ "$QUICK" = 0 ]; then
  if curl -s -m 5 -o /dev/null "$BASE/"; then
    if (cd $PO && PARITY_BASE_URL="$BASE" npx playwright test e2e/communication-plane.spec.ts e2e/communication-shared-work.spec.ts --reporter=line >"$TMP/e2e.log" 2>&1); then
      ok "both specs passed against $BASE: $(sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$TMP/e2e.log" | grep -E '[0-9]+ passed' | tail -1 | xargs)"
    else
      fail "Playwright specs failed against $BASE"
      sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$TMP/e2e.log" | grep -vE '^\s*$' | tail -20 | sed 's/^/      /'
    fi
  else fail "NOT-REACHABLE: no portal at $BASE (start the Tilt / dev:mock:social stack, or set PARITY_BASE_URL) — the browser half did not run"; fi
else note "browser half skipped (--quick)"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "jest, portal tests, typecheck/build (full mode)"
if [ "$QUICK" = 0 ]; then
  SUITES=$(cd $MW && find src -path '*__tests__*' \( -name 'communication-plane*.test.ts' -o -name 'social-plane*.test.ts' -o -name 'social-work*.test.ts' -o -name 'me-groups*.test.ts' -o -name 'shared-work*.test.ts' \) | sort | tr '\n' ' ')
  if [ -z "$SUITES" ]; then fail "no communication-plane jest suites found under middleware/src"
  elif (cd $MW && npx jest --config jest.config.cjs $SUITES >"$TMP/jest.log" 2>&1); then ok "middleware plane suites pass: $(grep -E '^Tests:' "$TMP/jest.log")"
  else fail "middleware plane jest suites failing"; grep -E '●|^Tests:' "$TMP/jest.log" | head -12 | sed 's/^/      /'; fi
  if jg_mw_typecheck >"$TMP/mw-tsc.log" 2>&1; then ok "middleware typecheck clean"; else fail "middleware typecheck failing"; head -8 "$TMP/mw-tsc.log" | sed 's/^/      /'; fi
  PT=$(cd $PO && grep -rlE "communication|SharedWork|socialPlane" src --include='*.test.ts' --include='*.test.tsx' 2>/dev/null | sort | tr '\n' ' ')
  if [ -z "$PT" ]; then fail "no portal unit tests mention the plane / shared work"
  elif (cd $PO && npx vitest run $PT >"$TMP/portal.log" 2>&1) || (cd $PO && node --test $PT >"$TMP/portal.log" 2>&1); then ok "portal plane tests pass"
  else fail "portal plane tests failing"; tail -12 "$TMP/portal.log" | sed 's/^/      /'; fi
  if jg_portal_tsc >"$TMP/po-tsc.log" 2>&1; then ok "portal tsc clean"; else fail "portal tsc errors"; head -8 "$TMP/po-tsc.log" | sed 's/^/      /'; fi
  if jg_vite_build >"$TMP/po-build.log" 2>&1; then ok "portal build clean"; else fail "portal build failing"; tail -8 "$TMP/po-build.log" | sed 's/^/      /'; fi
else note "skipped (--quick)"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "5. journey logs ($JDIR) — complete, valid, sealed"
# directory → required surfaces (the goal's: rail, active-now, groups, org-teams, shared-work, footer-social)
declare_surfaces() {
  case "$1" in
    member|org-leader) echo "rail active-now groups org-teams shared-work footer-social";;
    assessment|pipelines) echo "rail active-now groups shared-work footer-social";;
    no-grant) echo "rail footer-social";;
  esac
}
source scripts/lib/journeys.sh  # jr_*: journey freshness (docs/journeys.md)
missing=""; invalid=""; walked=""; total=0
for dir in member org-leader no-grant assessment pipelines; do
  [ -f "$JDIR/$dir/DEFECTS.md" ] || missing="$missing $dir/DEFECTS.md"
  for s in $(declare_surfaces $dir); do
    f="$JDIR/$dir/$s.md"; total=$((total+1))
    if [ ! -f "$f" ]; then missing="$missing $dir/$s.md"; continue; fi
    bad=""
    for fld in surface role user url audited screenshot verdict 'console errors' layout keyboard 'empty-state' realtime; do
      grep -qiE "^$fld: *\S+" "$f" || bad="$bad $fld"
    done
    grep -qE '^verdict: *pass' "$f" || bad="$bad verdict-not-pass"
    grep -qiE '\b(TODO|unverified|placeholder)\b' "$f" && bad="$bad TODO/unverified/placeholder"
    shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
    [ -n "$shot" ] && [ -f "$JDIR/$dir/$shot" ] || bad="$bad screenshot-file"
    if [ -n "$bad" ]; then invalid="$invalid $dir/$s($(echo $bad | tr ' ' ','))"; continue; fi
    walked="$walked $f"
  done
done
[ -z "$missing" ] && ok "all $total required logs and five DEFECTS.md present" || fail "missing journey files:$missing"
[ -z "$invalid" ] && ok "every log carries the required fields, a passing verdict and its screenshot" || { fail "$(echo $invalid | wc -w | tr -d ' ') of $total logs not walked/valid (first 4: $(echo $invalid | tr ' ' '\n' | head -4 | sed -E 's/\(.*//' | tr '\n' ' '))"; echo $invalid | tr ' ' '\n' | head -2 | sed 's/^/      /'; }
# Freshness of the valid logs: their walked routes' rendered contracts against the seal (docs/journeys.md).
jr_freshness "$JDIR" $walked
jr_report

# ─────────────────────────────────────────────────────────────────────────────
section "6. decisions recorded"
d46=$(awk '/^### 4\.6 /{f=1; next} f&&/^### /{exit} f' $DESIGN)
for kw in "Communication plane" "Active now" "My initiatives" "My org teams" "host-tenant|host tenant" "Shared work" "sharing grant" "currentSocialActionSession" "person_id"; do
  echo "$d46" | grep -qiE -- "$kw" && ok "$DESIGN §4.6 records: $kw" || fail "$DESIGN §4.6 does not record: $kw"
done
navd=$(awk '/^## Decided: .*Communication plane/{f=1} f&&/^## /&&!/Communication plane/{exit} f' $NAVDOC)
if [ -z "$navd" ]; then fail "$NAVDOC has no '## Decided: … Communication plane …' entry"; else
  for kw in "2026-10-07" "Active now" "initiatives" "Shared work|shared work" "social-plane|/api/social/plane" "person_id|linked person"; do
    echo "$navd" | grep -qiE -- "$kw" && ok "$NAVDOC entry records: $kw" || fail "$NAVDOC Communication plane entry does not record: $kw"
  done
fi
[ -f docs/communication-plane-goal.md ] && ok "goal doc present" || fail "docs/communication-plane-goal.md missing"
grep -q 'validate-communication-plane.sh' CLAUDE.md && ok "CLAUDE.md docs-map names the judge" || fail "CLAUDE.md docs-map has no validate-communication-plane.sh row"
grep -q 'validate-communication-plane' scripts/audit-loop/run.sh && ok "audit loop runs the judge" || fail "scripts/audit-loop/run.sh does not list validate-communication-plane.sh"

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
