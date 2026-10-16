#!/usr/bin/env bash
# The judge for docs/user-search-goal.md — can each tenant's people find what
# they ask for, and is nothing they are told wrong? Exits 0 only when every
# check passes; prints every failing line so one run shows the whole backlog.
#
#   ./scripts/validate-user-search.sh            # everything; the journey logs are judged as last walked
#   ./scripts/validate-user-search.sh --quick    # no browser, no journey logs: catalog, freshness, floors, guard, parity
#   ./scripts/validate-user-search.sh --walk     # walk the search journey maps first (needs Vite :5183 + middleware :3001)
#   ./scripts/validate-user-search.sh --probe    # re-run the probe first, as clones, one worker per walker (USER_SEARCH_WORKERS, default 4;
#                                                USER_SEARCH_ONLY=access re-probes named tenants; needs the stack; one probe run at a time)
set -u
cd "$(dirname "$0")/.."
QUICK=0; WALK=0; PROBE=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; --walk) WALK=1;; --probe) PROBE=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
relay() { while IFS=$'\t' read -r kind text; do case "$kind" in ok) ok "$text";; fail) fail "$text";; note) note "$text";; *) [ -n "$kind" ] && note "$kind $text";; esac; done; }
RESULTS=docs/user-search-probe-results.json

# ── 0 the documents ─────────────────────────────────────────────────────────
section "0 documents"
for f in docs/user-search-goal.md docs/user-search-intents.md docs/user-search-journeys/PROTOCOL.md portal/e2e/user-search-catalog.ts portal/e2e/user-search-probe.spec.ts \
         scripts/user-search-report.mjs scripts/user-search-floors.tsv scripts/user-search-freshness.mjs scripts/user-search-catalog.mts scripts/check-search-writers.mjs $RESULTS; do
  if [ -f "$f" ]; then ok "$f"; else fail "$f missing"; fi
done
if grep -q 'user-search-goal.md' CLAUDE.md && grep -q 'validate-user-search.sh' CLAUDE.md; then ok "CLAUDE.md docs map lists the goal and this judge"; else fail "CLAUDE.md docs map has no user-search row"; fi

# ── 1 catalog integrity ─────────────────────────────────────────────────────
section "1 catalog integrity (portal/e2e/user-search-catalog.ts against the dev:mock seed)"
relay < <(cd middleware && npx tsx ../scripts/user-search-catalog.mts check 2>/dev/null | grep -E $'^(ok|fail|note)\t' || echo $'fail\tthe catalog check did not run (cd middleware && npx tsx ../scripts/user-search-catalog.mts check)')

# ── 2 probe freshness ───────────────────────────────────────────────────────
section "2 probe freshness"
if [ "$PROBE" = 1 ]; then
  (cd portal && npx playwright test e2e/user-search-probe.spec.ts --workers=${USER_SEARCH_WORKERS:-4} --reporter=line) >/dev/null 2>&1 || note "the probe run reported failures (judged from the results below)"
fi
now=$(node scripts/user-search-freshness.mjs)
was=$(node -e "const r=require('./$RESULTS');process.stdout.write(String(r.watchedDigest??''))")
when=$(node -e "const r=require('./$RESULTS');process.stdout.write(String(r.generatedAt??''))")
if [ "$now" = "$was" ]; then ok "results ($when) were probed on this tree's search, answer, palette and composer sources and this catalog ($now)"
else fail "results are stale: probed on $was, the tree is $now — a file under scripts/user-search-freshness.mjs WATCHED changed; re-probe (--probe)"; fi
missing=$(node -e "const r=require('./$RESULTS');const ids=new Set(r.probes.map(p=>p.intent));const m=r.intents.filter(i=>!ids.has(i.id)).map(i=>i.id);process.stdout.write(m.join(' '))")
if [ -z "$missing" ]; then ok "every catalog intent has probes"; else fail "intents never probed: $missing"; fi

# ── 3 + 4 floors: pass rate up, wrong-on-best down ─────────────────────────
section "3-4 per-tenant floors (scripts/user-search-floors.tsv): pass rate ≥ floor, wrong on the best surface ≤ max"
while read -r l; do case "$l" in PASS*) ok "${l#PASS }";; FAIL*) fail "${l#FAIL }";; *) note "$l";; esac; done < <(node scripts/user-search-report.mjs --floors scripts/user-search-floors.tsv)
# Ratchet: a floor never moves down and a max never moves up against the committed file.
if git cat-file -e HEAD:scripts/user-search-floors.tsv 2>/dev/null; then
  rat=$(node -e "
    const fs=require('fs'),cp=require('child_process');
    const parse=t=>Object.fromEntries(t.split('\n').filter(l=>l&&!l.startsWith('#')&&!l.startsWith('tenant\t')).map(l=>{const [t,f,m]=l.split('\t');return [t,{f:+f,m:+m}];}));
    const now=parse(fs.readFileSync('scripts/user-search-floors.tsv','utf8')), was=parse(cp.execSync('git show HEAD:scripts/user-search-floors.tsv').toString());
    const bad=[];for(const [t,w] of Object.entries(was)){const n=now[t];if(!n){bad.push(t+' removed');continue;}if(n.f<w.f)bad.push(t+' floor '+w.f+' → '+n.f);if(n.m>w.m)bad.push(t+' max wrong '+w.m+' → '+n.m);}
    process.stdout.write(bad.join('; '));")
  if [ -z "$rat" ]; then ok "floors only ratcheted (against HEAD)"; else fail "floors moved the wrong way: $rat"; fi
else note "no committed floors yet: the ratchet is judged from the next commit on"; fi

# ── 5 journey maps per intent family ───────────────────────────────────────
section "5 journey maps (docs/journeys/maps/user-search, logs in docs/user-search-journeys)"
chk=$(node scripts/journeys/run-maps.mjs check --family user-search 2>&1 | tail -1)
case "$chk" in *"0 problem"*) ok "maps valid: $chk";; *) fail "maps invalid: $chk";; esac
mapped=$(node -e "const r=require('./$RESULTS');process.stdout.write(r.intents.filter(i=>i.map).map(i=>i.tenant+'/'+i.role+'/'+i.id).join(' '))")
nomap=""; for k in $mapped; do [ -f "docs/journeys/maps/user-search/$k.ts" ] || nomap="$nomap $k"; done
if [ -z "$nomap" ]; then ok "every mapped intent ($(echo $mapped | wc -w | tr -d ' ')) has a map"; else fail "mapped intents without a map:$nomap"; fi
if [ "$WALK" = 1 ]; then node scripts/journeys/run-maps.mjs walk --family user-search --no-seal >/dev/null 2>&1 || note "the walk reported failures (judged from the logs below)"; fi
if [ "$QUICK" = 0 ]; then
  held=0; passed=0
  for k in $mapped; do
    tenant=${k%%/*}; rest=${k#*/}; role=${rest%%/*}; id=${rest#*/}
    file="docs/journeys/maps/user-search/$k.ts"; log="docs/user-search-journeys/$tenant/$role-$id.md"
    if grep -qE '^\s*hold:' "$file"; then held=$((held+1)); note "pending $k: $(grep -m1 -E '^\s*hold:' "$file" | sed 's/^ *hold: *//' | cut -c1-90)"; continue; fi
    if [ ! -f "$log" ]; then fail "map $k: never walked ($log missing — run with --walk)"; continue; fi
    if grep -qE '^verdict: *pass' "$log" && grep -qE '^answers-question: *pass' "$log" && grep -qE '^record-open: *pass' "$log"; then passed=$((passed+1))
    else fail "map $k: $(grep -m1 -E '^(answers-question|record-open|verdict):.*fail' "$log" | cut -c1-160)"; fi
  done
  ok "$passed map(s) walked and passing; $held held for a later phase"
fi

# ── 6 storage-agnostic guard ───────────────────────────────────────────────
section "6 storage-agnostic search (no SQL client, no SQL text under providers/search* or lib/search-index)"
FILES=$(ls middleware/src/providers/search*.ts 2>/dev/null; find middleware/src/lib/search-index -name '*.ts' ! -path '*/__tests__/*')
imp=$(grep -nE "from '(@aws-sdk/client-rds-data|pg|postgres|pg-promise)'|require\('(pg|@aws-sdk/client-rds-data)'\)|providers/aurora\.js'|\bexec\(" $FILES)
if [ -z "$imp" ]; then ok "no SQL client or Data API import"; else fail "SQL client imported: $(echo "$imp" | head -2 | tr '\n' ' ')"; fi
sql=$(grep -nE "['\"\`][^'\"\`]*\b(SELECT [A-Za-z*]|INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM|CREATE TABLE|ILIKE|tsvector|to_tsquery|pg_trgm|similarity\()" $FILES)
if [ -z "$sql" ]; then ok "no SQL statement, pg_trgm or tsvector in a string literal"; else fail "SQL text: $(echo "$sql" | head -2 | tr '\n' ' ')"; fi
if (cd middleware && node node_modules/.bin/jest --config jest.config.cjs --verbose src/lib/search-index >/tmp/user-search-jest.$$ 2>&1); then
  legs=$(grep -cE 'SearchIndex contract: kv' /tmp/user-search-jest.$$ || true)
  ok "index contract, question parser and update-on-write suites pass ($( [ "$legs" -gt 0 ] && echo 'memory + kv on the DynamoDB wire' || echo 'memory; no DynamoDB-wire store reachable, kv leg skipped'))"
else fail "search-index suites fail: $(grep -m2 -E '●' /tmp/user-search-jest.$$ | tr '\n' ' ')"; fi
rm -f /tmp/user-search-jest.$$
while read -r l; do case "$l" in "search writers:"*) case "$l" in *" 0 failing") ok "update on write: ${l#search writers: }";; *) fail "update on write: ${l#search writers: }";; esac;; *FAIL*) note "$l";; esac; done < <(node scripts/check-search-writers.mjs)

# ── 7 clone parity ──────────────────────────────────────────────────────────
section "7 clone parity (\"mine\" answers are keyed by the person)"
relay < <(cd middleware && npx tsx ../scripts/user-search-clone-parity.mts 2>/dev/null | grep -E $'^(ok|fail|note)\t' || echo $'fail\tthe clone-parity check did not run')

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS — user search answers what each tenant asks, at or above its floors"; exit 0; fi
echo "${#FAILS[@]} failing check(s) — docs/user-search-goal.md names the phase for each"
exit 1
