#!/bin/zsh
# usage: run_profile.sh <profile> <label>
set -u
cd /Users/connorhoehn/Projects/aws-agentcore
export DOCKER_HOST=unix:///tmp/orgiq-capacity-docker.sock ORGIQ_BFF_RUNTIME_ENV_FILE=/tmp/orgiq-owned-bff-runtime-env.json
E=docs/realtime-validation/2026-10-05/capacity-authority-scope
P=$1; L=$2
STATS=$E/$L-docker-stats.csv; : > $STATS
( while true; do docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" orgiq-bff-capacity-a orgiq-bff-capacity-b orgiq-bff-cluster-dynamodb orgiq-bff-cluster-redis orgiq-bff-cluster-postgres 2>/dev/null | sed "s/^/$(date +%s),/" >> $STATS; sleep 1; done ) &
SAMPLER=$!
ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 middleware/test-support/bff-cluster-container-load.py $P > $E/$L-driver.log 2>&1
CODE=$?
kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
echo "exit=$CODE" >> $E/$L-driver.log
[ -f /tmp/orgiq-bff-container-internal-$P.json ] && cp /tmp/orgiq-bff-container-internal-$P.json $E/$L-result.json && rm /tmp/orgiq-bff-container-internal-$P.json
python3 /private/tmp/claude-501/-Users-connorhoehn-Projects-aws-agentcore/7aad70e9-0960-4a75-a575-96e73121111d/scratchpad/retire_drivers.py $E/retired-drivers >/dev/null
echo "$L exit=$CODE"; grep -E "p50 .* p95|^  FAIL" $E/$L-driver.log
