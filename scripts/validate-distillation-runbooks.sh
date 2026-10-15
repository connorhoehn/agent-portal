#!/usr/bin/env bash
# The judge for docs/distillation-runbooks-goal.md — runbooks a person can
# read and the session brief a booted box receives. Exits 0 only when every
# check passes; prints every failing line so one run shows the whole backlog.
#
#   ./scripts/validate-distillation-runbooks.sh --quick   # static checks + the fast model/migration checks
#   ./scripts/validate-distillation-runbooks.sh           # + jest suites, portal build, journey walks (long; run alone)
#   ./scripts/validate-distillation-runbooks.sh --section model   # one section (repeatable)
#
# Sections: model store migration api injection portal discipline ia journeys
# contracts demo deleted. A check that cannot run in this environment (the
# Dynamo leg without RUNBOOK_DYNAMODB_ENDPOINT) prints SKIP, never PASS.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh 2>/dev/null || true

QUICK=0; ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --section) shift; ONLY+=("${1:-}") ;;
    --section=*) ONLY+=("${1#--section=}") ;;
  esac
  shift
done
want() { [ ${#ONLY[@]} -eq 0 ] && return 0; local s; for s in "${ONLY[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

FAILS=(); SKIPS=0
fail() { FAILS+=("[$CUR] $1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
skip() { SKIPS=$((SKIPS+1)); printf '  - SKIP %s\n' "$1"; }
CUR=""
section() { CUR=$1; printf '\n== %s ==\n' "$1"; }
check()  { if eval "$1" >/dev/null 2>&1; then ok "$2"; else fail "$2"; fi; }
exists() { if [ -e "$1" ]; then ok "$2"; else fail "$2 — $1 missing"; fi; }
absent() { if [ -e "$1" ]; then fail "$2 — $1 still exists"; else ok "$2"; fi; }
need()   { if grep -qE -- "$1" "$2" 2>/dev/null; then ok "$3"; else fail "$3 — not found in $2"; fi; }
needF()  { if grep -qF -- "$1" "$2" 2>/dev/null; then ok "$3"; else fail "$3 — not found in $2"; fi; }
none()   { # pattern, path(s)..., label — zero hits
  local pat=$1 label=${@: -1}; local paths=("${@:2:$#-2}") n
  n=$(grep -rEn -- "$pat" "${paths[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = 0 ]; then ok "$label"; else fail "$label — $n hits"; grep -rEn -- "$pat" "${paths[@]}" 2>/dev/null | head -3 | sed 's/^/        /'; fi
}

MW=middleware
LIB=$MW/src/lib/runbooks
SCRATCH=${TMPDIR:-/tmp}/runbooks-judge.$$
mkdir -p "$SCRATCH"; trap 'rm -rf "$SCRATCH"' EXIT

# Run one jest selection once and judge named tests from its JSON report.
#   jest_run <key> <path-pattern...>     → $SCRATCH/<key>.json, return code
#   jest_named <key> <name-regex> <label>   a passed test whose full name matches
jest_run() {
  local key=$1; shift
  (cd $MW && node node_modules/.bin/jest --config jest.config.cjs --json --outputFile="$SCRATCH/$key.json" "$@" >"$SCRATCH/$key.log" 2>&1)
}
jest_named() {
  local key=$1 re=$2 label=$3
  if node -e '
    const r = require(process.argv[1]); const re = new RegExp(process.argv[2]);
    const hits = r.testResults.flatMap((f) => f.assertionResults).filter((a) => re.test(a.fullName));
    process.exit(hits.length > 0 && hits.every((a) => a.status === "passed") ? 0 : 1);
  ' "$SCRATCH/$key.json" "$re" 2>/dev/null; then ok "$label"; else fail "$label — no passing test named /$re/"; fi
}

# ─────────────────────────────────────────────────────────────────────────────
section "goal"
exists docs/distillation-runbooks-goal.md "goal doc"
exists docs/distillation-runbooks-design.md "design doc"
needF 'validate-distillation-runbooks.sh' CLAUDE.md "CLAUDE.md docs map names the judge"

# ─────────────────────────────────────────────────────────────────────────────
if want model; then
section "model (R0 · lib/runbooks pure modules)"
for f in types render parse lint similarity select brief tokens health index; do exists "$LIB/$f.ts" "lib/runbooks/$f.ts"; done
for fn in renderRunbook parseRunbook lintRunbook similarity selectRunbooks assembleBrief estimateTokens; do
  need "\b$fn\b" "$LIB/index.ts" "lib/runbooks/index.ts exports $fn"
done
need "export (type |interface )?.*RunbookDoc|RunbookDoc" "$LIB/types.ts" "RunbookDoc type"
none "aurora\.js|client-rds-data|from 'fs'|from 'node:fs'|Math\.random|Date\.now\(|new Date\(\)" $LIB/types.ts $LIB/render.ts $LIB/parse.ts $LIB/lint.ts $LIB/similarity.ts $LIB/select.ts $LIB/brief.ts $LIB/tokens.ts $LIB/health.ts "pure modules: no I/O, no SQL, no clock, no randomness"
if [ -d "$LIB/__tests__" ]; then
  if jest_run model "src/lib/runbooks/"; then ok "jest: src/lib/runbooks/__tests__ passes"; else
    fail "jest: src/lib/runbooks/__tests__ fails"; grep -E '✕|●' "$SCRATCH/model.log" | head -8 | sed 's/^/        /'; fi
  jest_named model 'round-trip: every seed runbook' "round-trip: parseRunbook(renderRunbook(doc)) deep-equals doc for every seed runbook"
  jest_named model 'round-trip: property' "round-trip: property-style over generated docs"
  jest_named model 'lint: every seed runbook is clean' "lint: every seed runbook has zero findings"
  for n in 1 2 3 4 5 6 7 8 9 10; do jest_named model "lint: bad example $n fails" "lint: the design's bad example $n fails with its expected rule"; done
  for r in R-imperative R-joined R-generated R-commandless R-verify R-rollback R-single-subject R-command-real R-length R-secrets; do
    jest_named model "lint rule $r: fails its bad fixture" "lint rule $r has a failing fixture"
    jest_named model "lint rule $r: passes its good fixture" "lint rule $r has a passing fixture"
  done
  jest_named model 'pure: selectRunbooks' "selectRunbooks is pure (same input twice → same sha256)"
  jest_named model 'pure: assembleBrief' "assembleBrief is pure (same input twice → same sha256)"
  jest_named model 'brief: never exceeds its budget' "no brief exceeds its budget"
  jest_named model 'brief: whole runbooks only' "no runbook in a brief is cut mid-step"
else
  fail "no tests under $LIB/__tests__"
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if want store; then
section "store (R1 · RunbookStore, Rows + Dynamo)"
need "interface RunbookStore" "$LIB/store.ts" "RunbookStore interface in lib/runbooks/store.ts"
check "grep -rqE 'class RowsRunbookStore|function createRowsRunbookStore' $MW/src" "RowsRunbookStore implementation"
check "grep -rqE 'class DynamoRunbookStore|function createDynamoRunbookStore' $MW/src" "DynamoRunbookStore implementation"
for k in runbooks runbook-versions runbook-proposals runbook-applications session-briefs; do
  check "grep -rqE \"key: *'$k'\" $MW/src/mock" "fixture '$k' registered through defineFixture"
done
check "grep -rqE \"empty\" $MW/src/mock/runbooks*.ts && grep -rqE \"large\" $MW/src/mock/runbooks*.ts" "fixtures declare empty and large scenarios"
RB_PATHS=$(ls -d $MW/src/lib/runbook* $MW/src/providers/runbook* $MW/src/routes/runbook* 2>/dev/null)
if [ -n "$RB_PATHS" ]; then none "aurora\.js|client-rds-data" $RB_PATHS "no runbook file imports aurora.js or the RDS Data API client"; else fail "no runbook source under lib/providers/routes"; fi
STORE_TEST=$(ls $MW/src/*/__tests__/*runbook-store*.test.ts $MW/src/lib/runbooks/__tests__/*store*.test.ts 2>/dev/null | head -1)
[ -n "$STORE_TEST" ] && ok "shared store contract suite ($STORE_TEST)" || fail "no shared store contract suite (*runbook-store*.test.ts)"
if [ "$QUICK" = 0 ] && [ -n "$STORE_TEST" ]; then
  if jest_run store "${STORE_TEST#$MW/}"; then ok "contract suite passes against RowsRunbookStore"; else fail "contract suite fails against RowsRunbookStore"; fi
  if [ -n "${RUNBOOK_DYNAMODB_ENDPOINT:-}" ]; then jest_named store 'DynamoRunbookStore' "contract suite passes against DynamoRunbookStore ($RUNBOOK_DYNAMODB_ENDPOINT)"
  else skip "contract suite against DynamoRunbookStore (RUNBOOK_DYNAMODB_ENDPOINT unset)"; fi
  check "./scripts/validate-mock-floor.sh --quick" "mock floor judge green"
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if want migration; then
section "migration (R2 · distillation → runbooks)"
MIG=docs/history/runbooks-migration/migrate-distillation.mjs
SEED=$MW/src/mock/runbooks.seed.ts
exists "$MIG" "migration script (retired to docs/history in R7; its source fixtures were deleted, so it no longer runs)"
exists "$SEED" "hand-authored seed rewrites (mock/runbooks.seed.ts)"
exists docs/runbooks-migration-report.md "migration report"
if [ -f docs/runbooks-migration-report.md ]; then
  check "! grep -qi 'unaccounted: *[1-9]' docs/runbooks-migration-report.md" "report: zero unaccounted"
  n=$(grep -cE 'migrated → rb-' docs/runbooks-migration-report.md); [ "$n" -ge 9 ] && ok "report: $n artifacts migrated (≥ 9)" || fail "report: only $n artifacts marked migrated → rb-… (need ≥ 9)"
fi
if [ -f "$SEED" ]; then
  n=$(grep -cE 'source_artifact_ids: *\[ *.art-' "$SEED"); [ "$n" -ge 9 ] && ok "seed: $n runbooks name their source artifact" || fail "seed: only $n runbooks carry provenance.source_artifact_ids naming an art-… (need ≥ 9)"
  none '\(\+[0-9]+ more\)|Load-corpus|Uncompacted write' "$SEED" "seed: no machine strings (R-generated)"
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if want api; then
section "api (R3 · /api/runbooks, briefs, authz)"
RT=$MW/src/routes/runbooks.ts
exists "$RT" "routes/runbooks.ts"
need "app\.use\(['\"]/api/runbooks['\"]" $MW/src/index.ts "/api/runbooks mounted"
check "grep -rqE \"/runs/:[a-zA-Z]+/brief\" $MW/src/routes" "GET /api/runs/:ref/brief route"
check "grep -rqE \"/work-items/:[a-zA-Z]+/brief-preview\" $MW/src/routes" "GET /api/work-items/:id/brief-preview route"
for a in ReviewRunbook ViewSessionBrief; do
  needF "'$a'" $MW/src/lib/authz.ts "CAPABILITY_ACTIONS lists $a"
  needF "\"$a\"" $MW/seeds/schema.json "seeds/schema.json declares $a"
done
need 'ReviewRunbook' $MW/seeds/roles/orgiq/sme.cedar "sme.cedar grants ReviewRunbook (owner or initiative SME accepts)"
need 'ReviewRunbook' $MW/seeds/roles/orgiq/org-leader.cedar "org-leader.cedar grants ReviewRunbook (override)"
for r in member sme program-owner org-leader hr-admin; do need 'ViewSessionBrief' $MW/seeds/roles/orgiq/$r.cedar "$r.cedar grants ViewSessionBrief"; done
# One line, space-separated: `check` evals its string, and a newline inside it would
# end the grep at the first file and run the second file's path as a command.
RB_TESTS=$(ls $MW/src/routes/__tests__/runbook*.test.ts 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
[ -n "$RB_TESTS" ] && ok "route suites: $(echo $RB_TESTS | wc -w | tr -d ' ')" || fail "no routes/__tests__/runbook*.test.ts"
if [ -f "$RT" ] && [ -n "$RB_TESTS" ]; then
  untested=""
  for p in $(grep -oE "router\.(get|post|put|patch|delete)\(['\"][^'\"]+" "$RT" | sed -E "s/.*\(['\"]//" | sort -u); do
    tp=$(printf '%s' "$p" | sed -E 's#:[a-zA-Z]+#[^/]+#g')
    grep -qE "/api/runbooks${tp}['\"\`?]" $RB_TESTS || untested="$untested $p"
  done
  [ -z "$untested" ] && ok "every /api/runbooks route has a test" || fail "routes without a test:$untested"
fi
check "grep -rqE '409' $RB_TESTS /dev/null && grep -rqE 'base_version' $RB_TESTS /dev/null" "a test accepts a proposal on a stale base_version and expects 409"
check "grep -qF '/api/runbooks' $MW/src/mock/core/wire/snapshots/routes.json" "wire snapshot lists /api/runbooks routes"
if [ "$QUICK" = 0 ] && [ -n "$RB_TESTS" ]; then
  if jest_run api $(for t in $RB_TESTS; do echo "${t#$MW/}"; done); then ok "route suites pass"; else fail "route suites fail"; fi
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if want injection; then
section "injection (R4 · the frozen brief reaches every box)"
C=docs/journeys/contracts/session-brief.json
exists "$C" "contract file session-brief.json"
if [ -f "$C" ]; then
  for wi in wi-auth-e2-s2 wi-auth-e2-b3 wi-obs-e2-b4; do
    check "node -e 'const c=require(\"./$C\").cases[\"$wi\"]; process.exit(c && Array.isArray(c.sections) && c.sections.length && Number.isInteger(c.used_tokens) && /^[0-9a-f]{64}\$/.test(c.sha256) ? 0 : 1)'" "contract case $wi: sections, used_tokens, sha256"
    exists "docs/journeys/contracts/session-brief/$wi.md" "reviewed brief markdown for $wi"
  done
  check "node -e 'const c=require(\"./$C\"); process.exit(c.budget_tokens===6000 ? 0 : 1)'" "contract budget is 6,000 tokens"
fi
BT=$(grep -rlE 'session-brief\.json' $MW/src --include='*.test.ts' 2>/dev/null | head -1)
[ -n "$BT" ] && ok "contract test ($BT)" || fail "no jest test reads docs/journeys/contracts/session-brief.json"
check "grep -rqE 'brief_id' $MW/src/lib/job-dispatcher.ts && grep -rqE 'brief_sha' $MW/src/lib/job-dispatcher.ts" "job dispatcher stamps brief_id + brief_sha on the job"
check "grep -rqE 'assembleBrief|freezeBrief' $MW/src/lib/local-work.ts" "local-compute claim assembles the brief"
need 'lab brief' agents/devbox/managed-settings.json "devbox SessionStart runs lab brief"
check "! grep -q 'lab recall' agents/devbox/managed-settings.json" "devbox SessionStart no longer runs lab recall"
need "brief\)|'brief'|\"brief\"" agents/devbox/lab "lab has a brief subcommand"
need "propose\)|'propose'|\"propose\"" agents/devbox/lab "lab has a propose subcommand"
need "applied\)|'applied'|\"applied\"" agents/devbox/lab "lab has an applied subcommand"
check "grep -rlqE 'brief' $MW/src/lib/__tests__/local-work*.test.ts" "local worker framing test shows the brief inside the framing"
if [ "$QUICK" = 0 ] && [ -n "$BT" ]; then
  if jest_run injection "${BT#$MW/}"; then ok "contract test passes (bytes match their sha)"; else fail "contract test fails"; grep -E '^[-+] ' "$SCRATCH/injection.log" | head -10 | sed 's/^/        /'; fi
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
PAGES=portal/src/pages/runbooks
if want portal; then
section "portal (R5)"
exists "$PAGES" "portal/src/pages/runbooks"
for r in "/iq/runbooks" "/iq/runbooks/:id" "/iq/runbooks/proposals" "/iq/runbooks/briefs"; do
  check "grep -rqF \"$r\" portal/src/App.tsx portal/src/pages/runbooks" "route $r in the app"
  needF "$r" portal/e2e/route-inventory.ts "route $r in route-inventory.ts"
done
if [ "$QUICK" = 0 ]; then
  if type jg_portal_tsc >/dev/null 2>&1 && jg_portal_tsc >/dev/null 2>&1; then ok "portal tsc"; else fail "portal tsc"; fi
  if ls $PAGES/__tests__/*.test.ts >/dev/null 2>&1; then check "(cd portal && node --test src/pages/runbooks/__tests__/*.test.ts)" "node --test pages/runbooks/__tests__"; else fail "no tests under $PAGES/__tests__"; fi
  if type jg_vite_build >/dev/null 2>&1 && jg_vite_build >/dev/null 2>&1; then ok "vite build"; else fail "vite build"; fi
fi
fi

if want discipline; then
section "discipline (portal/src/pages/runbooks)"
if [ -d "$PAGES" ]; then
  source scripts/lib/discipline.sh
  PAGE_FILES=$(dc_area_files "$PAGES" "$PAGES/")
  n_raw=$(dc_count_raw $PAGE_FILES); n_sty=$(dc_count_re 'style=\{\{' $PAGE_FILES)
  [ "$n_raw" = 0 ] && ok "raw styled elements: 0" || fail "raw styled elements: $n_raw"
  [ "$n_sty" = 0 ] && ok "no inline style={{}}" || fail "inline style={{}}: $n_sty"
else
  fail "nothing to judge — $PAGES missing"
fi
fi

if want ia; then
section "ia (one destination, distillation redirects)"
check "grep -qE \"/iq/distillation.*Navigate[^>]*/iq/runbooks|Navigate[^>]*to=.*/iq/runbooks\" portal/src/App.tsx" "every /iq/distillation/* path redirects to /iq/runbooks"
check "grep -rqE 'runbooks.*redirect|redirect.*distillation' portal/src/pages/runbooks/__tests__ 2>/dev/null" "redirect model is tested"
check "grep -qF \"/iq/runbooks\" portal/src/components/shell/Layout.tsx" "IQ rail entry Runbooks"
check "! grep -qF \"/iq/distillation\" portal/src/components/shell/Layout.tsx portal/src/components/shell/portalCommands.ts" "no rail or palette entry for /iq/distillation"
for k in rail cascade type-scale; do needF '/iq/runbooks' docs/journeys/contracts/$k.json "$k contract measured for /iq/runbooks"; done
fi

# ─────────────────────────────────────────────────────────────────────────────
JDIR=docs/runbooks-journeys
if want journeys; then
section "journeys (R6)"
need '^ *runbooks:' scripts/journeys/maps.mjs "PROFILES.runbooks in scripts/journeys/maps.mjs"
for m in author/propose author/from-run reviewer/accept reviewer/reject-merge reviewer/stale-base consumer/read consumer/brief-preview consumer/run-brief box/brief; do
  check "ls docs/journeys/maps/runbooks/$m.* >/dev/null 2>&1" "map runbooks/$m"
done
if [ "$QUICK" = 0 ]; then
  check "node scripts/journeys/run-maps.mjs check runbooks" "run-maps check runbooks"
  for r in author reviewer consumer box; do check "node scripts/journeys/run-maps.mjs walk runbooks --role $r" "walk $r"; done
fi
LOGS=$(ls $JDIR/{author,reviewer,consumer}/*.md 2>/dev/null)
if [ -z "$LOGS" ]; then fail "no journey logs under $JDIR/{author,reviewer,consumer}"; else
  source scripts/lib/journeys.sh; jr_freshness "$JDIR" $LOGS; jr_report
fi
fi

if want contracts; then
section "contracts"
check "grep -rqE 'freezeClock' \$(grep -rlE 'session-brief\.json' $MW/src --include='*.test.ts' 2>/dev/null) /dev/null" "brief contract test runs under freezeClock"
check "grep -rqE -- '--update' \$(grep -rlE 'session-brief\.json' $MW/src scripts --include='*.ts' --include='*.mjs' 2>/dev/null) /dev/null" "contract re-recorded only by an explicit --update"
fi

if want demo; then
section "demo (runbooks-demo)"
check "grep -rqF \"'runbooks-demo'\" $MW/src/mock" "scenario runbooks-demo registered"
DT=$(grep -rlE 'runbooks-demo' $MW/src --include='*.test.ts' 2>/dev/null | head -1)
[ -n "$DT" ] && ok "demo test ($DT)" || fail "no jest test drives runbooks-demo"
if [ "$QUICK" = 0 ] && [ -n "$DT" ]; then
  if (cd $MW && DEMO_PACE_MS=200 node node_modules/.bin/jest --config jest.config.cjs "${DT#$MW/}" >/dev/null 2>&1); then ok "runbooks-demo reaches done and the second brief carries the accepted version"; else fail "runbooks-demo test fails"; fi
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
if want deleted; then
section "deleted (R7)"
DEL=(portal/src/pages/distillation portal/src/hooks/useDistillationChannel.ts portal/src/pages/library/DistillationProvenance.tsx
  $MW/src/providers/distillation.ts $MW/src/providers/distillation-store.ts $MW/src/mock/distillation.ts $MW/src/mock/distillation-queue.ts
  $MW/src/lib/distillation-queue.ts $MW/src/lib/distillation-realtime.ts $MW/src/lib/distillation-channels.ts $MW/src/lib/distillation-events.ts $MW/src/lib/distillation-replica.ts
  schema/distillation_schema.sql schema/distillation_ops_schema.sql
  docs/distillation.md docs/distillation-goal.md docs/distillation-demo.md docs/distillation-redesign-spec.md docs/distillation-journeys docs/journeys/maps/distillation)
for f in "${DEL[@]}"; do absent "$f" "${f#$MW/}"; done
check "! ls $MW/src/mock/distillation-demo*.ts >/dev/null 2>&1" "mock/distillation-demo*.ts"
check "! ls docs/distillation-guide-record-* docs/distillation-concept-audit-2026-09-16.md >/dev/null 2>&1" "distillation guide records and concept audit moved to docs/history"
none "from ['\"][./]*(providers|lib|mock)/distillation(-store|-queue|-realtime|-channels|-events|-replica|-demo[a-z-]*)?(\.js)?['\"]" $MW/src "no middleware import of a deleted distillation module"
none "pages/distillation/|useDistillationChannel|DistillationProvenance" portal/src "no portal import of a deleted distillation module"
none "distillation(_ops)?_schema" schema/load_schema.py "load_schema.py no longer registers the distillation schemas"
check "! grep -qF 'validate-distillation.sh' CLAUDE.md" "CLAUDE.md docs map no longer names validate-distillation.sh"
fi

# ─────────────────────────────────────────────────────────────────────────────
printf '\n'
[ "$SKIPS" -gt 0 ] && echo "$SKIPS check(s) skipped (not run here; not counted as passing)"
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
printf '%d check(s) failing:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
