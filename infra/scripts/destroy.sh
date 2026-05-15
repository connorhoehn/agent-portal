#!/usr/bin/env bash
# destroy.sh — safe wrapper around `cdk destroy --all`
#
# Drains resources that cause DELETE_FAILED before CloudFormation teardown:
#   - Cedar policies (block PolicyEngine deletion)
#   - Orphan gateways (not CFN-managed)
#   - Secrets scheduled for deletion (block re-deploy after quick redeploy)
#   - Bedrock KB data sources (can't delete if vector store unreachable)
#   - Aurora cluster/instances (AuroraFastDeleter custom resource is fragile)
#
# After cdk destroy, any stacks still in DELETE_FAILED are force-deleted by
# retaining their failed resources (orphaned AWS resources that are already gone).
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
# 4. Pre-drain Bedrock Knowledge Base
#    The KB data source can't be deleted when Aurora is stopped/unreachable.
#    Setting dataDeletionPolicy=RETAIN and pre-deleting avoids DELETE_FAILED.
# ──────────────────────────────────────────────────────────────────
echo "── Pre-draining Bedrock Knowledge Base ──"

KB_IDS=$(aws bedrock-agent list-knowledge-bases --region "$REGION" \
  --query "knowledgeBaseSummaries[?starts_with(name, '${PREFIX}')].knowledgeBaseId" \
  --output text 2>/dev/null || true)

if [[ -z "$KB_IDS" ]]; then
  echo "  No knowledge bases found"
else
  for KB_ID in $KB_IDS; do
    echo "  KB: ${KB_ID}"
    DS_IDS=$(aws bedrock-agent list-data-sources --knowledge-base-id "$KB_ID" \
      --region "$REGION" \
      --query 'dataSourceSummaries[*].dataSourceId' \
      --output text 2>/dev/null || true)

    for DS_ID in $DS_IDS; do
      DS_INFO=$(aws bedrock-agent get-data-source \
        --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
        --region "$REGION" 2>/dev/null || true)
      DS_NAME=$(echo "$DS_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dataSource']['name'])" 2>/dev/null || echo "data-source")
      DS_CFG=$(echo "$DS_INFO"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['dataSource']['dataSourceConfiguration']))" 2>/dev/null || echo "{}")
      VEC_CFG=$(echo "$DS_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['dataSource'].get('vectorIngestionConfiguration',{})))" 2>/dev/null || echo "{}")

      echo "    Setting data source ${DS_ID} to RETAIN policy..."
      aws bedrock-agent update-data-source \
        --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
        --name "$DS_NAME" \
        --data-source-configuration "$DS_CFG" \
        --vector-ingestion-configuration "$VEC_CFG" \
        --data-deletion-policy RETAIN \
        --region "$REGION" > /dev/null 2>&1 || true

      echo "    Deleting data source ${DS_ID}..."
      aws bedrock-agent delete-data-source \
        --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
        --region "$REGION" > /dev/null 2>&1 || true
    done

    # Wait for all data sources to be gone before deleting the KB
    for i in $(seq 1 20); do
      REMAINING=$(aws bedrock-agent list-data-sources --knowledge-base-id "$KB_ID" \
        --region "$REGION" --query 'length(dataSourceSummaries)' --output text 2>/dev/null || echo "0")
      [[ "$REMAINING" == "0" ]] && break
      echo "    ${REMAINING} data source(s) still deleting..."
      sleep 5
    done

    echo "  Deleting KB ${KB_ID}..."
    aws bedrock-agent delete-knowledge-base --knowledge-base-id "$KB_ID" \
      --region "$REGION" > /dev/null 2>&1 || true
  done
fi
echo ""

# ──────────────────────────────────────────────────────────────────
# 5. Pre-drain Aurora cluster
#    AuroraFastDeleter custom resource is fragile (fails if cluster is
#    stopped, or hits a physical-ID bug on re-deploy). Pre-deleting the
#    cluster here means CDK just sees it as already gone.
# ──────────────────────────────────────────────────────────────────
echo "── Pre-draining Aurora cluster ──"

CLUSTER_ID="${PREFIX}-aurora"

CLUSTER_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --region "$REGION" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "not-found")

if [[ "$CLUSTER_STATUS" == "not-found" || "$CLUSTER_STATUS" == "None" ]]; then
  echo "  No Aurora cluster found"
else
  echo "  Cluster status: ${CLUSTER_STATUS}"

  # Can't delete instances while cluster is stopped — start it first
  if [[ "$CLUSTER_STATUS" == "stopping" ]]; then
    echo "  Waiting for cluster to finish stopping..."
    for i in $(seq 1 24); do
      CLUSTER_STATUS=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" \
        --region "$REGION" --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "not-found")
      [[ "$CLUSTER_STATUS" == "stopped" ]] && break
      sleep 10
    done
  fi

  if [[ "$CLUSTER_STATUS" == "stopped" ]]; then
    echo "  Starting cluster so instances can be deleted..."
    aws rds start-db-cluster --db-cluster-identifier "$CLUSTER_ID" \
      --region "$REGION" > /dev/null 2>&1 || true
    for i in $(seq 1 36); do
      CLUSTER_STATUS=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" \
        --region "$REGION" --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "not-found")
      echo "    cluster=${CLUSTER_STATUS}"
      [[ "$CLUSTER_STATUS" == "available" ]] && break
      sleep 10
    done
  fi

  # Delete all DB instances in the cluster
  INSTANCE_IDS=$(aws rds describe-db-instances \
    --region "$REGION" \
    --query "DBInstances[?DBClusterIdentifier=='${CLUSTER_ID}'].DBInstanceIdentifier" \
    --output text 2>/dev/null || true)

  for INSTANCE_ID in $INSTANCE_IDS; do
    echo "  Deleting instance ${INSTANCE_ID}..."
    aws rds delete-db-instance \
      --db-instance-identifier "$INSTANCE_ID" \
      --skip-final-snapshot \
      --region "$REGION" > /dev/null 2>&1 || true
  done

  # Wait for all instances to be gone
  for INSTANCE_ID in $INSTANCE_IDS; do
    echo "  Waiting for ${INSTANCE_ID} to be deleted..."
    aws rds wait db-instance-deleted \
      --db-instance-identifier "$INSTANCE_ID" \
      --region "$REGION" 2>/dev/null || true
  done

  # Delete the cluster itself
  echo "  Deleting cluster ${CLUSTER_ID}..."
  aws rds delete-db-cluster \
    --db-cluster-identifier "$CLUSTER_ID" \
    --skip-final-snapshot \
    --region "$REGION" > /dev/null 2>&1 || true

  aws rds wait db-cluster-deleted \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" 2>/dev/null || true

  echo "  Aurora cluster deleted"
fi
echo ""

# ──────────────────────────────────────────────────────────────────
# 6. CDK destroy
# ──────────────────────────────────────────────────────────────────
echo "── Running cdk destroy --all ──"
echo ""

npx cdk destroy --all --force || true

# ──────────────────────────────────────────────────────────────────
# 7. Force-delete any stacks still stuck in DELETE_FAILED
#    Retains the failed resources (they're already gone or orphaned).
# ──────────────────────────────────────────────────────────────────
echo ""
echo "── Checking for DELETE_FAILED stacks ──"

FAILED_STACKS=$(aws cloudformation list-stacks \
  --region "$REGION" \
  --stack-status-filter DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName, '${PREFIX}')].StackName" \
  --output text 2>/dev/null || true)

if [[ -z "$FAILED_STACKS" ]]; then
  echo "  No stuck stacks"
else
  for STACK_NAME in $FAILED_STACKS; do
    echo "  Force-deleting stuck stack: ${STACK_NAME}"

    FAILED_RESOURCES=$(aws cloudformation describe-stack-events \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].LogicalResourceId' \
      --output text 2>/dev/null | tr '\t' '\n' | sort -u | tr '\n' ' ' || true)

    echo "    Retaining: ${FAILED_RESOURCES}"
    aws cloudformation delete-stack \
      --stack-name "$STACK_NAME" \
      --retain-resources $FAILED_RESOURCES \
      --region "$REGION" 2>/dev/null || true

    aws cloudformation wait stack-delete-complete \
      --stack-name "$STACK_NAME" \
      --region "$REGION" 2>/dev/null || true

    echo "    ${STACK_NAME} force-deleted"
  done
fi

echo ""
echo "✓ Destroy complete"
