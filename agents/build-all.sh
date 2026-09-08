#!/usr/bin/env bash
# Build + push all OrgIQ agent images in parallel.
#
# Prerequisite: agents/base/build.sh has been run once so orgiq-agent-base:latest
# exists in ECR. Per-agent builds extend that base, so each is just a COPY layer.
#
# Usage:
#   ./agents/build-all.sh                              # all agents
#   ./agents/build-all.sh supervisor search            # only listed
#   AGENTS="supervisor search" ./agents/build-all.sh   # via env
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
BASE="${ECR_HOST}/orgiq-agent-base:latest"

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# Resolve agent list from args, env, or default to every agent.
if [ "$#" -gt 0 ]; then
  AGENTS=("$@")
elif [ -n "${AGENTS:-}" ]; then
  read -ra AGENTS <<< "$AGENTS"
else
  AGENTS=(supervisor search scoring advisor ingestion graph-builder assessment-scorer assessment-drafter)
fi

echo "Logging in to ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_HOST" 2>&1 | tail -1

echo "Building ${#AGENTS[@]} agent(s) in parallel: ${AGENTS[*]}"
echo ""

pids=()
fails=()

build_one() {
  local agent="$1"
  local uri="${ECR_HOST}/orgiq-${agent}:latest"
  local log="/tmp/orgiq-build-${agent}.log"

  if ! docker buildx build \
        --platform linux/arm64 \
        --provenance=false \
        --build-arg "BASE_IMAGE=${BASE}" \
        --build-arg "AGENT_NAME=${agent}" \
        -f "${ROOT}/agents/Dockerfile.agent" \
        --push \
        -t "$uri" \
        "${ROOT}/agents/" > "$log" 2>&1; then
    echo "❌ $agent FAILED — see $log"
    return 1
  fi
  echo "✅ $agent pushed → $uri"
}

for agent in "${AGENTS[@]}"; do
  build_one "$agent" &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fails+=("$pid")
  fi
done

echo ""
if [ "${#fails[@]}" -gt 0 ]; then
  echo "FAILED: ${#fails[@]} build(s). Check logs in /tmp/orgiq-build-*.log"
  exit 1
fi

echo "All ${#AGENTS[@]} agent images pushed successfully."
