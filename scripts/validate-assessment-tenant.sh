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

QUICK=0; NO_TIME=0
SEAL=0; for a in "$@"; do case "$a" in --seal) SEAL=1;; esac; done
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
if (cd middleware && npx tsc --noEmit >/dev/null 2>&1); then ok "tsc clean"; else fail "middleware: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest --silent >/dev/null 2>&1); then ok "jest green"; else fail "middleware: jest failures"; fi
fi

section "portal"
if (cd portal && npx tsc --noEmit >/dev/null 2>&1); then ok "tsc clean"; else fail "portal: tsc errors"; fi
if (cd portal && node --test 'src/pages/**/__tests__/*.test.ts' 2>&1 | grep -qE '^ℹ fail 0$'); then ok "node tests green"; else fail "portal: node test failures"; fi
if [ "$QUICK" = 0 ]; then
  if (cd portal && npx vite build 2>&1 | grep -q '✓ built'); then ok "vite build"; else fail "portal: vite build fails"; fi
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
RAW_RE='<(div|p|span|h[1-6]|ul|ol|li|section|nav|article|table|tr|td|th|button|a|label|input|textarea|select|form|code|pre)( [^>]*)?className='
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
QUEUED_FILES=$(grep -oE "Composed locally in \`portal/src/pages/assessment/[A-Za-z0-9_/.-]+\.tsx\`" "$QUEUE" 2>/dev/null | grep -oE "portal/src/pages/assessment/[A-Za-z0-9_/.-]+\.tsx" | sort -u)
page_files() { find "$PAGES" -name '*.tsx' | sort | grep -vxF -f <(printf '%s\n' $QUEUED_FILES) ; }
count_in() { local re="$1"; shift; local n=0; for f in "$@"; do c=$(grep -oE "$re" "$f" | wc -l | tr -d ' '); n=$((n+c)); done; echo "$n"; }
PAGE_FILES=$(page_files)
n_div=$(count_in '<div( [^>]*)?className=' $PAGE_FILES)
n_btn=$(count_in '<button' $PAGE_FILES)
n_sty=$(count_in 'style=\{\{' $PAGE_FILES)
n_raw=$(count_in "$RAW_RE" $PAGE_FILES)
q_over=""
for f in $QUEUED_FILES; do [ -f "$f" ] || continue; c=$(grep -oE "$RAW_RE" "$f" | wc -l | tr -d ' '); [ "$c" -le "$QUEUED_MAX_PER_FILE" ] || q_over="$q_over ${f#$PAGES/}($c)"; done
n_queued=$(printf '%s\n' $QUEUED_FILES | grep -c . || true)
[ -z "$q_over" ] && ok "$n_queued queued composites, each ≤ $QUEUED_MAX_PER_FILE raw elements" || fail "queued composite over the per-file cap of $QUEUED_MAX_PER_FILE:$q_over"
[ "$n_div" = 0 ] && ok "no raw <div className> (0)" || fail "raw <div className> in pages: $n_div (must be 0 — use Stack/Inline/Card/RailSection/DetailSection/PageSection)"
[ "$n_btn" = 0 ] && ok "no raw <button> (0)" || fail "raw <button> in pages: $n_btn (must be 0 — use Button/IconButton/SelectableCard)"
[ "$n_sty" = 0 ] && ok "no inline style={{}} (0)" || fail "inline style={{}} in pages: $n_sty (must be 0)"
if [ "$n_raw" -le "$MAX_RAW_ELEMENTS" ]; then ok "raw styled elements: $n_raw (budget $MAX_RAW_ELEMENTS)"; else
  fail "raw styled elements: $n_raw > budget $MAX_RAW_ELEMENTS — worst files:"
  for f in $PAGE_FILES; do c=$(grep -oE "$RAW_RE" "$f" | wc -l | tr -d ' '); [ "$c" -gt 0 ] && printf '      %4d  %s\n' "$c" "${f#$PAGES/}"; done | sort -rn | head -8
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
# Freshness, per surface: an audit of code that has since changed is not an
# audit — but a global "newest page edit" rule stales all 63 logs for a
# one-line fix on one page, which is how this check spent a day red without
# telling anyone WHICH audit was actually out of date. A log is judged
# against the recorded content digest of the files/dirs its own `pages:` line
# names (see PROTOCOL.md); a log with no `pages:` line falls back to hashing
# the full assessment source set. Normal validation never records evidence.
# Only audit logs are held to freshness: the role×surface logs and the
# isolation logs. PROTOCOL.md, DEFECTS.md and fixtures are not audits.
# Retired-tenant isolation archives document deleted code, not the current
# product. The active role matrix above and active isolation checks below
# remain mandatory; archived source paths cannot acquire a fresh digest.
if [ -d "$JDIR" ]; then

# ── Freshness is about CONTENT, not mtime ────────────────────────────────
# See docs/orgiq-journeys/PROTOCOL.md § "Freshness is about content": on
# 2026-09-07 a bulk operation stamped 134 portal source files with one
# identical mtime while changing none of them (the dev server logged no HMR
# update for any), and logs "went stale" against edits that never happened.
# A digest that moves is a change; an mtime that moves alone is not.
SHA_CACHE="$JDIR/.pages-sha"
pages_sha() {
  local out="" ; IFS=',' read -ra items <<< "$1"
  for d in "${items[@]}"; do d=$(echo "$d" | tr -d ' '); [ -n "$d" ] || continue
    if [ -f "$d" ]; then out="$out$(shasum -a 256 "$d" 2>/dev/null)"; continue; fi
    [ -d "$d" ] || { echo "Missing audit source: $d" >&2; return 1; }
    local files; files=$(find "$d" -name '*.tsx' 2>/dev/null | sort)
    [ -n "$files" ] || { echo "No audit source files in $d" >&2; return 1; }
    out="$out$(printf '%s\n' "$files" | xargs shasum -a 256 2>/dev/null)"
  done
  [ -n "$out" ] || { echo "No audit source files found" >&2; return 1; }
  printf '%s' "$out" | shasum -a 256 | cut -d' ' -f1
}
sha_recorded() { grep -F "$1 " "$SHA_CACHE" 2>/dev/null | tail -1 | cut -d' ' -f2; }
sha_record() {
  [ -f "$SHA_CACHE" ] || : > "$SHA_CACHE"
  grep -vF "$1 " "$SHA_CACHE" > "$SHA_CACHE.tmp" 2>/dev/null || : > "$SHA_CACHE.tmp"
  printf '%s %s\n' "$1" "$2" >> "$SHA_CACHE.tmp"
  sort -o "$SHA_CACHE" "$SHA_CACHE.tmp" && rm -f "$SHA_CACHE.tmp"
}
  stale=0; stale_names=""
  for f in $(find "$JDIR" -name '*.md' ! -name 'PROTOCOL.md' ! -name 'DEFECTS.md' ! -path '*/fixtures/*' ! -path '*/isolation/archived-*/*' 2>/dev/null); do
    pages=$(grep -iE '^pages: *' "$f" | head -1 | sed -E 's/^pages: *//')
    cur_sha=$(pages_sha "${pages:-$PAGES_FALLBACK}") || { stale=$((stale+1)); stale_names="$stale_names ${f#$JDIR/}(invalid-pages)"; continue; }
    if [ "$(sha_recorded "$f")" != "$cur_sha" ]; then
      stale=$((stale+1)); stale_names="$stale_names ${f#$JDIR/}(content-digest)"
    fi
    [ "$SEAL" = 1 ] && sha_record "$f" "$cur_sha"
  done
  [ "$stale" = 0 ] && ok "journey logs match their recorded source content" || fail "$stale journey logs have missing or different source digests — re-audit them:$stale_names"
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
if grep -q "DataTable" "$PAGES/FeedbackPage.tsx" && grep -q "<Drawer" "$PAGES/FeedbackPage.tsx" && ! grep -q "<Card" "$PAGES/FeedbackPage.tsx"; then
  ok "slice 2 — feedback is a DataTable + Drawer, no per-question Card"
else fail "slice 2 — FeedbackPage.tsx must render a DataTable and a Drawer and no <Card"; fi
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
compute_mounts=$(grep -oE '<[A-Za-z]*(Devbox|Compute|Machine)[A-Za-z]*' "$SHELL_LAYOUT" | tr -d '<' | sort -u)
n_compute=$(printf '%s\n' "$compute_mounts" | grep -c . | tr -d ' ')
ungated=""
for c in $compute_mounts; do
  grep -qE "session\?\.tenant === 'orgiq' && <$c\b" "$SHELL_LAYOUT" || ungated="$ungated $c"
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
