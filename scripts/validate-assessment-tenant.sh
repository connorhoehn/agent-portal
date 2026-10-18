#!/usr/bin/env bash
# validate-assessment-tenant.sh — the definition of done for the assessment
# tenant, as a script. Every check is mechanical; nothing here is "looks fine
# to me". The /goal Stop hook runs this: while it exits non-zero, the session
# keeps working. It prints every failing check, not just the first, so one
# run shows the whole remaining backlog.
#
# Usage:  scripts/validate-assessment-tenant.sh            # full run
#         scripts/validate-assessment-tenant.sh --no-time  # skip the 04:00 gate
#         scripts/validate-assessment-tenant.sh --quick    # skip the slow suites
#
# Exit 0 only when EVERY section passes.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state

QUICK=0; NO_TIME=0
source scripts/lib/journeys.sh  # jr_*: journey freshness (docs/journeys.md)
jr_refuse_seal_flag "$@"
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    --no-time) NO_TIME=1 ;;
  esac
done

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. Type + test + build gates. A tenant that does not compile is not done.
# ─────────────────────────────────────────────────────────────────────────────
section "middleware"
if jg_mw_tsc >/dev/null 2>&1; then ok "tsc clean"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest --silent >/dev/null 2>&1); then ok "jest green"; else fail "middleware: jest failures"; fi
fi

section "portal"
if jg_portal_tsc >/dev/null 2>&1; then ok "tsc clean"; else fail "portal: tsc errors"; fi
if (cd portal && node --test 'src/pages/**/__tests__/*.test.ts' 2>&1 | grep -qE '^ℹ fail 0$'); then ok "node tests green"; else fail "portal: node test failures"; fi
if [ "$QUICK" = 0 ]; then
  if jg_vite_build 2>&1 | grep -q '✓ built'; then ok "vite build"; else fail "portal: vite build fails"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Component discipline. The pages are composed from ui-components
#    composites, not scaffolded from raw HTML. Three hard zeros, plus a ratchet
#    on styled text/layout elements that may only ever go DOWN. The starting
#    count was 274 across the tenant (80 of them <div>) against 60 in the
#    reference orgiq pages; the target is 0. Lower MAX_RAW_ELEMENTS as you
#    remove them — never raise it.
# ─────────────────────────────────────────────────────────────────────────────
section "component discipline (portal/src/pages/assessment)"
PAGES="portal/src/pages/assessment"
source scripts/lib/discipline.sh  # the one raw-element counter (brace-aware), shared with validate-component-discipline.sh
RAW_RE=$DC_RAW_RE
MAX_RAW_ELEMENTS=0

# A raw element is permitted in exactly one kind of file: a local composite
# that stands in for a primitive the library lacks AND is queued for it in
# docs/ui-components-queue.md (the "where used" column names the file). The
# queue is the ledger; a file not on it gets no exemption, and a queued file
# still has a small per-file cap so "queue it" can't become "hand-roll it".
QUEUE=docs/ui-components-queue.md
QUEUED_MAX_PER_FILE=8
# Only rows that say "Composed locally in `<file>`" mint an exemption — a
# row that merely names the pages where a library gap was worked around
# must not exempt those pages from the discipline check.
QUEUED_FILES=$(dc_queued_files "$PAGES/")
PAGE_FILES=$(dc_area_files "$PAGES" "$PAGES/")
n_div=$(dc_count_re '<div( [^>]*)?className=' $PAGE_FILES)
n_btn=$(dc_count_re '<button' $PAGE_FILES)
n_sty=$(dc_count_re 'style=\{\{' $PAGE_FILES)
n_raw=$(dc_count_raw $PAGE_FILES)
q_over=""
for f in $QUEUED_FILES; do [ -f "$f" ] || continue; c=$(dc_count_raw "$f"); [ "$c" -le "$QUEUED_MAX_PER_FILE" ] || q_over="$q_over ${f#$PAGES/}($c)"; done
n_queued=$(printf '%s\n' $QUEUED_FILES | grep -c . || true)
[ -z "$q_over" ] && ok "$n_queued queued composites, each ≤ $QUEUED_MAX_PER_FILE raw elements" || fail "queued composite over the per-file cap of $QUEUED_MAX_PER_FILE:$q_over"
[ "$n_div" = 0 ] && ok "no raw <div className> (0)" || fail "raw <div className> in pages: $n_div (must be 0 — use Stack/Inline/Card/RailSection/DetailSection/PageSection)"
[ "$n_btn" = 0 ] && ok "no raw <button> (0)" || fail "raw <button> in pages: $n_btn (must be 0 — use Button/IconButton/SelectableCard)"
[ "$n_sty" = 0 ] && ok "no inline style={{}} (0)" || fail "inline style={{}} in pages: $n_sty (must be 0)"
if [ "$n_raw" -le "$MAX_RAW_ELEMENTS" ]; then ok "raw styled elements: $n_raw (budget $MAX_RAW_ELEMENTS)"; else
  fail "raw styled elements: $n_raw > budget $MAX_RAW_ELEMENTS — worst files:"
  for f in $PAGE_FILES; do c=$(dc_count_raw "$f"); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$PAGES/}"; done | sort -rn | head -8
fi
# The library's own wrapped realtime components break the production build
# (tiptap peer); the plain primitives are the sanctioned path until upstream
# splits the entry. Importing the broken entry is therefore a defect.
if grep -rq "ui-components/integrations/realtime-modules" "$PAGES" --include='*.tsx'; then fail "imports integrations/realtime-modules (breaks vite build without @tiptap/react)"; else ok "no integrations/realtime-modules imports"; fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. API ↔ test parity. Every route the router mounts has a test that calls
#    its path. A route nothing exercises is a route nobody has seen work.
# ─────────────────────────────────────────────────────────────────────────────
section "route ↔ test parity (middleware/src/routes/assessment.ts)"
ROUTER=middleware/src/routes/assessment.ts
TESTS=middleware/src/routes/__tests__
missing=0
while IFS= read -r path; do
  # collapse :params to a regex that matches any concrete id in the tests
  pat=$(printf '%s' "$path" | sed -E 's#:[A-Za-z_]+#[^/?'"'"'"]+#g')
  if ! grep -rqE "/api/assessment${pat}" "$TESTS"; then printf '      untested: %s\n' "$path"; missing=$((missing+1)); fi
done < <(grep -oE "assessmentRouter\.(get|post|put|patch|delete)\('[^']+'" "$ROUTER" | sed -E "s/.*\('//; s/'$//" | sort -u)
[ "$missing" = 0 ] && ok "every mounted route has a test" || fail "$missing mounted routes have no test"

# ─────────────────────────────────────────────────────────────────────────────
# 4. UX journey audit artifacts. One markdown log + one screenshot per
#    (role × surface), written by an actual browser pass, each stating a
#    verdict, a console-error count of zero, and a measured layout verdict.
#    A log that says "TODO" or "unverified" anywhere does not count.
# ─────────────────────────────────────────────────────────────────────────────
section "journey audit (docs/assessment-journeys)"
JDIR=docs/assessment-journeys
ROLES=(assessor lead-assessor program-lead admin)
SURFACES=(dashboard team-scorecard submissions submissions-wizard feedback reports runs configuration workspace enterprise rules prompts)
jmissing=0; jbad=0
for r in "${ROLES[@]}"; do for s in "${SURFACES[@]}"; do
  f="$JDIR/$r/$s.md"
  if [ ! -f "$f" ]; then jmissing=$((jmissing+1)); continue; fi
  bad=""
  grep -qiE '^verdict: *pass' "$f" || bad="$bad no-pass-verdict"
  grep -qiE '^console errors: *0' "$f" || bad="$bad console-errors"
  grep -qiE '^layout: *pass' "$f" || bad="$bad layout"
  grep -qiE '^keyboard: *pass' "$f" || bad="$bad keyboard"
  grep -qiE '^empty-state: *(pass|n/a)' "$f" || bad="$bad empty-state"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot-line"
  shot=$(grep -iE '^screenshot: *' "$f" | head -1 | sed -E 's/^screenshot: *//')
  [ -n "$shot" ] && [ ! -f "$JDIR/$r/$shot" ] && bad="$bad screenshot-missing($shot)"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad contains-TODO/unverified"
  if [ -n "$bad" ]; then jbad=$((jbad+1)); printf '      %s/%s:%s\n' "$r" "$s" "$bad"; fi
done; done
total=$(( ${#ROLES[@]} * ${#SURFACES[@]} ))
[ "$jmissing" = 0 ] && ok "all $total role×surface logs present" || fail "$jmissing of $total journey logs missing (roles: ${ROLES[*]}; surfaces: ${SURFACES[*]})"
[ "$jbad" = 0 ] && ok "every present log passes all fields" || fail "$jbad journey logs fail a required field"
# Freshness (docs/journeys.md): a log is stale when the rendered contract of
# a route it walked changed since its walk was sealed — not when a file under
# the route was touched, which is how a one-line refactor used to stale all 63
# logs. Only audit logs are held to it: the role×surface logs, the isolation
# logs and the stretch proofs (a log naming no route keeps its `pages:`
# digest). PROTOCOL.md, DEFECTS.md and fixtures are not audits. Retired-tenant
# isolation archives document deleted code, not the current product. Only
# scripts/journeys/seal.sh <dir> records a seal, after a walk.
if [ -d "$JDIR" ]; then
  jr_freshness "$JDIR" $(find "$JDIR" -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' ! -path '*/fixtures/*' ! -path '*/isolation/archived-*/*' 2>/dev/null | sort)
  jr_report
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4b. Role isolation. The tenant must be INVISIBLE to every role that holds no
#     grant in it: no workspace tile, no nav entry, a dead route, and 403 at
#     the API — and the reverse for assessment roles on orgiq pages.
#     "An SME shouldn't see the assessment pages" is a test, not an opinion.
# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
# 2b. Assessor cockpit UX (docs/assessment-ux-goal.md). Each slice's definition
#     of done, as a grep: the shape the page must have, not how it looks.
# ─────────────────────────────────────────────────────────────────────────────
section "assessor cockpit UX (docs/assessment-ux-goal.md)"
if [ -f "$PAGES/dashboard/AssessorDesk.tsx" ] && grep -q "header: 'Next action'" "$PAGES/dashboard/AssessorDesk.tsx" \
   && [ ! -f "$PAGES/dashboard/CohortLanding.tsx" ] && [ ! -f "$PAGES/dashboard/TeamList.tsx" ]; then
  ok "slice 1 — the dashboard is the assessor's desk (one DataTable with a Next action column; the cohort landing and per-cohort list are gone)"
else fail "slice 1 — dashboard/AssessorDesk.tsx must carry a 'Next action' column and CohortLanding.tsx / TeamList.tsx must be gone"; fi
if grep -q '<DataTable' "$PAGES/FeedbackPage.tsx" && grep -q '<CollectionRecordFrame' "$PAGES/FeedbackPage.tsx" \
   && grep -q '<QuestionRecord' "$PAGES/FeedbackPage.tsx" && grep -q 'path="feedback/:taskId"' portal/src/App.tsx \
   && ! grep -qE '<(Card|Drawer|Modal)\b' "$PAGES/FeedbackPage.tsx"; then
  ok "slice 2 — feedback is a DataTable with URL-addressed question records, no per-question Card or popout"
else fail "slice 2 — FeedbackPage must render a DataTable and CollectionRecordFrame/QuestionRecord at feedback/:taskId, without Card/Drawer/Modal"; fi
if grep -q 'data-testid="maturity-heatmap"' "$PAGES/ReportsPage.tsx" && grep -q 'data-verified=' "$PAGES/ReportsPage.tsx" && grep -q 'data-claimed=' "$PAGES/ReportsPage.tsx"; then
  ok "slice 3 — reports carries the maturity heatmap (teams × dimensions, cells with data-verified / data-claimed)"
else fail "slice 3 — ReportsPage.tsx must render data-testid=\"maturity-heatmap\" with data-verified / data-claimed cells"; fi
if grep -q 'data-claimed=' "$PAGES/dashboard/DimensionRow.tsx" && grep -q 'data-verified=' "$PAGES/dashboard/DimensionRow.tsx" && grep -q 'DotMeter' "$PAGES/dashboard/DimensionRow.tsx" \
   && grep -q '<EvidenceCoverage' "$PAGES/dashboard/TeamScorecard.tsx" && grep -q 'team.repos' "$PAGES/dashboard/TeamScorecard.tsx"; then
  ok "slice 4 — scorecard rail rows carry data-claimed / data-verified and a confidence DotMeter; the Certification tab has the evidence coverage strip; the header names the team's repos"
else fail "slice 4 — DimensionRow.tsx must carry data-claimed= / data-verified= and a DotMeter; TeamScorecard.tsx must render <EvidenceCoverage and team.repos"; fi
if [ -f "$PAGES/dimensionStandards.ts" ] && grep -q 'data-testid="dimension-standard"\|testId = .dimension-standard' "$PAGES/dashboard/DimensionMasterDetail.tsx" && grep -q 'enterpriseDocPath' "$PAGES/dashboard/DimensionMasterDetail.tsx"; then
  ok "slice 5 — dimension detail names the enterprise standard it is measured against and links into the explorer"
else fail "slice 5 — dimensionStandards.ts must exist and DimensionMasterDetail.tsx must render the dimension-standard line with an enterpriseDocPath link"; fi

section "role isolation"
ISO="$JDIR/isolation"
OUTSIDE_ROLES=(member sme program-owner org-leader hr-admin)
imissing=0; ibad=0
for r in "${OUTSIDE_ROLES[@]}"; do
  f="$ISO/$r.md"
  if [ ! -f "$f" ]; then imissing=$((imissing+1)); continue; fi
  bad=""
  grep -qiE '^assessment-tile-visible: *no' "$f" || bad="$bad tile"
  grep -qiE '^assessment-nav-visible: *no' "$f"  || bad="$bad nav"
  grep -qiE '^direct-route-result: *(not-found|redirect)' "$f" || bad="$bad route"
  grep -qiE '^api-status: *403' "$f" || bad="$bad api"
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  grep -qiE '^screenshot: *\S+' "$f" || bad="$bad screenshot"
  grep -qiE 'TODO|unverified|placeholder' "$f" && bad="$bad TODO"
  [ -n "$bad" ] && { ibad=$((ibad+1)); printf '      isolation/%s:%s\n' "$r" "$bad"; }
done
for r in assessor lead-assessor program-lead; do
  f="$ISO/$r-outbound.md"
  if [ ! -f "$f" ]; then imissing=$((imissing+1)); continue; fi
  bad=""
  grep -qiE '^orgiq-nav-visible: *no' "$f" || bad="$bad orgiq-nav"
  grep -qiE '^orgiq-route-result: *(not-found|redirect)' "$f" || bad="$bad orgiq-route"
  grep -qiE '^orgiq-api-status: *403' "$f" || bad="$bad orgiq-api"
  grep -qiE '^verdict: *pass' "$f" || bad="$bad verdict"
  [ -n "$bad" ] && { ibad=$((ibad+1)); printf '      isolation/%s-outbound:%s\n' "$r" "$bad"; }
done
[ "$imissing" = 0 ] && ok "all isolation logs present (5 outside roles + 3 outbound)" || fail "$imissing isolation logs missing under $ISO (member sme program-owner org-leader hr-admin; assessor/lead-assessor/program-lead-outbound)"
[ "$ibad" = 0 ] && ok "every isolation log passes" || fail "$ibad isolation logs fail a required field"
# The shell and the pages must not open doors into another tenant's product.
# Tenants share a BFF, not journeys: no orgiq paths inside assessment
# pages, the palette must know the tenant's own pages, and every piece of
# orgiq-only Computer-Lab chrome must be gated on the orgiq tenant.
leaks=$(grep -rnE "['\"]/(iq|admin)(/|['\"])" portal/src/pages/assessment --include='*.tsx' | wc -l | tr -d ' ')
[ "$leaks" = 0 ] && ok "no orgiq paths inside assessment pages" || { fail "$leaks cross-tenant paths inside assessment pages:"; grep -rnE "['\"]/(iq|admin)(/|['\"])" portal/src/pages/assessment --include='*.tsx' | head -5 | sed 's/^/      /'; }
pal=$(grep -c "tenant: 'assessment'" portal/src/components/shell/portalCommands.ts)
[ "$pal" -ge 10 ] && ok "command palette knows $pal assessment pages" || fail "command palette lists only $pal assessment pages (expect ≥10)"
# Named by what it IS, not by a list of two: EVERY Computer-Lab / local-compute
# component the shell mounts has to be gated on the orgiq tenant. The old check
# spelled out DevboxQuickSwitch and ComputeDock, so when LocalComputeBadge was
# added to the header it shipped into the assessment shell ungated and this
# ratchet said nothing. The vocabulary (Devbox|Compute|Machine) is what makes a
# component Computer-Lab chrome; the ≥3 floor is here so a rename OUT of that
# vocabulary fails loudly instead of emptying the check.
SHELL_LAYOUT=portal/src/components/shell/Layout.tsx
compute_mounts=$(grep -oE '<[A-Za-z]*(Devbox|Compute|Machine|Fleet)[A-Za-z]*' "$SHELL_LAYOUT" | tr -d '<' | sort -u)
n_compute=$(printf '%s\n' "$compute_mounts" | grep -c . | tr -d ' ')
ungated=""
for c in $compute_mounts; do
  if [ "$c" = FleetIndicator ]; then
    # The grouped presence badge (replaced LocalComputeBadge) mounts bare and
    # gates itself: its local segment polls only behind useOrgiqShellPolls and
    # its cloud segment requires tenant === 'orgiq'.
    FI=portal/src/components/shell/FleetIndicator.tsx
    grep -q "session?.tenant === 'orgiq'" "$FI" && grep -q "useLocalNodes" "$FI" || ungated="$ungated $c"
  else
    grep -qE "session\?\.tenant === 'orgiq' && <$c\b" "$SHELL_LAYOUT" || ungated="$ungated $c"
  fi
done
if [ "$n_compute" -lt 3 ]; then
  fail "only $n_compute Computer-Lab component(s) found in $SHELL_LAYOUT (expect >=3 — the dock, the quick-switch and the presence badge); a rename out of the Devbox/Compute/Machine vocabulary would hide an ungated one"
elif [ -z "$ungated" ]; then
  ok "every Computer-Lab component the shell mounts is gated on the orgiq tenant ($n_compute: $(printf '%s' "$compute_mounts" | tr '\n' ' '))"
else
  fail "Computer-Lab chrome mounts in every tenant's shell — gate on session?.tenant === 'orgiq':$ungated"
fi
# Both product trees, not just the "other" one: an assessor at
# /iq/projects got the assessment shell around an orgiq page dying with 403.
rt_missing=""
for t in assessment orgiq; do
  n=$(grep -c "RequireTenant tenant=\"$t\"" portal/src/App.tsx || true)
  [ "$n" -ge 1 ] || rt_missing="$rt_missing $t"
done
if [ -z "$rt_missing" ] && [ "$(grep -c 'RequireTenant tenant=\"orgiq\"' portal/src/App.tsx)" -ge 2 ]; then ok "route trees wrapped in RequireTenant (/assessment, /iq + /admin)"; else fail "route tree not wrapped in RequireTenant:${rt_missing:- (/iq and /admin both need tenant=orgiq)}"; fi
# And the server side must be pinned by a test, not a curl someone once ran.
if grep -rqE "requiredTenant.*assessment|requireTenant\('assessment'\)" middleware/src/routes/__tests__ middleware/src/lib/__tests__ 2>/dev/null \
   && grep -rqE "sme|member" middleware/src/routes/__tests__/assessment*.test.ts 2>/dev/null; then ok "middleware tests pin the tenant gate for outside roles"; else fail "no middleware test asserts an orgiq role (sme/member) gets 403 on /api/assessment/*"; fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Source parity checklist. Every page/feature of the source app is either
#    ported or explicitly marked out-of-scope with a reason — never silently
#    absent. docs/assessment-parity.md is a table: | feature | status | note |
#    with status ∈ {ported, partial, out-of-scope}. `partial` blocks.
# ─────────────────────────────────────────────────────────────────────────────
section "source parity (docs/assessment-parity.md)"
PARITY=docs/assessment-parity.md
if [ ! -f "$PARITY" ]; then fail "missing $PARITY"; else
  rows=$(grep -cE '^\| *[^|]+ *\| *(ported|partial|out-of-scope) *\|' "$PARITY")
  partial=$(grep -cE '^\| *[^|]+ *\| *partial *\|' "$PARITY")
  [ "$rows" -ge 40 ] && ok "$rows parity rows" || fail "only $rows parity rows (the source has 20 pages + 9 commands + 6 workflow packages; expect ≥40)"
  [ "$partial" = 0 ] && ok "no 'partial' rows" || fail "$partial parity rows still 'partial'"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Time gate. The user asked for the session to keep deepening the audit
#    until 08:00 local. Once every functional check above passes, the stretch
#    backlog in docs/assessment-goal.md is the work. Skip with --no-time.
# ─────────────────────────────────────────────────────────────────────────────
section "time gate"
if [ "$NO_TIME" = 1 ]; then ok "skipped (--no-time)"; else
  H=$(date +%H); M=$(date +%M)
  if [ "$H" -ge 8 ] && [ "$H" -lt 20 ]; then ok "past 08:00 local ($H:$M)"; else fail "keep going — it is $H:$M local, the gate opens at 08:00 (work the stretch backlog in docs/assessment-goal.md)"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
printf '\n'
if [ "${#FAILS[@]}" = 0 ]; then
  echo "ALL CHECKS PASS — the assessment tenant meets its definition of done."
  exit 0
fi
echo "${#FAILS[@]} CHECK(S) FAILING:"
for f in "${FAILS[@]}"; do echo "  - $f"; done
exit 1
