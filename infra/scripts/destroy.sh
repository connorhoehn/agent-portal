#!/usr/bin/env bash
# destroy.sh — safe wrapper around `cdk destroy --all`
#
# Drains resources that cause DELETE_FAILED before CloudFormation teardown:
#   - Cedar policies (block PolicyEngine deletion)
#   - Orphan gateways (not CFN-managed)
#   - Secrets scheduled for deletion (block re-deploy after quick redeploy)
#   - Bedrock KB data sources (can't delete if vector store unreachable)
#   - Aurora cluster/instances (the RDS *cluster* is the billing resource, and
#     the AuroraFastDeleter custom resource is fragile — pre-draining the
#     cluster via the RDS API means CDK just sees it as already gone)
#
# The OrgIQ-Aurora *CFN stack* is deliberately NOT pre-deleted here. Its exports
# (cluster ARN etc.) are still imported by downstream stacks at this point, so a
# stack delete is cancelled by CloudFormation and never reaches DELETE_COMPLETE —
# see the note in the Aurora section below. `cdk destroy --all` deletes stacks in
# the correct dependency order (consumers first, Aurora last), and any stack left
# in DELETE_FAILED afterward is force-deleted by retaining its failed resources
# (orphaned AWS resources that are already gone).
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
# 3b. Pre-drain AgentCore runtimes
#
# AWS::BedrockAgentCore::Runtime routinely takes longer to delete than the CFN
# resource handler will wait, which fails the resource with NotStabilized
# ("Request timed out while deleting") and drops the whole stack into
# DELETE_FAILED — aborting `cdk destroy --all` partway through the fleet. The
# runtime then finishes deleting server-side anyway, so the failure is purely
# CFN's patience running out.
#
# Draining here, the same way Aurora and the KB are drained, means CFN sees
# resources that are already gone. Endpoints must go before their runtime (the
# API rejects the runtime delete with a ConflictException otherwise), and both
# calls are rejected while a delete is already in flight — so "already
# deleting" is a success, not an error.
# ──────────────────────────────────────────────────────────────────
echo "── Pre-draining AgentCore runtimes ──"

# Only worth doing while a stack still OWNS runtimes. Once those stacks are
# gone, the leftovers are orphans finishing their deletes server-side — CFN
# will never touch them, so waiting on them is dead time on the critical path
# (it cost 15 minutes here, blocking the OpenSearch teardown that actually
# bills by the hour).
RUNTIME_STACKS=""
for CANDIDATE in "OrgIQ-AgentCoreRuntime" "OrgIQ-Devbox"; do
  if aws cloudformation describe-stacks --stack-name "$CANDIDATE" \
       --region "$REGION" > /dev/null 2>&1; then
    RUNTIME_STACKS="${RUNTIME_STACKS} ${CANDIDATE}"
  fi
done

RUNTIME_IDS=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?starts_with(agentRuntimeName, '${PREFIX}')].agentRuntimeId" \
  --output text 2>/dev/null | tr '\t' '\n' || true)

if [[ -z "$RUNTIME_STACKS" ]]; then
  echo "  No runtime-owning stacks remain — leaving $(echo "$RUNTIME_IDS" | grep -c . || echo 0) orphan runtime(s) to finish deleting"
elif [[ -z "$RUNTIME_IDS" ]]; then
  echo "  No agent runtimes found"
else
  # Endpoints first. DEFAULT is managed with its runtime and cannot be deleted
  # on its own, so it is skipped.
  for RT_ID in $RUNTIME_IDS; do
    for EP in $(aws bedrock-agentcore-control list-agent-runtime-endpoints \
                  --agent-runtime-id "$RT_ID" --region "$REGION" \
                  --query "runtimeEndpoints[?name!='DEFAULT'].name" \
                  --output text 2>/dev/null | tr '\t' '\n' || true); do
      echo "  Deleting endpoint ${EP} (${RT_ID})"
      aws bedrock-agentcore-control delete-agent-runtime-endpoint \
        --agent-runtime-id "$RT_ID" --endpoint-name "$EP" \
        --region "$REGION" > /dev/null 2>&1 || true
    done
  done

  # Then the runtimes, once their endpoints have actually gone.
  for i in $(seq 1 60); do
    PENDING_EPS=0
    for RT_ID in $RUNTIME_IDS; do
      N=$(aws bedrock-agentcore-control list-agent-runtime-endpoints \
            --agent-runtime-id "$RT_ID" --region "$REGION" \
            --query "length(runtimeEndpoints[?name!='DEFAULT'])" \
            --output text 2>/dev/null || echo 0)
      [[ "$N" =~ ^[0-9]+$ ]] && PENDING_EPS=$((PENDING_EPS + N))
    done
    [[ "$PENDING_EPS" == "0" ]] && break
    echo "    ${PENDING_EPS} endpoint(s) still deleting..."
    sleep 10
  done

  for RT_ID in $RUNTIME_IDS; do
    echo "  Deleting runtime ${RT_ID}"
    aws bedrock-agentcore-control delete-agent-runtime \
      --agent-runtime-id "$RT_ID" --region "$REGION" > /dev/null 2>&1 || true
  done

  # Wait for them to actually go, so CFN never starts a delete it cannot
  # outlast. Report honestly on timeout rather than pressing on silently.
  for i in $(seq 1 90); do
    REMAINING=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
      --query "length(agentRuntimes[?starts_with(agentRuntimeName, '${PREFIX}')])" \
      --output text 2>/dev/null || echo "0")
    [[ "$REMAINING" == "0" || "$REMAINING" == "None" ]] && break
    echo "    ${REMAINING} runtime(s) still deleting..."
    sleep 10
  done
  if [[ "$REMAINING" != "0" && "$REMAINING" != "None" ]]; then
    echo "  ⚠ ${REMAINING} runtime(s) still deleting — CFN may still hit NotStabilized"
  else
    echo "  Agent runtimes drained"
  fi
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
      # `deleting` is not a state to wait out — it is the goal, already in
      # progress. Treating it as transitional made this loop poll for its full
      # ten minutes and then record a FAILURE ("stuck at deleting"), so the
      # script exited non-zero over a cluster that was deleting correctly and
      # would be gone minutes later. That is a false *failure*, and it is worth
      # naming as the exact inverse of the false-success this file already
      # guards against elsewhere: both leave the operator unable to trust the
      # verdict, and this direction is the more expensive mistake — it invites
      # someone to go hunting for a billing resource that is already going away,
      # or to re-run a destroy that never needed re-running.
      #
      # Same rule the runtime pre-drain above already applies: a delete that is
      # already in flight is success, not an error.
      deleting) echo "  Cluster already deleting — nothing to do"; break ;;
      stopped)
        echo "  Starting cluster so instances can be deleted..."
        aws rds start-db-cluster --db-cluster-identifier "$CLUSTER_ID" \
          --region "$REGION" > /dev/null 2>&1 || true
        ;;
      *) echo "    cluster=${CLUSTER_STATUS}, waiting..." ;;
    esac
    sleep 10
  done

  if [[ "$CLUSTER_STATUS" == "deleting" ]]; then
    # Already going away under its own steam; cdk destroy below sees it as gone.
    echo "  Aurora cluster is deleting — leaving it to finish"
  elif [[ "$CLUSTER_STATUS" != "available" && "$CLUSTER_STATUS" != "not-found" && "$CLUSTER_STATUS" != "None" ]]; then
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

  # NOTE: we do NOT pre-delete the OrgIQ-Aurora *CFN stack* here — only the RDS
  # cluster above, which is the resource that actually bills.
  #
  # This block used to `delete-stack OrgIQ-Aurora` + `wait stack-delete-complete`
  # at this point, and it HUNG the whole destroy for the waiter's full ~60-minute
  # ceiling. Root cause: OrgIQ-Aurora's exports (the cluster ARN
  # `orgiq-aurora-cluster-arn` etc.) are still IMPORTED by downstream stacks
  # (AgentCoreRuntime, MiddlewareService, PromptCanary, KnowledgeBase, Agents,
  # AgentCoreGateway) at this stage — cdk destroy has not run yet. CloudFormation
  # therefore CANCELS the delete: the stack goes DELETE_IN_PROGRESS then bounces
  # straight back to CREATE_COMPLETE with reason "Delete canceled. Cannot delete
  # export ... as it is in use by ...". It never reaches DELETE_COMPLETE nor
  # DELETE_FAILED, so `wait stack-delete-complete` polls until its own timeout.
  #
  # The pre-delete was also redundant: `cdk destroy --all` below deletes stacks
  # in dependency order (consumers first, Aurora last, so the exports are free by
  # the time Aurora is deleted), and the DELETE_FAILED handler after it already
  # force-deletes Aurora with --retain-resources for the fragile
  # AuroraFastDeleter custom resource. Stack deletion is owned entirely by those
  # two phases now.
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

# ──────────────────────────────────────────────────────────────────
# 8b. Billing-resource sweep — "no CFN stacks remain" is necessary but
#     NOT sufficient. Expensive physical resources can outlive their stack:
#     a KB deleted out-of-band orphans its OpenSearch collection; a stack
#     force-deleted with --retain-resources keeps whatever it retained; an
#     S3 bucket with objects blocks its own CFN delete. This session I had to
#     confirm by hand that the real money resources were gone — so verify them
#     here via their own APIs. Read-only: report each survivor into FAILURES[],
#     never delete (the force-deletes above already own destruction).
# ──────────────────────────────────────────────────────────────────
echo ""
echo "── Sweeping for surviving billing resources ──"

# An unreadable account is not an empty account (same trap as list-stacks
# above). If we cannot authenticate, record the sweep as unverified rather than
# letting every "|| true" below silently report a clean account.
if ! aws sts get-caller-identity > /dev/null 2>&1; then
  echo "  ✗ Credentials unavailable — cannot verify billing resources"
  FAILURES+=("billing-resource sweep unverified (credentials unavailable)")
else
  SWEEP_CLEAN=1
  sweep_survivor() {
    echo "  ✗ $1"
    FAILURES+=("$1")
    SWEEP_CLEAN=0
  }

  # Aurora clusters + instances (the ~\$45/mo idle floor).
  for c in $(aws rds describe-db-clusters --region "$REGION" \
      --query "DBClusters[?starts_with(DBClusterIdentifier, '${PREFIX}')].DBClusterIdentifier" \
      --output text 2>/dev/null || true); do
    sweep_survivor "Aurora cluster still present: ${c}"
  done
  for i in $(aws rds describe-db-instances --region "$REGION" \
      --query "DBInstances[?starts_with(DBInstanceIdentifier, '${PREFIX}')].DBInstanceIdentifier" \
      --output text 2>/dev/null || true); do
    sweep_survivor "Aurora DB instance still present: ${i}"
  done

  # OpenSearch Serverless collections (2-OCU minimum, ~\$0.48/hr even idle).
  for c in $(aws opensearchserverless list-collections --region "$REGION" \
      --query "collectionSummaries[?starts_with(name, '${PREFIX}')].name" \
      --output text 2>/dev/null || true); do
    sweep_survivor "OpenSearch Serverless collection still present: ${c} (~\$0.48/hr)"
  done

  # AgentCore runtimes. A runtime in DELETING is an orphan finishing its delete
  # server-side (section 3b leaves those on purpose) — not a survivor. Anything
  # else (READY/CREATE_FAILED/etc.) is still real, so flag it.
  RT_ROWS=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
    --query "agentRuntimes[?starts_with(agentRuntimeName, '${PREFIX}')].[agentRuntimeName,status]" \
    --output text 2>/dev/null || true)
  while IFS=$'\t' read -r RT_NAME RT_STATUS; do
    [[ -z "$RT_NAME" ]] && continue
    if [[ "$RT_STATUS" == "DELETING" ]]; then
      echo "  … runtime ${RT_NAME} still DELETING (orphan finishing server-side)"
    else
      sweep_survivor "AgentCore runtime still present: ${RT_NAME} (${RT_STATUS:-unknown})"
    fi
  done <<< "$RT_ROWS"

  # AgentCore memories (id is <name>-<suffix>, so it carries the prefix).
  for m in $(aws bedrock-agentcore-control list-memories --region "$REGION" \
      --query "memories[?starts_with(id, '${PREFIX}')].id" \
      --output text 2>/dev/null || true); do
    sweep_survivor "AgentCore memory still present: ${m}"
  done

  # AgentCore browsers + code interpreters. Prefix filtering skips the
  # AWS-managed defaults (aws.browser.v1 / aws.codeinterpreter.v1).
  for b in $(aws bedrock-agentcore-control list-browsers --region "$REGION" \
      --query "browserSummaries[?starts_with(name, '${PREFIX}')].name" \
      --output text 2>/dev/null || true); do
    sweep_survivor "AgentCore browser still present: ${b}"
  done
  for ci in $(aws bedrock-agentcore-control list-code-interpreters --region "$REGION" \
      --query "codeInterpreterSummaries[?starts_with(name, '${PREFIX}')].name" \
      --output text 2>/dev/null || true); do
    sweep_survivor "AgentCore code interpreter still present: ${ci}"
  done

  # orgiq S3 buckets (list-buckets is global, so no --region). A bucket that
  # still holds objects is exactly the case that blocks its stack's CFN delete.
  for bkt in $(aws s3api list-buckets \
      --query "Buckets[?starts_with(Name, '${PREFIX}-')].Name" \
      --output text 2>/dev/null || true); do
    sweep_survivor "S3 bucket still present: ${bkt}"
  done

  [[ "$SWEEP_CLEAN" == "1" ]] && echo "  No surviving billing resources found"
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
