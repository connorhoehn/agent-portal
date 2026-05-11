#!/usr/bin/env bash
# Build + push orgiq-agent-base to ECR (ARM64). Run once when common deps change.
# Subsequent per-agent rebuilds extend this image and finish in <10s.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REPO="orgiq-agent-base"
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
  --push \
  -t "$URI" \
  .

echo ""
echo "Base image pushed: $URI"
echo "Now run: agents/build-all.sh"
