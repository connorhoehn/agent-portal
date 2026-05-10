#!/usr/bin/env bash
# pre-destroy.sh — drain resources that block `cdk destroy --all`
# Run this before `npx cdk destroy --all --force`
#
# Blockers:
#   - BedrockAgentCore PolicyEngine cannot be deleted while it still contains policies
#   - Gateways/targets with live policies block in the same way
#
# Usage: ./scripts/pre-destroy.sh [prefix]

set -euo pipefail

PREFIX="${1:-orgiq}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo "==> Pre-destroy cleanup for prefix='${PREFIX}' in ${REGION} / ${ACCOUNT}"

# -------------------------------------------------------------------
# 1. Find all policy engines that match our prefix
# -------------------------------------------------------------------
echo ""
echo "--- Draining Cedar policies from policy engines ---"

ENGINES=$(aws bedrock-agentcore-control list-policy-engines \
  --query "items[?starts_with(name, '${PREFIX}_')].policyEngineId" \
  --output text 2>/dev/null || true)

if [ -z "$ENGINES" ]; then
  echo "  No policy engines found for prefix '${PREFIX}'"
else
  for ENGINE_ID in $ENGINES; do
    echo "  Engine: ${ENGINE_ID}"

    POLICIES=$(aws bedrock-agentcore-control list-policies \
      --policy-engine-id "$ENGINE_ID" \
      --query 'policies[*].policyId' \
      --output text 2>/dev/null || true)

    if [ -z "$POLICIES" ]; then
      echo "    No policies found"
    else
      for POLICY_ID in $POLICIES; do
        echo "    Deleting policy: ${POLICY_ID}"
        aws bedrock-agentcore-control delete-policy \
          --policy-engine-id "$ENGINE_ID" \
          --policy-id "$POLICY_ID" \
          --query 'status' --output text 2>/dev/null || true
      done

      echo "    Waiting for policy deletions to propagate..."
      for i in $(seq 1 10); do
        REMAINING=$(aws bedrock-agentcore-control list-policies \
          --policy-engine-id "$ENGINE_ID" \
          --query 'length(policies)' \
          --output text 2>/dev/null || echo "0")
        if [ "$REMAINING" = "0" ] || [ "$REMAINING" = "None" ]; then
          echo "    All policies deleted"
          break
        fi
        echo "    Still ${REMAINING} policies remaining, waiting 3s..."
        sleep 3
      done
    fi
  done
fi

# -------------------------------------------------------------------
# 2. Delete any orphan (non-CFN-managed) gateways for this prefix
# -------------------------------------------------------------------
echo ""
echo "--- Cleaning up orphan gateways ---"

GATEWAYS=$(aws bedrock-agentcore-control list-gateways \
  --query "items[?starts_with(name, '${PREFIX}') && !contains(name, 'mcp-gateway')].gatewayId" \
  --output text 2>/dev/null || true)

if [ -z "$GATEWAYS" ]; then
  echo "  No orphan gateways found"
else
  for GW_ID in $GATEWAYS; do
    echo "  Deleting gateway: ${GW_ID}"
    aws bedrock-agentcore-control delete-gateway --gateway-identifier "$GW_ID" \
      --query 'status' --output text 2>/dev/null || true
  done
fi

echo ""
echo "==> Pre-destroy cleanup complete. Safe to run: npx cdk destroy --all --force"
