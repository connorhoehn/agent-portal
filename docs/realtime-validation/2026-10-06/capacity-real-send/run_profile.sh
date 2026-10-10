#!/bin/zsh
# usage: run_profile.sh <profile> <label> [metrics]
# Fresh owned compiled BFFs (optionally with count/timing-only store + stage
# metrics), fresh identity manifest, then the unchanged declared load profile.
set -u
cd /Users/connorhoehn/Projects/aws-agentcore/middleware
export DOCKER_HOST=unix:///tmp/orgiq-capacity-docker.sock ORGIQ_BFF_RUNTIME_ENV_FILE=/tmp/orgiq-owned-bff-runtime-env.json
export ORGIQ_BFF_CONTAINER_IMAGE=${ORGIQ_BFF_CONTAINER_IMAGE:-orgiq-middleware:cluster-plugin-scope-validation}
E=../docs/realtime-validation/2026-10-06/capacity-real-send
P=$1; L=$2; M=${3:-}
if [ "$M" = metrics ]; then export ORGIQ_BFF_CONTAINER_STORE_METRICS=1; else unset ORGIQ_BFF_CONTAINER_STORE_METRICS; fi
ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 test-support/bff-cluster-containers.py > $E/$L-containers.log 2>&1 || { cat $E/$L-containers.log; exit 2; }
sleep 3
ORGIQ_BFF_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CONTAINER_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CAPACITY_PREPARE_ONLY=1 node test-support/bff-cluster-capacity.mjs > $E/$L-prepare.log 2>&1 || { cat $E/$L-prepare.log; exit 2; }
if [ "$M" = metrics ]; then for n in a b; do docker cp orgiq-bff-capacity-$n:/tmp/orgiq-bff-cluster-$n-native-metrics.json $E/$L-$n-metrics-before.json >/dev/null 2>&1; done; fi
STATS=$E/$L-docker-stats.csv; : > $STATS
( while true; do docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" orgiq-bff-capacity-a orgiq-bff-capacity-b orgiq-bff-cluster-dynamodb orgiq-bff-cluster-redis orgiq-bff-cluster-postgres 2>/dev/null | sed "s/^/$(date +%s),/" >> $STATS; sleep 1; done ) &
SAMPLER=$!
ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 test-support/bff-cluster-container-load.py $P > $E/$L-driver.log 2>&1
CODE=$?
kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
echo "exit=$CODE" >> $E/$L-driver.log
if [ "$M" = metrics ]; then sleep 6; for n in a b; do docker cp orgiq-bff-capacity-$n:/tmp/orgiq-bff-cluster-$n-native-metrics.json $E/$L-$n-metrics-after.json >/dev/null 2>&1; done; fi
[ -f /tmp/orgiq-bff-container-internal-$P.json ] && cp /tmp/orgiq-bff-container-internal-$P.json $E/$L-result.json && rm /tmp/orgiq-bff-container-internal-$P.json
python3 $E/retire_drivers.py $E/retired-drivers >/dev/null
echo "$L exit=$CODE"; grep -E "p50 .* p95|^  FAIL" $E/$L-driver.log
