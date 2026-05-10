#!/usr/bin/env bash
# destroy.sh — safe wrapper around `cdk destroy --all`
#
# Drains resources that cause DELETE_FAILED before CloudFormation teardown:
#   - Cedar policies (block PolicyEngine deletion)
#   - Orphan gateways (not CFN-managed)
#   - Secrets scheduled for deletion (block re-deploy after quick redeploy)
#
# Usage:
#   ./scripts/destroy.sh              # destroy all stacks
#   PREFIX=myprefix ./scripts/destroy.sh

set -euo pipefail

PREFIX="${PREFIX:-orgiq}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  OrgIQ Destroy — ${REGION} / ${ACCOUNT}"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Prefix : ${PREFIX}"
echo "  Region : ${REGION}"
echo ""

# ──────────────────────────────────────────────────────────────────
# 1. Drain Cedar policies (block PolicyEngine deletion)
# ──────────────────────────────────────────────────────────────────
echo "── Draining Cedar policies ──"

ENGINES=$(aws bedrock-agentcore-control list-policy-engines \
  --query "items[?starts_with(name, '${PREFIX}')].policyEngineId" \
  --output text 2>/dev/null || true)

if [[ -z "$ENGINES" ]]; then
  echo "  No policy engines found"
else
  for ENGINE_ID in $ENGINES; do
    echo "  Engine: ${ENGINE_ID}"
    POLICIES=$(aws bedrock-agentcore-control list-policies \
      --policy-engine-id "$ENGINE_ID" \
      --query 'policies[*].policyId' \
      --output text 2>/dev/null || true)

    if [[ -z "$POLICIES" ]]; then
      echo "    No policies"
    else
      for POLICY_ID in $POLICIES; do
        echo "    Deleting policy: ${POLICY_ID}"
        aws bedrock-agentcore-control delete-policy \
          --policy-engine-id "$ENGINE_ID" \
          --policy-id "$POLICY_ID" > /dev/null 2>&1 || true
      done

      # Wait for propagation
      for i in $(seq 1 15); do
        REMAINING=$(aws bedrock-agentcore-control list-policies \
          --policy-engine-id "$ENGINE_ID" \
          --query 'length(policies)' \
          --output text 2>/dev/null || echo "0")
        [[ "$REMAINING" == "0" || "$REMAINING" == "None" ]] && break
        echo "    ${REMAINING} remaining, waiting 3s..."
        sleep 3
      done
      echo "    Policies drained"
    fi
  done
fi
echo ""

# ──────────────────────────────────────────────────────────────────
# 2. Delete orphan gateways (not managed by the CDK stack)
# ──────────────────────────────────────────────────────────────────
echo "── Cleaning up orphan gateways ──"

# List all gateways, filter to prefix, exclude the one CDK owns (mcp-gateway)
ALL_GATEWAYS=$(aws bedrock-agentcore-control list-gateways \
  --query "items[?starts_with(name, '${PREFIX}')].{id:gatewayId,name:name}" \
  --output json 2>/dev/null || echo "[]")

ORPHAN_COUNT=0
while IFS= read -r line; do
  GW_ID=$(echo "$line" | jq -r '.id')
  GW_NAME=$(echo "$line" | jq -r '.name')
  # Skip the gateway CDK owns (it will be destroyed by CFN)
  if aws cloudformation describe-stack-resource \
       --stack-name "OrgIQ-AgentCoreGateway" \
       --logical-resource-id "McpGateway" > /dev/null 2>&1; then
    CFN_GW_ID=$(aws cloudformation describe-stack-resource \
      --stack-name "OrgIQ-AgentCoreGateway" \
      --logical-resource-id "McpGateway" \
      --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null || echo "")
    [[ "$GW_ID" == "$CFN_GW_ID" ]] && continue
  fi
  echo "  Deleting orphan gateway: ${GW_NAME} (${GW_ID})"
  aws bedrock-agentcore-control delete-gateway --gateway-identifier "$GW_ID" > /dev/null 2>&1 || true
  ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
done < <(echo "$ALL_GATEWAYS" | jq -c '.[]' 2>/dev/null || true)

[[ $ORPHAN_COUNT -eq 0 ]] && echo "  No orphan gateways found"
echo ""

# ──────────────────────────────────────────────────────────────────
# 3. Cancel any Secrets Manager secrets in pending-deletion state
#    (they block re-deploy if another destroy happens within 7 days)
# ──────────────────────────────────────────────────────────────────
echo "── Restoring secrets scheduled for deletion ──"

PENDING_SECRETS=$(aws secretsmanager list-secrets \
  --include-planned-deletion \
  --query "SecretList[?starts_with(Name, '${PREFIX}') && DeletedDate != null].ARN" \
  --output text 2>/dev/null || true)

if [[ -z "$PENDING_SECRETS" ]]; then
  echo "  No secrets pending deletion"
else
  for SECRET_ARN in $PENDING_SECRETS; do
    echo "  Force-deleting secret: ${SECRET_ARN}"
    aws secretsmanager delete-secret \
      --secret-id "$SECRET_ARN" \
      --force-delete-without-recovery > /dev/null 2>&1 || true
  done
fi
echo ""

# ──────────────────────────────────────────────────────────────────
# 4. CDK destroy
# ──────────────────────────────────────────────────────────────────
echo "── Running cdk destroy --all ──"
echo ""

npx cdk destroy --all --force

echo ""
echo "✓ Destroy complete"
