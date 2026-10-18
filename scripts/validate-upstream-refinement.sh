#!/usr/bin/env bash
# The judge for docs/upstream-refinement-goal.md — the realtime chain under
# this app (distributed-core → service-runtime/event-catalog/message-queue →
# realtime-modules → platform-api/realtime-examples/live-video-streaming → aws-agentcore).
# Exits 0 only when every check passes; prints every failing line.
#
#   ./scripts/validate-upstream-refinement.sh --quick   # static checks only
#   ./scripts/validate-upstream-refinement.sh           # + each repo's tests and typecheck (long; run alone)
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
P=${UPSTREAM_PROJECTS:-$HOME/Projects}
DC=$P/distributed-core RM=$P/realtime-modules RX=$P/realtime-examples
MQ=$P/message-queue SR=$P/service-runtime EC=$P/event-catalog PA=$P/platform-api
LV=$P/live-video-streaming

QUICK=0
for arg in "$@"; do case "$arg" in --quick) QUICK=1 ;; esac; done

FAILS=()
fail() { FAILS+=("$1"); printf '  ✗ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else fail "$2"; fi; }
absent() { if [ -e "$1" ]; then fail "$2 — $1 still exists"; else ok "$2"; fi; }
none() { # pattern, path(s)..., label
  local pat=$1 label=${@: -1}; local paths=("${@:2:$#-2}")
  local n; n=$(grep -rEn -- "$pat" "${paths[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = 0 ]; then ok "$label"; else fail "$label — $n hits"; fi
}
version() { node -p "require(require('path').resolve('$1','package.json')).version" 2>/dev/null; }
vge() { # version >= min
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}process.exit(0)' "$1" "$2"
}
depspec() { # repo dep-name → spec from deps/devDeps/peerDeps
  node -p "const p=require(require('path').resolve('$1','package.json'));({...p.peerDependencies,...p.devDependencies,...p.dependencies})['$2']||''" 2>/dev/null
}
contains_tag() { # repo spec tag → the spec's sha is a full sha that contains tag
  local repo=$1 spec=$2 tag=$3 sha=${2##*#}
  [ ${#sha} -eq 40 ] || return 1
  local tagsha; tagsha=$(git -C "$repo" rev-list -n1 "$tag" 2>/dev/null) || return 1
  git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin "$sha" 2>/dev/null || return 1
  git -C "$repo" merge-base --is-ancestor "$tagsha" "$sha"
}
dc_pin_ok() { local s; s=$(depspec "$1" distributed-core); contains_tag "$DC" "$s" v0.48.0; }
lane_logged() { grep -qE "\(lane $2\)" "$1/CHANGELOG.md" 2>/dev/null; }

section "goal exists"
check "[ -f docs/upstream-refinement-goal.md ]" "goal doc"
check "[ -f docs/upstream-refinement-plan-2026-10-14.md ]" "plan doc"
check "grep -q 'validate-upstream-refinement.sh' CLAUDE.md" "CLAUDE.md docs map names the judge"

section "U0 · one distributed-core"
check "vge '$(version "$SR")' 0.4.1"  "S1 service-runtime ≥ 0.4.1 ($(version "$SR"))"
check "dc_pin_ok '$SR'"               "S1 service-runtime pins distributed-core ⊇ v0.48.0 at a full sha"
check "vge '$(version "$EC")' 0.8.5"  "S1 event-catalog ≥ 0.8.5 ($(version "$EC"))"
check "dc_pin_ok '$EC'"               "S1 event-catalog pins distributed-core ⊇ v0.48.0 at a full sha"
check "vge '$(version "$MQ")' 0.2.3"  "M1 message-queue ≥ 0.2.3 ($(version "$MQ"))"
check "dc_pin_ok '$MQ'"               "M1 message-queue pins distributed-core ⊇ v0.48.0 at a full sha"
check "vge '$(version "$DC")' 0.49.0" "D3 distributed-core ≥ 0.49.0 ($(version "$DC"))"
check "grep -q '@deprecated' '$DC/src/pipeline.ts'" "D3 ./pipeline is deprecated"
check "lane_logged '$DC' D3"          "D3 CHANGELOG entry (lane D3)"
check "dc_pin_ok '$RM'"               "realtime-modules pins distributed-core ⊇ v0.48.0"
check "dc_pin_ok middleware"          "middleware pins distributed-core ⊇ v0.48.0"
SRPIN=$(depspec middleware @connorhoehn/service-runtime)
check "[ \"\${SRPIN##*#}\" != 7a0e3387 ] && contains_tag '$SR' '$SRPIN' v0.4.1" "S1 middleware service-runtime pin ⊇ v0.4.1 at a full sha"
NDC=$(find -H middleware/node_modules -path '*/distributed-core/package.json' -not -path '*/distributed-core/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
check "[ '$NDC' = 1 ]" "middleware installs exactly one distributed-core ($NDC)"
check "! grep -q 'distributed-core/' middleware/tsconfig.test.json" "middleware tsconfig.test.json has no distributed-core paths workaround"

section "U1 · realtime-modules owns its seams"
none 'as unknown as|as any' middleware/src/lib/realtime-gateway.ts "R4 no casts into the library in realtime-gateway.ts"
none 'channelMembers' middleware/src/lib "R4 host never reads the router's private channelMembers"
none 'activeCalls' middleware/src/lib/gateway/stats.ts "R4 stats come from handle.stats(), not activeCalls"
check "lane_logged '$RM' R4" "R4 CHANGELOG entry (lane R4)"
check "grep -rq 'replayOnConnect' '$RM/src'" "R5 notifications({ replayOnConnect })"
check "grep -rqE 'currentReaders|unread:' '$RM/src/server'" "R5 chat owns the reader-cursor unread model"
check "lane_logged '$RM' R5" "R5 CHANGELOG entry (lane R5)"
check "node -e \"process.exit(require('$RM/package.json').exports['./testing']?0:1)\"" "R7 ./testing subpath exported"
check "grep -rq 'createRowsChatBackend' '$RM/src/testing'" "R7 /testing ships createRowsChatBackend"
check "node -e \"process.exit(require('$RM/package.json').scripts.lint?0:1)\"" "R7 lint script"
check "lane_logged '$RM' R7" "R7 CHANGELOG entry (lane R7)"

section "U2 · capacity"
check "grep -rq 'inboundRateLimit' '$RM/src'" "R6 attachRealtime({ inboundRateLimit })"
check "grep -rqE 'queueDepth' '$RM/src'" "R6 stats() exposes queue depth"
check "lane_logged '$RM' R6" "R6 CHANGELOG entry (lane R6)"
CAP=$(ls -t docs/realtime-validation/2026-1[0-2]-*/capacity-*.md 2>/dev/null | xargs grep -l 'member queries per send' 2>/dev/null | xargs grep -l 'lane R6' 2>/dev/null | head -1)
check "[ -n '$CAP' ]" "R6 dated local capacity record (lane R6) ${CAP:-none}"

section "U3 · apps on the chain"
check "contains_tag '$RM' '$(depspec "$PA" @connorhoehn/realtime-modules)' v0.117.0" "P1 platform-api pins realtime-modules ⊇ v0.117.0"
check "dc_pin_ok '$PA'" "P1 platform-api pins distributed-core ⊇ v0.48.0"
check "grep -rlE 'FencedLease|RedisSemaphore' '$PA/src' | grep -qiE 'schedul'" "P1 schedule evaluator single-flight under a lease/semaphore"
check "lane_logged '$PA' P1 || grep -rq '(lane P1)' '$PA/docs' " "P1 change logged (lane P1)"
check "ls '$PA'/docs/soak*/*.md 2>/dev/null | xargs grep -l 'verdict: pass' | grep -q ." "P1 local soak record with a flat heap (verdict: pass)"
check "node -p \"require('$RX/cdk/package.json').name\" | grep -qx '@connorhoehn/realtime-examples-cdk'" "X1 @connorhoehn/realtime-examples-cdk package"
check "[ -n \"$(depspec infra @connorhoehn/realtime-examples-cdk)\" ] && [ -z \"$(depspec infra realtime-examples)\" ]" "X1 infra consumes the CDK package, not the whole app"

section "U4 · the consumer"
check "[ -n \"$(depspec middleware @connorhoehn/realtime-modules)\" ] && [ -n \"$(depspec portal @connorhoehn/realtime-modules)\" ]" "C2 both install @connorhoehn/realtime-modules"
none '@connorhoehnslalom/realtime-modules' portal/src middleware/src portal/vite.config.ts portal/tsconfig.json middleware/tsconfig.json "C2 no slalom-scoped realtime-modules imports, alias or paths"
RMM=$(depspec middleware @connorhoehn/realtime-modules); RMP=$(depspec portal @connorhoehn/realtime-modules)
check "[ -n '$RMM' ] && [ \"\${RMM##*/}\" = \"\${RMP##*/}\" ]" "C3 portal and middleware install the same realtime-modules"
absent middleware/src/lib/gateway/authority-legacy.ts "C3 legacy authority guards deleted"
absent middleware/src/lib/gateway/authority-parity.ts "C3 dev parity assertion retired"
absent middleware/src/lib/realtime-node-ownership.ts "C3 node ownership → library leaseGroup"
absent middleware/src/lib/gateway-redis.ts "C3 gateway Redis → createBoundedRedis"
absent middleware/src/lib/redis-lite.ts "C1 hand-written Redis client deleted"
check "grep -qE 'verifyServiceRequest|verifyEnvelope' middleware/src/lib/service-auth.ts" "C4 machine callbacks verify signed envelopes"

section "U5 · the SFU on the chain"
check "dc_pin_ok '$LV'" "V1 live-video-streaming pins distributed-core ⊇ v0.48.0 at a full sha"
absent "$LV/src/cluster/RedisLeaseStore.js" "V1 hand-rolled lease store replaced by the fenced lease"
check "grep -rqE 'FencedLease|fencedLease|createFencedLease' '$LV/src/cluster'" "V1 room ownership uses the library's fenced lease"
check "ls '$LV'/test/*.test.js 2>/dev/null | xargs grep -liE 'fenced' 2>/dev/null | xargs grep -lE 'kill|crash|failover' 2>/dev/null | xargs grep -lE 'pipe' 2>/dev/null | grep -q ." "V1 multi-node test: owner killed, ownership moves, pipes rebuilt"
check "lane_logged '$LV' V1 || grep -rq '(lane V1)' '$LV/docs'" "V1 change logged (lane V1)"

if [ "$QUICK" = 0 ]; then
  section "suites (each repo, run alone)"
  SUITE_LOGS=${UPSTREAM_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/orgiq-upstream-refinement.XXXXXX")}
  mkdir -p "$SUITE_LOGS" || exit 2
  printf 'Suite logs: %s\n' "$SUITE_LOGS"
  # These suites are expensive. Preserve their evidence and failure details
  # so diagnosing a failed gate never requires repeating a completed run.
  check_logged() {
    local log="$SUITE_LOGS/$3.log"
    if eval "$1" >"$log" 2>&1; then ok "$2"; else
      fail "$2 ($log)"
      tail -n 20 "$log"
    fi
  }
  for r in "$DC" "$SR" "$EC" "$MQ" "$RM" "$PA" "$RX" "$LV"; do
    n=$(basename "$r")
    check_logged "(cd '$r' && npm test --silent)" "$n tests" "$n-tests"
    check_logged "(cd '$r' && (npm run -s typecheck 2>/dev/null || npx tsc --noEmit -p .))" "$n typecheck" "$n-typecheck"
  done
  check_logged "(cd middleware && npm run -s typecheck)" "middleware typecheck" "middleware-typecheck"
  check_logged "(cd middleware && npx jest src/lib/gateway/__tests__/authority-facade.test.ts)" "consumer authority facade contract" "authority-facade"
  check_logged "./scripts/validate-communication-plane.sh --quick" "communication plane (quick)" "communication-plane-quick"
  check_logged "./scripts/validate-social-tenant.sh --quick" "social tenant (quick)" "social-tenant-quick"
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
echo "${#FAILS[@]} check(s) failing"; exit 1
