#!/usr/bin/env bash
# Definition of done for the mock data floor — the judge for the mock data
# floor in middleware/src/mock/core/. Exit 0 only when every check passes.
#
#   --quick   skip the full jest run (still runs tsc and the floor's own suites)
#   --static  source/snapshot checks only; requires separate build/test evidence
#
# What each section enforces, and what it cannot see, is written out in
# Read this script before loosening anything here.
set -u
cd "$(dirname "$0")/.."
source scripts/lib/judges.sh  # jg_*: static gates run once per tree state
REPO="$PWD"
MW="$REPO/middleware"
QUICK=0; STATIC_ONLY=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; --static) STATIC_ONLY=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# Snapshot freshness, by CONTENT.
#
# The snapshot records `serverHandlerSha` — the digest of the handler sources
# the capturing SERVER booted from, as that server reported it. We recompute
# the digest from disk, through the SAME implementation the server used
# (middleware/src/mock/core/wire/handler-sha.ts), and compare. One
# implementation on purpose: the last time this repo answered one question with
# two hash functions they disagreed, and a seal got written that nothing could
# reproduce.
#
# A snapshot with no digest is stale, not exempt — it was taken before this
# check existed, or against a process that could not report one, and either way
# nothing vouches for it.
snapsha_check() {
  snap="$1"; label="$2"
  recorded=$(node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).serverHandlerSha;
      process.stdout.write(typeof v === "string" ? v : "");
    } catch { process.stdout.write(""); }
  ' "$snap")
  actual=$(cd "$MW" && npx tsx src/mock/core/wire/print-handler-sha.ts 2>/dev/null)
  if [ -z "$actual" ]; then
    fail "$label: could not compute the handler digest — is middleware/node_modules present?"
  elif [ -z "$recorded" ]; then
    fail "$label records no serverHandlerSha — recapture it"
  elif [ "$recorded" = "$actual" ]; then
    ok "$label was captured from the handler sources on disk"
  else
    fail "$label was captured from DIFFERENT handler sources than are on disk — recapture it"
    note "recorded ${recorded%%????????????????????????????????????????????????????????}… vs on disk ${actual%%????????????????????????????????????????????????????????}…"
  fi
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# The static scanner behind the widened halves of rules 3 and 4. One run, two
# outputs — it parses every module under src/{routes,lib,providers} with the
# TypeScript parser, which is the expensive part. See
# middleware/src/mock/core/wire/mock-branches.ts.
SCAN_OK=1
if (cd "$MW" && node node_modules/.bin/tsx src/mock/core/wire/mock-branches.ts both \
      > "$TMP/scan.txt" 2>"$TMP/scan.err"); then
  grep '^MINT ' "$TMP/scan.txt" | sed 's/^MINT //' > "$TMP/mints.txt" || true
  grep '^WRITE ' "$TMP/scan.txt" | sed 's/^WRITE //' > "$TMP/writes.txt" || true
else
  SCAN_OK=0
  : > "$TMP/mints.txt"; : > "$TMP/writes.txt"
fi

# A ratchet: read <file>, compare <count>, fail when it grew, note when the
# file is stale. Both widened rules use the same contract as rule 1's budget.
# $1 file  $2 count  $3 what it counts  $4 how to lower it
ratchet() {
  local file=$1 n=$2 what=$3 how=$4 budget
  budget=$(tr -d ' \n' < "$file" 2>/dev/null || true)
  if [ -z "$budget" ]; then fail "$file missing (write the current count, $n)"; return; fi
  if [ "$n" -le "$budget" ]; then ok "$what: $n ≤ budget $budget"
  else fail "$what: $n > budget $budget — $how"; fi
  [ "$n" -lt "$budget" ] && note "budget is stale: lower $file to $n"
  return 0
}

# Files the floor's rules apply to. `core/` is the floor itself (it is allowed
# to call Date.now — it *is* the clock) and `__tests__` are tests, not fixtures.
mock_sources() {
  find "$MW/src/mock" -name '*.ts' ! -path '*__tests__*' ! -path '*/core/*' | sort
}
provider_sources() {
  find "$MW/src/providers" -name '*.ts' ! -path '*__tests__*' | sort
}
rel() { printf '%s\n' "${1#$REPO/}"; }

# Strip `//` line comments and whole-line block-comment bodies, so a rule is
# never triggered by a comment describing the bug it forbids — mock/traces.ts
# and mock/capabilities.ts both open by quoting the Date.now() they removed.
strip_comments() {
  sed -E -e 's://.*::' -e 's:^[[:space:]]*\*.*::' "$1"
}

# ─────────────────────────────────────────────────────────────────────────────
if [ "$STATIC_ONLY" = 1 ]; then
  section "builds — not run in --static mode"
  note "Separate compilation and test evidence is required; this run cannot establish the full definition of done."
else
section "builds"
if jg_mw_tsc >"$TMP/tsc.log" 2>&1; then ok "middleware tsc"; else
  fail "middleware: tsc errors"
  head -5 "$TMP/tsc.log" | while read -r l; do note "$l"; done
fi
if [ "$QUICK" = 0 ]; then
  if (cd "$MW" && npm test >"$TMP/jest.log" 2>&1); then
    ok "middleware npm test ($(grep -oE 'Tests: *[0-9]+ passed' "$TMP/jest.log" | tail -1))"
  else
    fail "middleware: jest failures (parity + wire suites are part of this)"
    grep -E '^(FAIL|  ●)' "$TMP/jest.log" | head -8 | while read -r l; do note "$l"; done
  fi
else
  if (cd "$MW" && npm test -- src/mock >"$TMP/jest.log" 2>&1); then ok "floor suites (src/mock) green"; else
    fail "middleware: src/mock jest failures"
    grep -E '^(FAIL|  ●)' "$TMP/jest.log" | head -8 | while read -r l; do note "$l"; done
  fi
fi

fi

# ─────────────────────────────────────────────────────────────────────────────
# RULE 1 — no typed aggregates.
#
# A count/total/rate/average written as a literal beside the rows it claims to
# summarise. This is a HEURISTIC and it is a ratchet, not a gate: it matches a
# SHAPE (`documentCount: 1247`), and it cannot tell a drifting aggregate (the
# rows are right there in the same fixture) from a leaf metric (nothing in the
# repo to count). Both limits are described in this script; the budget
# may only go down, and it goes down by deriving a real aggregate with
# countBy/sumBy — never by deleting a leaf metric to buy a point.
section "rule 1 — no typed aggregates (ratchet)"
BUDGET_FILE=scripts/mock-aggregate-budget.txt
BUDGET_START=29
AGG_RE='^[[:space:]]*(total[A-Za-z0-9_]*|[A-Za-z0-9_]*[Cc]ount|[A-Za-z0-9_]*[Rr]ate|avg[A-Za-z0-9_]*|[A-Za-z0-9_]*[Tt]otal|[A-Za-z0-9_]*_avg|[A-Za-z0-9_]*_count|[A-Za-z0-9_]*_rate|[A-Za-z0-9_]*_total)[[:space:]]*:[[:space:]]*-?(0*[1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)[,;]?[[:space:]]*$'
AGG_CONST_RE='^export const [A-Za-z0-9_]*([Cc]ount|[Tt]otal|[Rr]ate|Avg)[A-Za-z0-9_]*[^=]*=[[:space:]]*-?[0-9]'
: > "$TMP/agg.txt"
for f in $(mock_sources) $(provider_sources); do
  strip_comments "$f" | grep -nE "$AGG_RE" | sed "s|^|$(rel "$f"):|" >> "$TMP/agg.txt" || true
  strip_comments "$f" | grep -nE "$AGG_CONST_RE" | sed "s|^|$(rel "$f"):|" >> "$TMP/agg.txt" || true
done
n_agg=$(wc -l < "$TMP/agg.txt" | tr -d ' ')
budget=$(tr -d ' \n' < "$BUDGET_FILE" 2>/dev/null || true)
if [ -z "$budget" ]; then
  fail "$BUDGET_FILE missing (write the current count, baseline $BUDGET_START)"; budget=$BUDGET_START
fi
if [ "$budget" -gt "$BUDGET_START" ]; then
  fail "aggregate budget $budget was raised above the $BUDGET_START baseline — it may only go down"
fi
if [ "$n_agg" -le "$budget" ]; then
  ok "typed-aggregate shapes: $n_agg ≤ budget $budget"
else
  fail "typed-aggregate shapes: $n_agg > budget $budget — derive it (countBy/sumBy) or, if it is a leaf metric"
fi
if [ "$n_agg" -lt "$budget" ]; then
  note "budget is stale: lower $BUDGET_FILE to $n_agg"
fi
if [ "$n_agg" -gt 0 ]; then
  note "where they are:"
  cut -d: -f1 "$TMP/agg.txt" | sort | uniq -c | sort -rn | head -8 | while read -r c f; do note "$(printf '%4d  %s' "$c" "$f")"; done
fi

# ─────────────────────────────────────────────────────────────────────────────
# RULE 3 — timestamps come from the clock.
#
# `Date.now()` and a no-argument `new Date()` MINT an instant. A fixture must
# mint through mock/core/clock.ts instead, so freezeClock works and so a "today"
# row stays today at 00:05 UTC. `new Date(<something>)` that PARSES an existing
# value (sorting, adding an offset to a clock-derived stamp) is a read, not a
# mint, and is left alone. A literal ISO timestamp is a mint frozen at edit time.
section "rule 3 — timestamps come from the clock"
: > "$TMP/ts.txt"
ISO_RE="'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}"
for f in $(mock_sources); do
  strip_comments "$f" | grep -nE 'Date\.now\(\)|new Date\([[:space:]]*\)' | sed "s|^|$(rel "$f"):|" >> "$TMP/ts.txt" || true
  strip_comments "$f" | grep -nE "$ISO_RE" | sed "s|^|$(rel "$f"):ISO |" >> "$TMP/ts.txt" || true
done
n_ts=$(wc -l < "$TMP/ts.txt" | tr -d ' ')
if [ "$n_ts" = 0 ]; then ok "no Date.now()/new Date()/ISO literal in middleware/src/mock/**"; else
  fail "$n_ts wall-clock mint(s) outside mock/core/clock.ts — use clock.nowIso()/hoursAgo()/daysAgo()"
  while IFS= read -r l; do note "$l"; done < "$TMP/ts.txt"
fi

# ...and the same rule inside PROVIDER mock branches, which the grep above
# cannot see because it only walks src/mock/**. A provider minting its own
# timestamp inside its own `config.mock` branch is a fixture timestamp living
# outside the fixture directory — providers/agent-projects.ts `markCloned` did
# exactly that, undetected, for as long as the rule was scoped to src/mock. The
# scan is AST-based (an `if (config.mock…)` then-branch, or the else of a
# negated one), so `new Date(<something>)` that parses is left alone. Ratchet,
# because there are more of these than any one slice can fix.
if [ "$SCAN_OK" = 0 ]; then
  fail "the provider mock-branch scanner did not run"
  head -5 "$TMP/scan.err" | while read -r l; do note "$l"; done
else
  n_mint=$(wc -l < "$TMP/mints.txt" | tr -d ' ')
  ratchet scripts/mock-mint-budget.txt "$n_mint" \
    "wall-clock mints inside a provider mock branch" \
    "route the stamp through mock/core/clock.ts"
  if [ "$n_mint" -gt 0 ]; then
    note "where they are:"
    cut -d: -f1 "$TMP/mints.txt" | sort | uniq -c | sort -rn | head -8 \
      | while read -r c f; do note "$(printf '%4d  %s' "$c" "$f")"; done
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# RULE 4 — every mounted route has a mock branch.
#
# The evidence is the wire capture, which GETs the whole surface against a real
# `dev:mock` process: a route recorded as `HTTP 500` there has no mock branch —
# it fell through to an AWS call that cannot be made offline. This covers GET
# only (capture is GET-only); a write route with no mock branch is invisible
# here and is caught by an audit, not by this script.
#
# Rule 6 below is what keeps this honest — a stale capture would let a newly
# broken route pass.
section "rule 4 — every mounted route has a mock branch"
WIRE="$MW/src/mock/core/wire/snapshots/wire.json"
EXEMPT=scripts/mock-floor-exemptions.txt
if [ ! -f "$WIRE" ]; then fail "wire snapshot missing: $(rel "$WIRE")"; else
  node -e '
    const fs = require("fs");
    const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [route, v] of Object.entries(w.routes)) {
      if (typeof v.skipped === "string" && v.skipped.includes("HTTP 500")) console.log(route);
    }
  ' "$WIRE" | sort > "$TMP/blank.txt"
  # Exemptions: `GET /path | reason`. A bare route with no reason is not an
  # exemption — the same contract mock/core/wire/allow.ts uses.
  : > "$TMP/exempt.txt"; : > "$TMP/noreason.txt"
  if [ -f "$EXEMPT" ]; then
    grep -vE '^[[:space:]]*(#|$)' "$EXEMPT" | while IFS= read -r line; do
      route=$(printf '%s' "$line" | sed -E 's/[[:space:]]*\|.*//' | sed -E 's/[[:space:]]+$//')
      reason=$(printf '%s' "$line" | sed -E 's/^[^|]*(\||$)//' | sed -E 's/^[[:space:]]+//')
      if [ -z "$reason" ]; then printf '%s\n' "$route" >> "$TMP/noreason.txt"
      else printf '%s\n' "$route" >> "$TMP/exempt.txt"; fi
    done
  fi
  sort -o "$TMP/exempt.txt" "$TMP/exempt.txt"
  comm -23 "$TMP/blank.txt" "$TMP/exempt.txt" > "$TMP/blank-unexempt.txt"
  comm -13 "$TMP/blank.txt" "$TMP/exempt.txt" > "$TMP/exempt-stale.txt"
  n_blank=$(wc -l < "$TMP/blank-unexempt.txt" | tr -d ' ')
  n_noreason=$(wc -l < "$TMP/noreason.txt" | tr -d ' ')
  n_stale=$(wc -l < "$TMP/exempt-stale.txt" | tr -d ' ')
  if [ "$n_blank" = 0 ]; then ok "no GET route 500s under dev:mock (outside $EXEMPT)"; else
    fail "$n_blank GET route(s) 500 under dev:mock — no mock branch, so the surface is blank offline"
    while IFS= read -r r; do note "$r"; done < "$TMP/blank-unexempt.txt"
  fi
  [ "$n_noreason" = 0 ] && ok "every exemption carries a reason" || {
    fail "$n_noreason exemption(s) with no reason after '|' in $EXEMPT"
    while IFS= read -r r; do note "$r"; done < "$TMP/noreason.txt"
  }
  [ "$n_stale" = 0 ] && ok "no stale exemptions" || {
    fail "$n_stale exemption(s) name a route that no longer 500s — delete them from $EXEMPT"
    while IFS= read -r r; do note "$r"; done < "$TMP/exempt-stale.txt"
  }
fi

# ── and the write routes, which the capture can never show ───────────────────
#
# You cannot POST or DELETE against a live server during a validation run: the
# writes are real and they mutate the world the next check reads. So this half
# is STATIC — a reachability argument over the call graph from each write
# route's handler through src/{routes,lib,providers}, reporting the routes that
# reach a provider function calling the RDS Data API or an AWS SDK client with
# no `config.mock` (or `auroraConfigured`) branch above it. Four such calls on
# providers/agent-projects.ts 500'd every agent-projects write in dev:mock
# while this section stayed green, because the GET capture could not see them.
#
# It is a ratchet and it is a HEURISTIC in both directions — what it can and
# cannot prove is not checked here.
if [ "$SCAN_OK" = 1 ]; then
  # These remain visible: configured document services use their real durable
  # authority in dev:mock and refuse writes when absent, rather than fabricating
  # successful persistence in Aurora fixtures. The scanner names exact functions.
  n_document_services=$(grep -c '^DOCUMENT_SERVICE ' "$TMP/scan.txt" || true)
  if [ "$n_document_services" -gt 0 ]; then
    note "$n_document_services document-service paths use explicit integration boundaries (not resettable Aurora mocks)"
  fi
  n_write=$(wc -l < "$TMP/writes.txt" | tr -d ' ')
  n_write_routes=$(sed 's/ reaches .*//' "$TMP/writes.txt" | sort -u | wc -l | tr -d ' ')
  ratchet scripts/mock-write-route-budget.txt "$n_write" \
    "write routes reaching an unmocked provider ($n_write_routes distinct route(s))" \
    "give the provider function a config.mock branch"
  if [ "$n_write" -gt 0 ]; then
    note "the routes:"
    sed 's/ reaches .*//' "$TMP/writes.txt" | sort | uniq -c | sort -rn | head -10 \
      | while read -r c r; do note "$(printf '%4d  %s' "$c" "$r")"; done
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# RULE 2 — no invented wire strings, on the WRITE half too.
#
# Rule 2 is enforced in `builds` above by core/wire/__tests__/sweep.test.ts,
# which measures every fixture against the captured server shapes. That capture
# used to be GET-only, so every POST/PUT/PATCH response shape in the app was
# unpinned — the create/update/decide responses, which are exactly the ones a
# portal page reads straight back into its state.
#
# `mock/core/wire/capture-writes.ts` closes that, and this section is what keeps
# it honest. It does NOT issue any write itself: it reads the committed
# snapshot and asserts three things a stale or hand-edited one would fail.
#   1. every write route on the live surface is IN the snapshot;
#   2. every route in it either carries a captured shape or says why not —
#      a refusal rule from write-policy.ts, or a body it could not synthesise.
#      A blank reason is not an entry; same contract as mock/core/wire/allow.ts;
#   3. the snapshot is newer than the handlers it claims to describe (below,
#      with wire.json, in rule 6).
section "rule 2 — write response shapes are captured, not assumed"
WRITES="$MW/src/mock/core/wire/snapshots/writes.json"
if [ ! -f "$WRITES" ]; then
  fail "write snapshot missing: $(rel "$WRITES") — capture it"
else
  node -e '
    const fs = require("fs");
    const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let captured = 0, noReason = [];
    const byRule = {};
    for (const [route, v] of Object.entries(w.routes)) {
      console.log(`ROUTE ${route}`);
      if (v.shape) { captured += 1; continue; }
      const reason = (v.refused && v.refused.reason) || v.skipped || "";
      if (!String(reason).trim()) noReason.push(route);
      if (v.refused) byRule[v.refused.rule] = (byRule[v.refused.rule] || 0) + 1;
    }
    console.log(`CAPTURED ${captured}`);
    console.log(`TOTAL ${Object.keys(w.routes).length}`);
    for (const [r, n] of Object.entries(byRule)) console.log(`RULE ${n} ${r}`);
    for (const r of noReason) console.log(`NOREASON ${r}`);
  ' "$WRITES" > "$TMP/writes-snap.txt"
  grep '^ROUTE ' "$TMP/writes-snap.txt" | sed 's/^ROUTE //' | sort -u > "$TMP/writes-have.txt"
  # Built here from routes.json rather than reused from rule 6's list, because
  # rule 6 runs later and an empty want-list would pass this check vacuously.
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const x of r.routes) if (x.method !== "GET") console.log(`${x.method} ${x.path}`);
  ' "$MW/src/mock/core/wire/snapshots/routes.json" | sort -u > "$TMP/writes-want.txt"
  n_cap=$(grep '^CAPTURED ' "$TMP/writes-snap.txt" | awk '{print $2}')
  n_tot=$(grep '^TOTAL ' "$TMP/writes-snap.txt" | awk '{print $2}')
  missing=$(comm -23 "$TMP/writes-want.txt" "$TMP/writes-have.txt")
  if [ -z "$missing" ]; then
    ok "writes.json covers every write route ($n_cap of $n_tot replayed; the rest refused or uncaptured, each with a reason)"
  else
    fail "writes.json is missing $(printf '%s\n' "$missing" | wc -l | tr -d ' ') write route(s) — recapture"
    printf '%s\n' "$missing" | head -10 | while read -r l; do note "$l"; done
  fi
  n_noreason=$(grep -c '^NOREASON ' "$TMP/writes-snap.txt" || true)
  if [ "${n_noreason:-0}" = 0 ]; then
    ok "every uncaptured write says why"
  else
    fail "$n_noreason write route(s) in writes.json carry neither a shape nor a reason — an assumed-away gap reads exactly like a covered route"
    grep '^NOREASON ' "$TMP/writes-snap.txt" | sed 's/^NOREASON //' | head -10 | while read -r l; do note "$l"; done
  fi
  # The refusals are PRINTED on every run, never summed into silence — the same
  # contract the known-bugs roll-up and the drift roll-up keep.
  if grep -q '^RULE ' "$TMP/writes-snap.txt"; then
    note "refused by write-policy.ts:"
    grep '^RULE ' "$TMP/writes-snap.txt" | sed 's/^RULE //' | sort -rn \
      | while read -r n r; do note "$(printf '%4d  %s' "$n" "$r")"; done
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# RULE 5 — fixtures are registered.
#
# `defineFixture` registers with the module-level `fixtureRegistry` only when
# the module is actually LOADED. A fixture module nothing imports registers
# nothing: it is absent from GET /api/__mock/state, `resetAll` skips it, and no
# auditor can switch it to `empty`. So: walk the import graph from src/index.ts
# and require every fixture module to be reachable, every key to be unique, and
# no production fixture to opt out with `registry:`.
section "rule 5 — fixtures are registered"
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
  let m;
  const text = readFileSync(abs, 'utf8');
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
node "$TMP/reach.mjs" "$MW" > "$TMP/reach.txt"
: > "$TMP/fixtures.txt"; : > "$TMP/orphans.txt"; : > "$TMP/optout.txt"
for f in $(mock_sources) $(provider_sources); do
  n=$(grep -cE 'defineFixture[<(]' "$f" || true)
  [ "${n:-0}" -gt 0 ] || continue
  src=${f#$MW/}
  grep -qxF "$src" "$TMP/reach.txt" || printf '%s (%s fixture(s))\n' "$(rel "$f")" "$n" >> "$TMP/orphans.txt"
  # The key on the line after `defineFixture<T>({`
  grep -A2 -E 'defineFixture[<(]' "$f" | grep -oE "key: '[^']+'" | sed -E "s/key: '(.*)'/\1/" >> "$TMP/fixtures.txt"
  grep -nE '^[[:space:]]*registry:' "$f" | sed "s|^|$(rel "$f"):|" >> "$TMP/optout.txt" || true
done
n_fx=$(wc -l < "$TMP/fixtures.txt" | tr -d ' ')
n_uniq=$(sort -u "$TMP/fixtures.txt" | wc -l | tr -d ' ')
n_orph=$(wc -l < "$TMP/orphans.txt" | tr -d ' ')
n_opt=$(wc -l < "$TMP/optout.txt" | tr -d ' ')
if [ "$n_fx" -gt 0 ]; then ok "$n_fx fixtures defined ($n_uniq distinct keys)"; else
  fail "no fixtures defined — GET /api/__mock/state would report registryLoaded:false and the control plane could reset nothing"
fi
[ "$n_fx" = "$n_uniq" ] && ok "fixture keys unique" || {
  fail "duplicate fixture key(s) — defineFixture throws at import"
  sort "$TMP/fixtures.txt" | uniq -d | while read -r k; do note "$k"; done
}
if [ "$n_orph" = 0 ]; then ok "every fixture module is reachable from src/index.ts"; else
  fail "$n_orph fixture module(s) unreachable from src/index.ts — they register nothing, so /api/__mock/state cannot list or reset them"
  while IFS= read -r l; do note "$l"; done < "$TMP/orphans.txt"
fi
[ "$n_opt" = 0 ] && ok "no production fixture opts out of the shared registry" || {
  fail "$n_opt production fixture(s) pass \`registry:\` — only tests may use an isolated registry"
  while IFS= read -r l; do note "$l"; done < "$TMP/optout.txt"
}

# ─────────────────────────────────────────────────────────────────────────────
# RULE 6 — the wire snapshots are current.
#
# routes.json must equal the live router table (exact, cheap: the TS parser in
# mock/core/wire/routes.ts, no server). wire.json must cover exactly the GET
# routes in that table. And wire.json must be NEWER than the handler sources it
# claims to describe — a capture taken before a provider changed is a snapshot
# of a server that no longer exists, and rule 4 above believes it.
section "rule 6 — the wire snapshots are current"
ROUTES_JSON="$MW/src/mock/core/wire/snapshots/routes.json"
: > "$TMP/snap-routes.txt"
if [ -f "$ROUTES_JSON" ]; then
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const x of r.routes) console.log(`${x.method} ${x.path}`);
  ' "$ROUTES_JSON" | sort -u > "$TMP/snap-routes.txt"
else
  fail "route snapshot missing: $(rel "$ROUTES_JSON")"
fi
# The enumerator resolves `middleware/` by walking up from cwd, so it has to
# run with cwd=middleware; the scratch module therefore lives under middleware/
# and is removed on every path out.
mkdir -p "$MW/.mock-floor-tmp"
cat > "$MW/.mock-floor-tmp/enum.ts" <<'TSX'
import { enumerateRoutes, routeKey } from '../src/mock/core/wire/routes.js';
const t = enumerateRoutes();
for (const r of t.routes) console.log(routeKey(r));
for (const u of t.unresolved) console.log(`UNRESOLVED ${u.reason} (${u.source})`);
TSX
if (cd "$MW" && node node_modules/.bin/tsx .mock-floor-tmp/enum.ts > "$TMP/live.txt" 2>"$TMP/enum.err"); then
  rm -rf "$MW/.mock-floor-tmp"
  grep '^UNRESOLVED' "$TMP/live.txt" > "$TMP/unresolved.txt" || true
  grep -v '^UNRESOLVED' "$TMP/live.txt" | sort -u > "$TMP/live-routes.txt"
  added=$(comm -23 "$TMP/live-routes.txt" "$TMP/snap-routes.txt")
  gone=$(comm -13 "$TMP/live-routes.txt" "$TMP/snap-routes.txt")
  if [ -z "$added" ] && [ -z "$gone" ]; then
    ok "routes.json matches the live router table ($(wc -l < "$TMP/live-routes.txt" | tr -d ' ') routes)"
  else
    fail "routes.json is stale — regenerate"
    [ -n "$added" ] && printf '%s\n' "$added" | head -10 | while read -r l; do note "+ $l (mounted, not captured)"; done
    [ -n "$gone" ] && printf '%s\n' "$gone" | head -10 | while read -r l; do note "- $l (captured, no longer mounted)"; done
  fi
  n_unres=$(wc -l < "$TMP/unresolved.txt" | tr -d ' ')
  [ "$n_unres" = 0 ] && ok "no unresolved (non-literal) mounts" || {
    fail "$n_unres mount(s) the enumerator cannot resolve — the surface is bigger than the snapshot can see"
    while IFS= read -r l; do note "$l"; done < "$TMP/unresolved.txt"
  }
else
  rm -rf "$MW/.mock-floor-tmp"
  fail "could not enumerate the live router table"
  head -5 "$TMP/enum.err" | while read -r l; do note "$l"; done
fi
if [ -f "$WIRE" ]; then
  node -e '
    const fs = require("fs");
    for (const k of Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).routes)) console.log(k);
  ' "$WIRE" | sort -u > "$TMP/wire-routes.txt"
  grep '^GET ' "$TMP/snap-routes.txt" | sort -u > "$TMP/snap-gets.txt"
  missing=$(comm -23 "$TMP/snap-gets.txt" "$TMP/wire-routes.txt")
  if [ -z "$missing" ]; then ok "wire.json covers every GET route ($(wc -l < "$TMP/wire-routes.txt" | tr -d ' '))"; else
    fail "wire.json is missing $(printf '%s\n' "$missing" | wc -l | tr -d ' ') GET route(s) — recapture"
    printf '%s\n' "$missing" | head -10 | while read -r l; do note "$l"; done
  fi
  # Freshness is a CONTENT question, not a time one. It used to be
  # `find -newer wire.json`, and a real capture fell through that: a sweep run
  # at 22:27 recorded responses from a server booted at 02:24, before a route
  # change, so the snapshot FILE was newer than the source it disagreed with
  # and the check passed over a stale shape. The server now hashes the handler
  # sources it booted from and the capture records that digest, so a sweep
  # against a stale process is caught however new the file is.
  snapsha_check "$WIRE" wire.json
fi
# The write snapshot rots the same way and for the same reason: it is a record
# of what handlers sent back, and rule 2 above believes it.
if [ -f "$WRITES" ]; then
  snapsha_check "$WRITES" writes.json
fi

# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${#FAILS[@]}" = 0 ]; then
  if [ "$STATIC_ONLY" = 1 ]; then
    echo "SOURCE/SNAPSHOT CHECKS PASS — compilation and tests were not run."
  else
    echo "ALL CHECKS PASS — the mock floor meets its definition of done."
  fi
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
