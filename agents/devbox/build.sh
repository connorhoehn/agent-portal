#!/usr/bin/env bash
# Build + push orgiq-devbox to ECR (ARM64). Standalone — NOT part of
# agents/build-all.sh (different dependency profile: Node + Claude Code,
# no Strands/AG-UI, doesn't extend orgiq-agent-base).
#
# ⚠️  Every push + `deploy.sh OrgIQ-Devbox --context deployDevbox=true` rolls
#     the runtime version and WIPES all session workspaces (/mnt/workspace).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REPO="orgiq-devbox"
TAG="${TAG:-latest}"
URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

cd "$(dirname "$0")"

echo "Logging in to ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "Building + pushing $URI (linux/arm64)..."
docker buildx build \
  --platform linux/arm64 \
  --provenance=false \
  --build-context shared=../_shared \
  --push \
  -t "$URI" \
  .

echo ""
echo "Devbox image pushed: $URI"
echo "Now run: cd infra && ./scripts/deploy.sh OrgIQ-Devbox --context deployDevbox=true"
