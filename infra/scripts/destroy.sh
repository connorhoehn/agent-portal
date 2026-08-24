#!/usr/bin/env bash
# destroy.sh — safe wrapper around `cdk destroy --all`
#
# Drains resources that cause DELETE_FAILED before CloudFormation teardown:
#   - Cedar policies (block PolicyEngine deletion)
#   - Orphan gateways (not CFN-managed)
#   - Secrets scheduled for deletion (block re-deploy after quick redeploy)
#   - Bedrock KB data sources (can't delete if vector store unreachable)
#   - Aurora cluster/instances (AuroraFastDeleter custom resource is fragile —
#     proactively force-deletes the OrgIQ-Aurora CFN stack after pre-drain to
#     avoid the physical-ID-change DELETE_FAILED on every destroy)
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

# Failures are collected instead of aborting mid-drain, then reported honestly
# at the end. The old behavior (|| true everywhere + unconditional "✓ Destroy
# complete") once reported success after cdk destroy died on expired
# credentials at stack 1/17 — with OpenSearch still billing.
FAILURES=()

# aws-azure-login sessions expire mid-run on long teardowns. Call before any
# phase that must not fail silently.
require_creds() {
  if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo ""
    echo "✗ AWS credentials expired mid-destroy. Re-run after: aws-azure-login --mode gui"
    echo "  (destroy.sh is idempotent — it will skip already-deleted resources)"
    exit 1
  fi
}

# CDK stack names use title-case "OrgIQ-" regardless of the resource PREFIX.
# Use this for all CloudFormation stack-name queries.
STACK_PREFIX="OrgIQ-"

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

cluster_status() {
  aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "not-found"
}

if [[ "$CLUSTER_STATUS" == "not-found" || "$CLUSTER_STATUS" == "None" ]]; then
  echo "  No Aurora cluster found"
else
  echo "  Cluster status: ${CLUSTER_STATUS}"

  # Instances can only be deleted from an *available* cluster. Converge on
  # available from every transitional state — a `stopping` cluster silently
  # blocked deletion here once, and every || true downstream hid it while the
  # script announced "Aurora cluster deleted" over a cluster that never died.
  for i in $(seq 1 60); do
    CLUSTER_STATUS=$(cluster_status)
    case "$CLUSTER_STATUS" in
      available|not-found|None) break ;;
      stopped)
        echo "  Starting cluster so instances can be deleted..."
        aws rds start-db-cluster --db-cluster-identifier "$CLUSTER_ID" \
          --region "$REGION" > /dev/null 2>&1 || true
        ;;
      *) echo "    cluster=${CLUSTER_STATUS}, waiting..." ;;
    esac
    sleep 10
  done

  if [[ "$CLUSTER_STATUS" != "available" && "$CLUSTER_STATUS" != "not-found" && "$CLUSTER_STATUS" != "None" ]]; then
    echo "  ✗ Cluster never reached 'available' (stuck at ${CLUSTER_STATUS}) — cannot delete"
    FAILURES+=("Aurora cluster not deleted (stuck ${CLUSTER_STATUS})")
  else
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

    for INSTANCE_ID in $INSTANCE_IDS; do
      echo "  Waiting for ${INSTANCE_ID} to be deleted..."
      aws rds wait db-instance-deleted \
        --db-instance-identifier "$INSTANCE_ID" \
        --region "$REGION" 2>/dev/null || true
    done

    echo "  Deleting cluster ${CLUSTER_ID}..."
    aws rds delete-db-cluster \
      --db-cluster-identifier "$CLUSTER_ID" \
      --skip-final-snapshot \
      --region "$REGION" > /dev/null 2>&1 || true

    aws rds wait db-cluster-deleted \
      --db-cluster-identifier "$CLUSTER_ID" \
      --region "$REGION" 2>/dev/null || true

    # Trust the API, not the waiter — verify the cluster is actually gone.
    CLUSTER_STATUS=$(cluster_status)
    if [[ "$CLUSTER_STATUS" == "not-found" || "$CLUSTER_STATUS" == "None" ]]; then
      echo "  Aurora cluster deleted"
    else
      echo "  ✗ Aurora cluster still exists (status: ${CLUSTER_STATUS})"
      FAILURES+=("Aurora cluster still exists (${CLUSTER_STATUS})")
    fi
  fi

  # Proactively delete the OrgIQ-Aurora CFN stack once the cluster is gone.
  # The AuroraFastDeleter custom resource has a physical-ID-change bug that
  # causes DELETE_FAILED when CDK manages the deletion. NOTE: --retain-resources
  # is only valid on stacks already in DELETE_FAILED — so delete plainly first,
  # and only retry with retained resources if it lands in DELETE_FAILED.
  AURORA_STACK_STATUS=$(aws cloudformation describe-stacks \
    --stack-name "OrgIQ-Aurora" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "not-found")

  if [[ "$AURORA_STACK_STATUS" != "not-found" && "$AURORA_STACK_STATUS" != "None" && ${#FAILURES[@]} -eq 0 ]]; then
    echo "  Pre-deleting OrgIQ-Aurora CFN stack..."
    aws cloudformation delete-stack --stack-name "OrgIQ-Aurora" --region "$REGION" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete \
      --stack-name "OrgIQ-Aurora" --region "$REGION" 2>/dev/null || true

    AURORA_STACK_STATUS=$(aws cloudformation describe-stacks \
      --stack-name "OrgIQ-Aurora" --region "$REGION" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "not-found")
    if [[ "$AURORA_STACK_STATUS" == "DELETE_FAILED" ]]; then
      echo "  Retrying with failed resources retained (AuroraFastDeleter bug)..."
      RETAIN=$(aws cloudformation describe-stack-events \
        --stack-name "OrgIQ-Aurora" --region "$REGION" \
        --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].LogicalResourceId' \
        --output text 2>/dev/null | tr '\t' '\n' | sort -u | tr '\n' ' ' || true)
      aws cloudformation delete-stack --stack-name "OrgIQ-Aurora" \
        --retain-resources $RETAIN --region "$REGION" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete \
        --stack-name "OrgIQ-Aurora" --region "$REGION" 2>/dev/null || true
    fi
    # Report the FINAL state honestly. This line used to end in `|| echo
    # deleted`, which conflated two very different failures: a stack that is
    # genuinely gone, and a describe call that could not be made. When
    # aws-azure-login credentials expired mid-destroy, the call failed, the
    # fallback fired, and the script announced "final: deleted" over a stack
    # still sitting at CREATE_COMPLETE — while its Aurora cluster HAD been
    # physically deleted. That mismatch (CFN owning a resource that no longer
    # exists) is what forced a full teardown to recover. Distinguish the cases:
    # a genuine absence is a ValidationError naming the stack, anything else is
    # unknown and must be recorded as a failure, never as success.
    AURORA_DESCRIBE_ERR=$(mktemp)
    if AURORA_FINAL=$(aws cloudformation describe-stacks \
         --stack-name "OrgIQ-Aurora" --region "$REGION" \
         --query 'Stacks[0].StackStatus' --output text 2>"$AURORA_DESCRIBE_ERR"); then
      echo "  OrgIQ-Aurora CFN stack still present (final: ${AURORA_FINAL})"
      FAILURES+=("OrgIQ-Aurora stack still present (${AURORA_FINAL})")
    elif grep -q "does not exist" "$AURORA_DESCRIBE_ERR"; then
      echo "  OrgIQ-Aurora CFN stack deleted"
    else
      echo "  ✗ Could not determine OrgIQ-Aurora stack state:"
      sed 's/^/      /' "$AURORA_DESCRIBE_ERR"
      FAILURES+=("OrgIQ-Aurora final state unknown (describe-stacks failed)")
    fi
    rm -f "$AURORA_DESCRIBE_ERR"
  fi
fi
echo ""

# ──────────────────────────────────────────────────────────────────
# 6. CDK destroy
# ──────────────────────────────────────────────────────────────────
echo "── Running cdk destroy --all ──"
echo ""

# The pre-drain above can run long enough for aws-azure-login creds to expire;
# cdk then fails on stack 1 with UnresolvedAccount. Fail loudly instead.
require_creds

if ! npx cdk destroy --all --force; then
  FAILURES+=("cdk destroy --all exited non-zero — one or more stacks not destroyed")
fi

# ──────────────────────────────────────────────────────────────────
# 7. Force-delete any stacks still stuck in DELETE_FAILED
#    Retains the failed resources (they're already gone or orphaned).
# ──────────────────────────────────────────────────────────────────
echo ""
echo "── Checking for DELETE_FAILED stacks ──"

FAILED_STACKS=$(aws cloudformation list-stacks \
  --region "$REGION" \
  --stack-status-filter DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}')].StackName" \
  --output text 2>/dev/null || true)

if [[ -z "$FAILED_STACKS" ]]; then
  echo "  No stuck stacks"
else
  for STACK_NAME in $FAILED_STACKS; do
    echo "  Force-deleting stuck stack: ${STACK_NAME}"

    # A failed delete emits TWO kinds of DELETE_FAILED event: one per resource,
    # plus a stack-level one whose LogicalResourceId is the STACK'S OWN NAME.
    # Passing that name to --retain-resources makes CFN reject the whole call
    # with a ValidationError ("resource not found in stack") — and with the
    # error suppressed, the script printed "force-deleted" over a stack it had
    # not touched. Exclude the stack's own name.
    FAILED_RESOURCES=$(aws cloudformation describe-stack-events \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].LogicalResourceId' \
      --output text 2>/dev/null | tr '\t' '\n' | grep -vx "$STACK_NAME" | sort -u | tr '\n' ' ' || true)

    echo "    Retaining: ${FAILED_RESOURCES:-<none>}"
    RETAIN_ERR=$(mktemp)
    if aws cloudformation delete-stack \
         --stack-name "$STACK_NAME" \
         --retain-resources $FAILED_RESOURCES \
         --region "$REGION" 2>"$RETAIN_ERR"; then
      aws cloudformation wait stack-delete-complete \
        --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null || true
      # The waiter returns non-zero on a re-failed delete, so confirm rather
      # than announce. Absence is the only proof of deletion.
      if aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
           --region "$REGION" > /dev/null 2>&1; then
        echo "    ✗ ${STACK_NAME} still present after force-delete"
        FAILURES+=("${STACK_NAME} force-delete did not remove the stack")
      else
        echo "    ${STACK_NAME} force-deleted"
      fi
    else
      echo "    ✗ force-delete call failed for ${STACK_NAME}:"
      sed 's/^/        /' "$RETAIN_ERR"
      FAILURES+=("${STACK_NAME} force-delete call failed")
    fi
    rm -f "$RETAIN_ERR"
  done
fi

# ──────────────────────────────────────────────────────────────────
# 8. Verify — the only success criterion is "no OrgIQ stacks remain".
# ──────────────────────────────────────────────────────────────────
echo ""
echo "── Verifying teardown ──"

# An unreadable account is NOT an empty account. Suppressing this call's error
# and treating "no output" as "no stacks" is how a teardown that never ran can
# print the success banner — the same class of bug as the Aurora line above.
VERIFY_ERR=$(mktemp)
if ! REMAINING_RAW=$(aws cloudformation list-stacks \
     --region "$REGION" \
     --query "StackSummaries[?starts_with(StackName, '${STACK_PREFIX}') && StackStatus != 'DELETE_COMPLETE'].[StackName, StackStatus]" \
     --output text 2>"$VERIFY_ERR"); then
  echo "  ✗ Could not list stacks to verify teardown:"
  sed 's/^/      /' "$VERIFY_ERR"
  FAILURES+=("teardown unverified (list-stacks failed — state unknown)")
  REMAINING_RAW=""
fi
rm -f "$VERIFY_ERR"
REMAINING=$(echo "$REMAINING_RAW" | sort -u)

if [[ -n "$REMAINING" ]]; then
  echo "  Stacks still present:"
  echo "$REMAINING" | sed 's/^/    /'
  FAILURES+=("$(echo "$REMAINING" | wc -l | tr -d ' ') stack(s) still present")
fi

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "✗ Destroy INCOMPLETE:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  echo ""
  echo "  Re-run ./scripts/destroy.sh after fixing the above (it is idempotent)."
  echo "  ⚠ If OrgIQ-KnowledgeBase remains, OpenSearch Serverless is still billing (~\$0.48/hr)."
  exit 1
fi
echo "✓ Destroy complete — no OrgIQ stacks remain"
