#!/bin/zsh
# usage: run_profile.sh <profile> <label> [frames|metrics]
# Fresh owned compiled BFFs, fresh identity manifest, then the unchanged
# declared load profile. "frames" adds count/timing-only frame-pipeline
# diagnostics (histograms reset by SIGUSR2 after preparation).
set -u
cd /Users/connorhoehn/Projects/aws-agentcore/middleware
export DOCKER_HOST=unix:///tmp/orgiq-capacity-docker.sock ORGIQ_BFF_RUNTIME_ENV_FILE=/tmp/orgiq-owned-bff-runtime-env.json
export ORGIQ_BFF_CONTAINER_IMAGE=${ORGIQ_BFF_CONTAINER_IMAGE:-orgiq-middleware:cluster-0109-validation}
E=../docs/realtime-validation/2026-10-06/capacity-sizing
P=$1; L=$2; M=${3:-}
unset ORGIQ_BFF_CONTAINER_STORE_METRICS ORGIQ_BFF_CONTAINER_METRICS_MODE
if [ "$M" = metrics ]; then export ORGIQ_BFF_CONTAINER_STORE_METRICS=1; fi
if [ "$M" = frames ]; then export ORGIQ_BFF_CONTAINER_STORE_METRICS=1 ORGIQ_BFF_CONTAINER_METRICS_MODE=frames; fi
echo "image=$ORGIQ_BFF_CONTAINER_IMAGE $(docker image inspect $ORGIQ_BFF_CONTAINER_IMAGE --format '{{.Id}}') mode=${M:-plain}" > $E/$L-containers.log
ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 test-support/bff-cluster-containers.py >> $E/$L-containers.log 2>&1 || { cat $E/$L-containers.log; exit 2; }
sleep 3
ORGIQ_BFF_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CONTAINER_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CAPACITY_PREPARE_ONLY=1 node test-support/bff-cluster-capacity.mjs > $E/$L-prepare.log 2>&1 || { cat $E/$L-prepare.log; exit 2; }
if [ -n "$M" ]; then for n in a b; do docker kill -s USR2 orgiq-bff-capacity-$n >/dev/null; done; sleep 0.5; fi
STATS=$E/$L-docker-stats.csv; : > $STATS
( while true; do docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" orgiq-bff-capacity-a orgiq-bff-capacity-b orgiq-bff-cluster-dynamodb orgiq-bff-cluster-redis orgiq-bff-cluster-postgres 2>/dev/null | sed "s/^/$(date +%s),/" >> $STATS; sleep 1; done ) &
SAMPLER=$!
ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 test-support/bff-cluster-container-load.py $P > $E/$L-driver.log 2>&1
CODE=$?
kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
echo "exit=$CODE" >> $E/$L-driver.log
if [ -n "$M" ]; then sleep 6; for n in a b; do docker cp orgiq-bff-capacity-$n:/tmp/orgiq-bff-cluster-$n-native-metrics.json $E/$L-$n-metrics.json >/dev/null 2>&1; done; fi
# Host refusal lines only (kind, channel family, whether a user context existed);
# synthetic subject ids are replaced, nothing else from the logs is kept.
for n in a b; do docker logs -t orgiq-bff-capacity-$n 2>&1 | grep -E "refused|CallService|authorize (threw|rejected)|identity store|Redis connection error|realtime-cluster" | sed -E "s/u-container-load-[0-9]+/U/g; s/'social:dm:U:U'/'social:dm'/g" > $E/$L-$n-refusals.log; done
[ -f /tmp/orgiq-bff-container-internal-$P.json ] && cp /tmp/orgiq-bff-container-internal-$P.json $E/$L-result.json && rm /tmp/orgiq-bff-container-internal-$P.json
python3 $E/retire_drivers.py $E/retired-drivers >/dev/null
echo "$L exit=$CODE"; grep -E "p50 .* p95|^  FAIL|errors:" $E/$L-driver.log
