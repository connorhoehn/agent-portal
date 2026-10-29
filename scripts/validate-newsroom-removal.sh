#!/usr/bin/env bash
# Definition of done for docs/newsroom-removal-goal.md. Exit 0 only when the
# newsroom tenant is gone everywhere it can execute. --quick skips jest/build.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
QUICK=0; for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done
FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

PAT='newsroom|news-researcher|news-brief|news-headline|news_researcher|news_brief|news_headline|newsroom_'

# ─────────────────────────────────────────────────────────────────────────────
section "no surviving references (code, infra, schema, agents, scripts)"
for area in middleware/src middleware/seeds portal/src agents infra/lib infra/bin infra/lambda infra/scripts schema/synth schema/load_schema.py schema/identity_schema.sql schema/seed_kb_registry.sql schema/orgiq_kb_registry_schema.sql scripts CLAUDE.md README.md CONSTITUTION.md; do
  [ -e "$area" ] || continue
  # Other judges may invoke or inspect this judge. Ignore that exact script
  # path, while still rejecting a retired tenant reference elsewhere on the
  # same line or in the same file.
  hits=$(grep -rliE "$PAT" "$area" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.venv 2>/dev/null | grep -v "validate-newsroom-removal.sh" | grep -v "schema/migrations/" | while IFS= read -r file; do
    if sed 's#scripts/validate-newsroom-removal\.sh##g' "$file" | grep -qiE "$PAT"; then printf '%s\n' "$file"; fi
  done)
  if [ -z "$hits" ]; then ok "$area"; else
    n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
    fail "$area: $n file(s) still mention the newsroom"
    printf '%s\n' "$hits" | head -12 | sed 's/^/      /'
  fi
done
for gone in agents/news-researcher agents/news-brief agents/news-headline portal/src/pages/newsroom middleware/src/routes/newsroom-articles.ts middleware/src/routes/newsroom-beats.ts middleware/src/providers/newsroom-articles.ts middleware/src/providers/newsroom-beats.ts middleware/src/mock/newsroom.ts middleware/seeds/roles/newsroom schema/newsroom_schema.sql; do
  [ -e "$gone" ] && fail "still exists: $gone" || true
done
ok "deletion list checked"

section "tenancy model"
# Re-pointed 2026-09-29 at "the retired tenant is absent" rather than "exactly
# these two": the social and pipelines tenants joined TENANTS, and a pin on the
# literal two-tenant list would turn this judge red for a reason unrelated to
# the tenant it guards (docs/social-tenant-and-pipelines-research-2026-09-29.md
# §A.3). The surviving tenants must still lead the list.
# TENANTS is generated from tenants/manifest.json (DE-29); session.ts re-exports it.
tenants_line=$(grep -E "^export const TENANTS" middleware/src/lib/tenants.generated.ts)
if printf '%s' "$tenants_line" | grep -qE "TENANTS\s*=\s*\[\s*'orgiq'\s*,\s*'assessment'(\s*,|\s*\])" && ! printf '%s' "$tenants_line" | grep -qiE "$PAT"; then
  ok "TENANTS keeps orgiq + assessment and names no retired tenant"
else fail "middleware/src/lib/tenants.generated.ts TENANTS lost orgiq/assessment or names the retired tenant"; fi
grep -qE "'reporter'|'editor'" middleware/src/lib/session.ts middleware/src/lib/tenants.generated.ts middleware/src/lib/role-registry.ts middleware/src/lib/authz.ts 2>/dev/null && fail "reporter/editor roles survive in session/role-registry/authz" || ok "reporter/editor roles gone"
grep -qE "u-reporter|u-editor" middleware/src/providers/identity.ts schema/identity_schema.sql 2>/dev/null && fail "seed users u-reporter/u-editor survive" || ok "seed users gone"
# auth.tsx re-exports the generated Tenant union (tenants/manifest.json, DE-29).
tenant_type=$(grep -E "^export type Tenant\s*=" portal/src/lib/tenants.generated.ts)
if printf '%s' "$tenant_type" | grep -qE "Tenant\s*=\s*'orgiq'\s*\|\s*'assessment'(\s*\||\s*;)" && ! printf '%s' "$tenant_type" | grep -qiE "$PAT"; then
  ok "portal Tenant type keeps orgiq | assessment and names no retired tenant"
else fail "portal/src/lib/tenants.generated.ts Tenant type lost orgiq/assessment or names the retired tenant"; fi
[ -f portal/src/lib/features.ts ] && grep -qiE "NEWSROOM" portal/src/lib/features.ts && fail "NEWSROOM feature flag survives in features.ts" || ok "no newsroom feature flag"

section "schema"
[ -f schema/migrations/2026-09-05-drop-newsroom.sql ] && grep -qi "DROP TABLE IF EXISTS" schema/migrations/2026-09-05-drop-newsroom.sql && ok "drop migration written" || fail "schema/migrations/2026-09-05-drop-newsroom.sql missing or has no DROP TABLE IF EXISTS"
grep -q "drop-newsroom" schema/load_schema.py && fail "load_schema.py must NOT auto-run the drop migration" || ok "drop migration is not auto-run"

section "docs"
[ -f docs/newsroom-removal.md ] && ok "docs/newsroom-removal.md exists" || fail "docs/newsroom-removal.md missing (what was removed, the migration, how to restore)"
[ -d docs/assessment-journeys/isolation/archived-newsroom ] && ok "reporter/editor isolation logs archived" || fail "docs/assessment-journeys/isolation/archived-newsroom/ missing"
grep -qE "OUTSIDE_ROLES=\(member sme program-owner org-leader hr-admin\)" scripts/validate-assessment-tenant.sh && ok "assessment validator isolation matrix = 5 orgiq roles" || fail "scripts/validate-assessment-tenant.sh still audits reporter/editor"

section "builds and suites"
if jg_mw_tsc >/dev/null 2>&1; then ok "middleware tsc"; else fail "middleware: tsc errors"; fi
if jg_portal_tsc >/dev/null 2>&1; then ok "portal tsc"; else fail "portal: tsc errors"; fi
if [ "$QUICK" = 0 ]; then
  if (cd middleware && npx jest >/dev/null 2>&1); then ok "middleware jest"; else fail "middleware: jest failures"; fi
  if (cd portal && node --test 'src/**/__tests__/*.test.ts' >/dev/null 2>&1); then ok "portal node tests"; else fail "portal: node tests failing"; fi
  if jg_vite_build >/dev/null 2>&1; then ok "portal vite build"; else fail "portal: vite build failed"; fi
  if scripts/validate-assessment-tenant.sh --quick --no-time >/dev/null 2>&1; then ok "assessment validator still passes"; else fail "assessment validator regressed"; fi
fi

section "journey proof"
J=docs/newsroom-removal-journey.md
if [ -f "$J" ]; then
  bad=""
  grep -qiE '^picker-workspaces: *(Org|orgiq)[^\n]*(Assessment|assessment)' "$J" || bad="$bad picker"
  grep -qiE '^newsroom-route-result: *(not-found|redirect)' "$J" || bad="$bad route"
  grep -qiE '^newsroom-api-status: *404' "$J" || bad="$bad api"
  grep -qiE '^palette-newsroom-entries: *0' "$J" || bad="$bad palette"
  grep -qiE '^verdict: *pass' "$J" || bad="$bad verdict"
  grep -qiE 'TODO|unverified|placeholder' "$J" && bad="$bad TODO"
  [ -z "$bad" ] && ok "journey proof passes" || fail "journey proof fails:$bad"
else fail "$J missing"; fi

echo
if [ "${#FAILS[@]}" = 0 ]; then echo "ALL CHECKS PASS — the newsroom tenant is gone."; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done; exit 1
