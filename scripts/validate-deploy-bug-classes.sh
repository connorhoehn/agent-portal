#!/usr/bin/env bash
# Lint for the three bug classes the first live deploy hit. None needs AWS.
#   1. partial secret ARNs      infra/test/secret-arns.test.ts
#   2. uuid binds as text       scripts/check-uuid-binds.mjs (+ jest cases), native harness typing
#   3. second CommonJS editor   portal/scripts/check-bundle-singletons.mjs after a sourcemap build
# --quick skips the portal build (the slow step); run the full form before
# any `node scripts/portal-publish.mjs`.
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
run()  { # run <label> <cmd...>: quiet on success, tail of the output on failure
  local label="$1"; shift
  local out; out=$("$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ]; then ok "$label"; else fail "$label"; printf '%s\n' "$out" | tail -25 | sed 's/^/      /'; fi
}

echo "1. partial secret ARNs"
run "infra: no stack renders a partial secret ARN; fromSecretNameV2 names are safe" \
  bash -c "cd '$REPO/infra' && node --require ts-node/register --test test/secret-arns.test.ts"
if grep -n "fromSecretNameV2" "$REPO/infra/lib/middleware-service-stack.ts" | grep -v "^\s*$" >/dev/null; then
  fail "infra/lib/middleware-service-stack.ts still mentions fromSecretNameV2 (stale doc comment)"
  grep -n "fromSecretNameV2" "$REPO/infra/lib/middleware-service-stack.ts" | sed 's/^/      /'
else
  ok "no stale fromSecretNameV2 doc comment in middleware-service-stack.ts"
fi

echo "2. uuid binds as text"
run "check-uuid-binds.mjs over middleware/src" node "$REPO/scripts/check-uuid-binds.mjs"
run "jest: uuid-bind fixtures and native harness typing" \
  bash -c "cd '$REPO/middleware' && npx jest src/providers/__tests__/document-uuid-binds.test.ts src/providers/__tests__/native-rds-binding.test.ts"

echo "3. second CommonJS editor stack"
run "bundle-singleton checker fixtures" bash -c "cd '$REPO/portal' && node --test src/__tests__/bundleSingletons.test.ts"
if [ $QUICK -eq 1 ]; then
  note "--quick: portal build skipped"
else
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
  run "vite build --sourcemap" bash -c "cd '$REPO/portal' && npx vite build --sourcemap --outDir '$OUT/dist' --emptyOutDir"
  run "built bundle holds one ESM instance of each singleton" node "$REPO/portal/scripts/check-bundle-singletons.mjs" --dist "$OUT/dist"
fi

echo
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL PASS"; exit 0; fi
echo "${#FAILS[@]} failing"; exit 1
