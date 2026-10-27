#!/usr/bin/env bash
# deploy.sh — safe wrapper around `cdk deploy --all`
#
# Detects and removes orphaned AWS resources that block CDK stack creation
# (left behind by a previous destroy with RETAIN policies or partial failures).
#
# Usage:
#   ./scripts/deploy.sh                        # deploy all stacks
#   ./scripts/deploy.sh OrgIQ-Aurora           # deploy one stack
#   ./scripts/deploy.sh --context key=value    # pass extra CDK args
#   PREFIX=myprefix ./scripts/deploy.sh        # override resource prefix

set -euo pipefail

# Always run from the infra/ directory so CDK can find cdk.json
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

# The CDK binary, resolved ONCE and never through a bare `npx`.
#
# WHY. The executable is `cdk` but the package is `aws-cdk`. A bare `npx cdk`
# outside this directory does not find the local binary and offers to install
# the unrelated registry package literally named `cdk` -- an interactive prompt
# in a non-interactive script. Answer anything but `y` and npm cancels; answer
# `y` and you get a stranger's package, which then dies on `--app is required`.
# Both happened, on a teardown path, and neither failed until after the
# pre-drain had already deleted real infrastructure.
#
# `--no-install` is the load-bearing flag: it makes a missing dependency an
# immediate loud error instead of a silent trip to the registry.
if [[ -x "node_modules/.bin/cdk" ]]; then
  CDK=("node_modules/.bin/cdk")
else
  CDK=(npx --no-install cdk)
fi
if ! "${CDK[@]}" --version >/dev/null 2>&1; then
  echo "✗ aws-cdk is not installed here. Run 'npm ci' in infra/ first." >&2
  exit 1
fi

PREFIX="${PREFIX:-orgiq}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CDK_ARGS=("$@")

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  OrgIQ Deploy — ${REGION} / ${ACCOUNT}"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────

s3_empty() {
  local bucket="$1"
  local err count
  err=$(mktemp)
  count=$(aws s3api list-objects-v2 --bucket "$bucket" --query 'length(Contents)' --output text 2>"$err" || echo "ERROR")
  if grep -q "NoSuchBucket" "$err" 2>/dev/null; then
    rm -f "$err"; return 1  # bucket already gone — skip deletion
  fi
  rm -f "$err"
  [[ "$count" == "0" || "$count" == "None" || "$count" == "ERROR" ]]
}

dynamo_empty() {
  local table="$1"
  local count
  count=$(aws dynamodb describe-table --table-name "$table" --query 'Table.ItemCount' --output text 2>/dev/null || echo "error")
  [[ "$count" == "0" || "$count" == "error" ]]
}

# Terminal CloudFormation status of a stack, or NOT_FOUND if no such stack
# exists. Used by the post-deploy reconciliation and the KB race detector — a
# describe that fails (stack absent, or unreadable) collapses to NOT_FOUND.
stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND"
}

# ──────────────────────────────────────────────────────────────────
# 1. Orphaned S3 buckets
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned S3 buckets ──"

S3_BUCKETS=(
  "${PREFIX}-documents-${ACCOUNT}-${REGION}"
  "${PREFIX}-artifacts-${ACCOUNT}-${REGION}"
  # OrgIQ-Portal (deployPortal=true). DESTROY with its own emptier, so an
  # orphan only follows a failed stack delete — but a fixed name all the same.
  "${PREFIX}-portal-${ACCOUNT}-${REGION}"
)

for bucket in "${S3_BUCKETS[@]}"; do
  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    # Ownership FIRST, by asking CloudFormation — the same authority check the
    # ECR section uses, for the same reason: this loop had none, so every
    # deploy pass after OrgIQ-Foundation came up deleted its (empty) buckets
    # while the stack went on reporting CREATE_COMPLETE. The synth corpus then
    # failed with NoSuchBucket against a bucket CFN swore existed. An empty
    # bucket a live stack owns is not an orphan; it is a bucket nobody has
    # written to yet.
    OWNER=$(aws cloudformation describe-stack-resources \
      --physical-resource-id "$bucket" \
      --query 'StackResources[0].StackName' --output text 2>/dev/null || echo "")
    if [[ -n "$OWNER" && "$OWNER" != "None" ]]; then
      echo "  Bucket ${bucket} is owned by stack '${OWNER}' — skipping"
    elif s3_empty "$bucket"; then
      echo "  Removing empty orphan bucket: s3://${bucket}"
      aws s3 rb "s3://${bucket}" --force
    else
      # Naming the consequence matters: this is not advisory. The bucket is
      # orphaned (its stack is gone) but the NAME is still taken, so the
      # Foundation create that follows will fail on it. Say so, with the
      # command, rather than leaving a warning that reads as optional.
      echo "  ⚠️  Bucket s3://${bucket} is NOT empty — skipping deletion"
      echo "      Its stack (OrgIQ-Foundation / OrgIQ-Portal) will FAIL to create this bucket while the name is taken."
      echo "      Contents are regenerable (schema/synth; the portal bundle: scripts/portal-publish.mjs). To proceed:"
      echo "        aws s3 rb s3://${bucket} --force"
    fi
  fi
done
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 2. Orphaned DynamoDB tables
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned DynamoDB tables ──"

DYNAMO_TABLES=(
  "${PREFIX}-scores"
  "${PREFIX}-sessions"
  "${PREFIX}-leaderboards"
)

for table in "${DYNAMO_TABLES[@]}"; do
  STATUS=$(aws dynamodb describe-table --table-name "$table" --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$STATUS" == "ACTIVE" ]]; then
    # Same ownership check as the buckets above — an empty table a live stack
    # owns is not an orphan.
    T_OWNER=$(aws cloudformation describe-stack-resources \
      --physical-resource-id "$table" \
      --query 'StackResources[0].StackName' --output text 2>/dev/null || echo "")
    if [[ -n "$T_OWNER" && "$T_OWNER" != "None" ]]; then
      echo "  Table ${table} is owned by stack '${T_OWNER}' — skipping"
    elif dynamo_empty "$table"; then
      echo "  Removing empty orphan table: ${table}"
      aws dynamodb delete-table --table-name "$table" > /dev/null
    else
      echo "  ⚠️  Table ${table} has data — skipping deletion"
    fi
  elif [[ "$STATUS" == "DELETING" ]]; then
    echo "  Table ${table} is already deleting — waiting..."
    aws dynamodb wait table-not-exists --table-name "$table"
    echo "    Deleted"
  fi
done
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 2b. Orphaned OrgIQ-Social tables (deploySocial=true)
#
# OrgIQ-Social creates ~27 tables under `${PREFIX}-social-` (or
# `${PREFIX}-social-<tableSuffix>-`) with RemovalPolicy.RETAIN AND deletion
# protection, like realtime-examples' ApplicationTables. A teardown leaves
# every one of them, and the next create fails on the first with "already
# exists". So: listed by prefix (a suffix namespace included), ownership
# asked of CloudFormation exactly as above, and an orphan that holds NOTHING
# has its deletion protection turned off — `delete-table` is refused while it
# is on — and is deleted. One that holds data (chat history, call log) is
# never deleted here: the message names both ways forward.
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned OrgIQ-Social tables ──"

# Emptiness by asking for one item, not ItemCount: describe-table's count is
# refreshed about every six hours, so a table written to an hour ago reads 0.
dynamo_has_items() {
  local n
  n=$(aws dynamodb scan --table-name "$1" --limit 1 --select COUNT --query 'Count' --output text 2>/dev/null || echo "error")
  [[ "$n" != "0" ]]
}

SOCIAL_TABLES=$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@, '${PREFIX}-social-')]" --output text 2>/dev/null | tr '\t' '\n' || true)
SOCIAL_KEPT=()
for table in $SOCIAL_TABLES; do
  T_OWNER=$(aws cloudformation describe-stack-resources \
    --physical-resource-id "$table" \
    --query 'StackResources[0].StackName' --output text 2>/dev/null || echo "")
  if [[ -n "$T_OWNER" && "$T_OWNER" != "None" ]]; then
    continue  # a live OrgIQ-Social owns it
  fi
  if dynamo_has_items "$table"; then
    SOCIAL_KEPT+=("$table")
  else
    echo "  Removing empty orphan table: ${table} (deletion protection off first)"
    aws dynamodb update-table --table-name "$table" --no-deletion-protection-enabled > /dev/null
    aws dynamodb delete-table --table-name "$table" > /dev/null
  fi
done
if [[ ${#SOCIAL_KEPT[@]} -gt 0 ]]; then
  echo "  ⚠️  ${#SOCIAL_KEPT[@]} orphaned social table(s) hold data — NOT deleted:"
  for t in "${SOCIAL_KEPT[@]}"; do echo "      ${t}"; done
  echo "      OrgIQ-Social will FAIL to create these names while they exist. Either deploy into a"
  echo "      fresh namespace (--context tableSuffix=v2, passed to the middleware AND the social stack),"
  echo "      or, once the data is not wanted, per table:"
  echo "        aws dynamodb update-table --table-name <t> --no-deletion-protection-enabled"
  echo "        aws dynamodb delete-table --table-name <t>"
fi
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 2c. Secrets scheduled for deletion
#
# A destroyed stack's secrets are SCHEDULED for deletion (a 7-30 day recovery
# window), and the name stays taken for that window: a rebuild inside it fails
# on the first fixed-name secret with "already scheduled for deletion". The
# stacks' secrets all have fixed names — the middleware's callback and
# realtime secrets, the CloudFront origin secret, the social and SFU secrets
# (`${PREFIX}-social-*`) — and all are generated. Same rule as destroy.sh's
# step 3 (which runs BEFORE its own cdk destroy, so the secrets that destroy
# deletes are still pending afterwards): a secret already scheduled for
# deletion is not recovered here, it is finished.
# ──────────────────────────────────────────────────────────────────
echo "── Clearing secrets scheduled for deletion ──"
PENDING_SECRETS=$(aws secretsmanager list-secrets --include-planned-deletion \
  --query "SecretList[?starts_with(Name, '${PREFIX}-') && DeletedDate != null].Name" \
  --output text 2>/dev/null || true)
if [[ -z "$PENDING_SECRETS" ]]; then
  echo "  None"
else
  for secret in $PENDING_SECRETS; do
    echo "  Force-deleting pending secret: ${secret}"
    aws secretsmanager delete-secret --secret-id "$secret" --force-delete-without-recovery > /dev/null 2>&1 || true
  done
fi
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 3. Orphaned ECR repositories
# (Should no longer be needed after emptyOnDelete:true, kept as safety net)
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned ECR repositories ──"

# Every repo the app owns, not just the six original agents. A repo missing
# from this list survives a teardown, and its stack then fails to create with
# "Resource of type 'AWS::ECR::Repository' ... already exists" — which is how
# OrgIQ-MiddlewareService blocked a rebuild here, three stacks from the end.
#
# Keep this in step with the repos AgentCoreRuntimeStack actually creates. The
# two assessment agents were absent for exactly the reason the comment above
# warns about — the list was written when there were six agents and did not
# grow when the fleet did, so an orphaned orgiq-assessment-* repo would have
# sailed past the sweep and failed OrgIQ-AgentCoreRuntime on create.
ECR_REPOS=(
  "${PREFIX}-supervisor"
  "${PREFIX}-search"
  "${PREFIX}-scoring"
  "${PREFIX}-advisor"
  "${PREFIX}-ingestion"
  "${PREFIX}-graph-builder"
  "${PREFIX}-assessment-scorer"
  "${PREFIX}-assessment-drafter"
  "${PREFIX}-agent-base"
  "${PREFIX}-devbox"
  "${PREFIX}-middleware"
  # OrgIQ-SocialImages (lib/social-images-stack.ts, SOCIAL_IMAGE_REPOS). RETAIN
  # like the middleware repo, so a teardown leaves the names taken and the next
  # create fails with "already exists" unless this sweep knows them.
  "${PREFIX}-social-gateway"
  "${PREFIX}-platform-api"
  "${PREFIX}-lvs-sfu"
)

for repo in "${ECR_REPOS[@]}"; do
  if aws ecr describe-repositories --repository-names "$repo" > /dev/null 2>&1; then
    # Ownership is decided by asking CloudFormation, NOT by reading a tag.
    #
    # CFN does not stamp aws:cloudformation:* tags onto AWS::ECR::Repository,
    # so the old tag check read "no owner" for every repo — orphan or not. It
    # was harmless only because of a second bug (an empty result prints the
    # literal "None", so the -z test never fired). Fixing that bug alone armed
    # a check whose premise was wrong, and one deploy force-deleted seven
    # repositories that OrgIQ-AgentCoreRuntime actively owns, taking their
    # images and leaving the stack pointing at nothing.
    #
    # describe-stack-resources --physical-resource-id answers the real
    # question: does any live stack manage this repo? Absence of an owner is
    # then a fact, not an inference from missing metadata.
    OWNER=$(aws cloudformation describe-stack-resources \
      --physical-resource-id "$repo" \
      --query 'StackResources[0].StackName' --output text 2>/dev/null || echo "")
    if [[ -z "$OWNER" || "$OWNER" == "None" ]]; then
      echo "  Removing orphan ECR repo (no stack manages it): ${repo}"
      aws ecr delete-repository --repository-name "$repo" --force > /dev/null
    else
      echo "  Repo ${repo} is owned by stack '${OWNER}' — skipping"
    fi
  fi
done
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 3b. Orphaned Cloud Map namespaces
# Cloud Map creates a namespace asynchronously, so CloudFormation can cancel
# one, record DELETE_COMPLETE, and have it finish creating afterwards. Its
# private zone then holds the name in the VPC and the next create fails
# ConflictingDomainExists. Delete only a namespace no stack owns and that has
# no services.
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned Cloud Map namespaces ──"
for ns in $(aws servicediscovery list-namespaces --region "$REGION" \
    --query "Namespaces[?Name=='${PREFIX}-documents.local' || Name=='${PREFIX}-social.local'].Id" \
    --output text 2>/dev/null || true); do
  if aws cloudformation describe-stack-resources --physical-resource-id "$ns" --region "$REGION" > /dev/null 2>&1; then
    continue
  fi
  services=$(aws servicediscovery list-services --region "$REGION" \
    --filters "Name=NAMESPACE_ID,Values=${ns},Condition=EQ" --query 'length(Services)' --output text 2>/dev/null || echo 1)
  if [[ "$services" == "0" ]]; then
    echo "  Deleting orphaned namespace ${ns}"
    aws servicediscovery delete-namespace --id "$ns" --region "$REGION" > /dev/null 2>&1 || true
  else
    echo "  ⚠️  Namespace ${ns} is unowned but has services; left in place"
  fi
done
echo "  Done"
echo ""

# ──────────────────────────────────────────────────────────────────
# 4. CDK deploy
#
# --concurrency 5   deploy independent stacks in parallel (CDK respects
#                   addDependency() so the order is still correct)
# --no-rollback     on failure, stop instead of rolling back — much faster
#                   to iterate in dev (fix the error, redeploy)
# --method direct   skip changeset create→wait→execute round-trip on updates,
#                   saves ~15-30s per stack. Safe for dev; remove for prod.
# ──────────────────────────────────────────────────────────────────
# ──────────────────────────────────────────────────────────────────
# 3b. Sticky context — read the second-phase flags back from what is live.
#
# Several gates are CLI context, not cdk.json, because each needs an artifact
# that does not exist on a first deploy (an image, a stack output, a secret).
# Once they are live, every later deploy had to repeat them by hand, and one
# that forgot did real damage while reading as healthy: without
# deployMiddlewareService the BFF scales to 0; without deployPortal the
# CloudFront lock and origin rules go and the portal answers 403; without
# deployRuntimes every CfnRuntime is DELETED; and the runtimes' three callback
# secrets plus portalPublicUrl had to be copied out of Secrets Manager and
# CloudFormation into --context (docs/social-calls-deploy-plan.md §10 step 5).
#
# So each value is read from the live account, ONLY when the caller did not
# pass it, and only once its artifact exists — a fresh account infers nothing,
# so first-deploy ordering is unchanged. DEPLOY_INFER_CONTEXT=false turns it off.
# ──────────────────────────────────────────────────────────────────
ctx_given() {
  local a
  for a in ${CDK_ARGS[@]+"${CDK_ARGS[@]}"}; do [[ "$a" == "$1="* ]] && return 0; done
  return 1
}
stack_output() {
  local v
  v=$(aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true)
  [[ "$v" == "None" ]] && v=""
  echo "$v"
}
INFERRED=()
INFERRED_SHOWN=()
infer() {  # infer <key> <value> [secret]
  ctx_given "$1" && return 0
  INFERRED+=(--context "$1=$2")
  if [[ "${3:-}" == "secret" ]]; then INFERRED_SHOWN+=("$1=<from Secrets Manager>"); else INFERRED_SHOWN+=("$1=$2"); fi
}
if [[ "${DEPLOY_INFER_CONTEXT:-true}" == "true" ]]; then
  echo "── Inferring second-phase context from the live account ──"
  RUNTIME_COUNT=$(aws cloudformation list-stack-resources --stack-name OrgIQ-AgentCoreRuntime --region "$REGION" \
    --query "length(StackResourceSummaries[?ResourceType=='AWS::BedrockAgentCore::Runtime'])" --output text 2>/dev/null || echo 0)
  [[ "$RUNTIME_COUNT" =~ ^[1-9] ]] && infer deployRuntimes true

  MW_DESIRED=$(aws ecs describe-services --cluster "${PREFIX}-middleware" --services "${PREFIX}-middleware" --region "$REGION" \
    --query 'services[0].desiredCount' --output text 2>/dev/null || echo 0)
  [[ "$MW_DESIRED" =~ ^[1-9] ]] && infer deployMiddlewareService true
  MW_CIDRS=$(stack_output OrgIQ-MiddlewareService MiddlewareAllowedCidrs)
  [[ "$MW_CIDRS" =~ ^[0-9] ]] && infer albAllowCidr "$MW_CIDRS"

  PORTAL_URL=$(stack_output OrgIQ-Portal PortalUrl)
  if [[ -n "$PORTAL_URL" ]]; then
    infer deployPortal true
    infer portalPublicUrl "$PORTAL_URL"
    # Only once OrgIQ-Portal has written the parameters the middleware resolves.
    aws ssm get-parameter --name "/${PREFIX}/portal/url" --region "$REGION" >/dev/null 2>&1 \
      && infer portalPublicUrls true
  fi

  # The middleware as its own realtime gateway, read off the running task.
  MW_TASKDEF=$(aws ecs describe-services --cluster "${PREFIX}-middleware" --services "${PREFIX}-middleware" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text 2>/dev/null || true)
  if [[ "$MW_TASKDEF" == arn:* ]]; then
    RT_GW=$(aws ecs describe-task-definition --task-definition "$MW_TASKDEF" --region "$REGION" \
      --query "taskDefinition.containerDefinitions[0].environment[?name=='REALTIME_GATEWAY'].value | [0]" --output text 2>/dev/null || true)
    [[ "$RT_GW" == "on" ]] && infer realtimeGateway true
  fi

  # The opt-in Social stacks. Each consumes the middleware's exports, so a
  # deploy without its flag would try to delete exports still in use.
  stack_live() { case "$(stack_status "$1")" in NOT_FOUND|DELETE_*) return 1 ;; *) return 0 ;; esac; }
  stack_live OrgIQ-SocialImages && infer deploySocialImages true
  if stack_live OrgIQ-SocialMedia; then
    infer deploySocialMedia true
    SFU_DIGEST=$(stack_output OrgIQ-SocialMedia SfuImageDigest)
    [[ "$SFU_DIGEST" == sha256:* ]] && infer sfuImageDigest "$SFU_DIGEST"
    SFU_CIDRS=$(stack_output OrgIQ-SocialMedia SfuAllowedCidrs)
    [[ "$SFU_CIDRS" =~ ^[0-9] ]] && infer sfuAllowCidr "$SFU_CIDRS"
    [[ -n "$PORTAL_URL" ]] && infer socialPortalOrigin "$PORTAL_URL"
  fi
  if stack_live OrgIQ-Social; then
    infer deploySocial true
    PLATFORM_DIGEST=$(stack_output OrgIQ-Social PlatformApiImageDigest)
    PLATFORM_SVC=$(stack_output OrgIQ-Social PlatformApiServiceName)
    PLATFORM_DESIRED=0
    [[ -n "$PLATFORM_SVC" ]] && PLATFORM_DESIRED=$(aws ecs describe-services --cluster "${PREFIX}-middleware" \
      --services "$PLATFORM_SVC" --region "$REGION" --query 'services[0].desiredCount' --output text 2>/dev/null || echo 0)
    if [[ "$PLATFORM_DIGEST" == sha256:* && "$PLATFORM_DESIRED" =~ ^[1-9] ]]; then
      infer deploySocialService true
      infer platformApiImageDigest "$PLATFORM_DIGEST"
    fi
  fi

  # The document workspace: live when the middleware stack reports its public
  # socket URL. Its context (image digests, key-secret ARNs) is the SSM copy
  # scripts/docker/document-workspace-push.mjs writes; a deploy without it
  # would tear the document services down.
  if [[ -n "$(stack_output OrgIQ-MiddlewareService DocumentGatewayPublicUrl)" ]]; then
    DOC_CONFIG=$(aws ssm get-parameter --name "/${PREFIX}/documents/workspace-config" --region "$REGION" \
      --query 'Parameter.Value' --output text 2>/dev/null || true)
    if [[ "$DOC_CONFIG" == "{"* ]]; then
      infer deployDocumentWorkspace true
      infer documentWorkspace "$DOC_CONFIG"
    fi
  fi

  # The runtimes' machine-callback secrets (lib/agentcore-runtime-stack.ts):
  # minted by OrgIQ-MiddlewareService, passed as plain env because a runtime's
  # EnvironmentVariables cannot hold a Secrets Manager reference.
  for pair in approvalsRequestSecret:approvals-request harnessTraceSecret:harness-trace \
              assessmentRunCompleteSecret:assessment-run-complete; do
    key=${pair%%:*}
    ctx_given "$key" && continue
    val=$(aws secretsmanager get-secret-value --secret-id "${PREFIX}-${pair#*:}-secret" --region "$REGION" \
      --query SecretString --output text 2>/dev/null || true)
    [[ -n "$val" && "$val" != "None" ]] && infer "$key" "$val" secret
  done

  if [[ ${#INFERRED_SHOWN[@]} -eq 0 ]]; then
    echo "  None (nothing second-phase is live yet)"
  else
    for s in "${INFERRED_SHOWN[@]}"; do echo "  --context ${s}"; done
  fi
  echo ""
fi

echo "── Running cdk deploy ──"
echo ""

# --method direct only works for updates, not initial stack creation.
# Detect whether any stacks are being created fresh and fall back to
# change-set method if so (change-set works for both create and update).
EXISTING_STACKS=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `OrgIQ`)].StackName' \
  --output text 2>/dev/null || echo "")

STACKS_TO_DEPLOY=$("${CDK[@]}" ls ${INFERRED[@]+"${INFERRED[@]}"} 2>/dev/null | grep "^OrgIQ" || echo "")
ALL_EXIST=true
while IFS= read -r stack; do
  [[ -z "$stack" ]] && continue
  if ! echo "$EXISTING_STACKS" | grep -qw "$stack"; then
    ALL_EXIST=false
    break
  fi
done <<< "$STACKS_TO_DEPLOY"

if $ALL_EXIST; then
  METHOD="direct"
else
  METHOD="change-set"
fi

# --no-rollback cannot replace a resource (see the recovery below), and that
# recovery rolls back before retrying — which strands every RETAINed resource
# the refused attempt had already created (the document workspace's tables and
# upload EFS), so the retry then fails "already exists". When the diff shows a
# replacement, deploy with rollback from the start instead.
NO_ROLLBACK=true
if [[ "$METHOD" == "direct" ]]; then
  if [[ ${#CDK_ARGS[@]} -eq 0 ]]; then DIFF_ARGS=(); else DIFF_ARGS=("${CDK_ARGS[@]}"); fi
  if "${CDK[@]}" diff ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"} ${INFERRED[@]+"${INFERRED[@]}"} 2>&1 \
      | grep -qE '\(requires replacement\)|\(may cause replacement\)|[[:space:]]replace$'; then
    NO_ROLLBACK=false
  fi
fi

CDK_FLAGS=(
  --require-approval never
  --concurrency 5
  --method "$METHOD"
)
$NO_ROLLBACK && CDK_FLAGS+=(--no-rollback)

echo "  method=${METHOD}  concurrency=5  no-rollback=${NO_ROLLBACK}"
echo ""

# ──────────────────────────────────────────────────────────────────
# Honest exit status — do NOT trust `cdk deploy` to fail loudly.
#
# A `cdk deploy --all` that dies mid-fleet does NOT reliably exit non-zero. When
# OrgIQ-KnowledgeBase hit CREATE_FAILED (a fresh-cluster Data-API race in its
# DbInitExtension custom resource), the SIX stacks that import its exports —
# Agents, AgentCoreGateway, AgentCoreRuntime, AgentCoreTelemetry, Observability,
# MiddlewareService — were silently skipped and the script STILL exited 0. `set
# -e` never fired; we only learned the deploy was half-built by reading the log
# and querying stacks by hand.
#
# So the cdk exit code is not the last word. After deploying we reconcile the
# set of stacks this invocation was meant to produce against their ACTUAL
# CloudFormation status and exit non-zero if any is not in a healthy *_COMPLETE
# state — the same FAILURES[]-array honesty destroy.sh uses.
# ──────────────────────────────────────────────────────────────────

run_cdk_deploy() {
  if [[ ${#CDK_ARGS[@]} -eq 0 ]]; then
    "${CDK[@]}" deploy --all ${INFERRED[@]+"${INFERRED[@]}"} "${CDK_FLAGS[@]}"
  else
    "${CDK[@]}" deploy "${CDK_ARGS[@]}" ${INFERRED[@]+"${INFERRED[@]}"} "${CDK_FLAGS[@]}"
  fi
}

# The stacks this invocation is expected to produce. Explicit OrgIQ-* names on
# the command line scope the deploy to exactly those (matching cdk's own
# selection); otherwise (`--all`, or context-only args like `--context k=v`) the
# whole app is deployed and STACKS_TO_DEPLOY (from `cdk ls` above) is the
# expected set. This keeps the single-stack invocation — e.g. `./deploy.sh
# OrgIQ-AgentCoreRuntime --context deployRuntimes=true` — reconciling only
# against OrgIQ-AgentCoreRuntime, not the whole fleet.
EXPECTED_STACKS=()
if [[ ${#CDK_ARGS[@]} -gt 0 ]]; then
  for arg in "${CDK_ARGS[@]}"; do
    [[ "$arg" == OrgIQ* ]] && EXPECTED_STACKS+=("$arg")
  done
fi
if [[ ${#EXPECTED_STACKS[@]} -eq 0 ]]; then
  while IFS= read -r stack; do
    [[ -n "$stack" ]] && EXPECTED_STACKS+=("$stack")
  done <<< "$STACKS_TO_DEPLOY"
fi
if [[ ${#EXPECTED_STACKS[@]} -eq 0 ]]; then
  echo "  ✗ Could not determine which stacks to deploy (cdk ls returned nothing)."
  echo "    Refusing to report success over an unknown deploy set."
  exit 1
fi

kb_expected() {
  local s
  for s in "${EXPECTED_STACKS[@]}"; do
    [[ "$s" == "OrgIQ-KnowledgeBase" ]] && return 0
  done
  return 1
}

# The one KB failure worth auto-retrying: on a freshly-created Aurora cluster the
# Data API (HttpEndpoint) is not yet reachable when the KB's DbInitExtension
# custom resource runs, so it fails with "HttpEndpoint is not enabled" and the
# stack lands in CREATE_FAILED. It is a startup race — by a second attempt the
# Data API endpoint is stable. A sibling change hardens the CDK side; this is
# defense in depth so deploy.sh recovers even if the race slips through.
kb_hit_datapi_race() {
  [[ "$(stack_status OrgIQ-KnowledgeBase)" == "CREATE_FAILED" ]] || return 1
  local reason
  reason=$(aws cloudformation describe-stack-events \
    --stack-name OrgIQ-KnowledgeBase --region "$REGION" \
    --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].ResourceStatusReason" \
    --output text 2>/dev/null || echo "")
  echo "$reason" | grep -qiE 'HttpEndpoint is not enabled|DbInit'
}

# Deploy. `|| DEPLOY_RC=$?` keeps `set -e` from aborting on a mid-fleet failure,
# so we always reach the reconciliation below no matter how cdk exits.
DEPLOY_RC=0
run_cdk_deploy || DEPLOY_RC=$?

# ── Targeted single-shot recovery for the KB Data-API race ──
# A CREATE_FAILED stack cannot be updated — CFN accepts only a delete then a
# fresh create — so delete the failed KB stack and re-run the deploy ONCE. The
# retry is bounded to a single shot (KB_RETRIED) so a genuinely-broken deploy
# cannot loop. Gated on the KB being in scope for this invocation, so a
# single-stack run never deletes a KB it was not asked to touch. This mirrors
# exactly the manual recovery that worked this session: delete failed KB stack →
# redeploy → KB + all six downstream came up clean. (Safe on a first deploy: the
# downstream importers were skipped, so nothing consumes the KB's exports yet.)
if [[ "${KB_RETRIED:-false}" == "false" ]] && kb_expected && kb_hit_datapi_race; then
  echo ""
  echo "── OrgIQ-KnowledgeBase CREATE_FAILED on the Data-API race — recovering ──"
  echo "  Deleting the failed KB stack (a CREATE_FAILED stack cannot be updated)..."
  aws cloudformation delete-stack --stack-name OrgIQ-KnowledgeBase --region "$REGION" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name OrgIQ-KnowledgeBase --region "$REGION" 2>/dev/null || true
  echo "  Re-running the deploy once (Data API endpoint is stable by now)..."
  KB_RETRIED=true
  DEPLOY_RC=0
  run_cdk_deploy || DEPLOY_RC=$?
fi

# ── Targeted single-shot recovery for a replacement blocked by --no-rollback ──
#
# `--no-rollback` above is a real win when iterating, and it has one hard edge:
# CloudFormation REFUSES outright any update that would REPLACE a resource while
# rollback is disabled — "Replacement type updates not supported on stack with
# disable-rollback" — and the stack lands in UPDATE_FAILED having changed
# nothing. An ECS TaskDefinition is replaced on every change, so this made
# OrgIQ-MiddlewareService's task definition permanently un-updatable *through
# this script*: every image push, env var and IAM change failed identically, and
# the recovery had to be run by hand each time.
#
# Two things made it worse than a plain failure. The stack is left in a
# NON-terminal state, so the obvious next move — re-run the deploy — fails with
# a completely different error ("please use the disable-rollback parameter")
# that reads like a new problem. And `cdk deploy` exits 0 through both, so
# without the reconciliation below the script would have called it a success.
#
# So: detect exactly that reason, roll the affected stacks back to a terminal
# state, and re-run the deploy ONCE with rollback enabled — which permits
# replacements. Bounded to a single shot (REPLACE_RETRIED) so a genuinely broken
# deploy cannot loop, and scoped to EXPECTED_STACKS so it never rolls back a
# stack this invocation was not asked to touch.
replacement_blocked() {
  local stack="$1" reason
  [[ "$(stack_status "$stack")" == "UPDATE_FAILED" ]] || return 1
  reason=$(aws cloudformation describe-stack-events \
    --stack-name "$stack" --region "$REGION" \
    --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].ResourceStatusReason" \
    --output text 2>/dev/null || echo "")
  echo "$reason" | grep -qi 'Replacement type updates not supported'
}

# Back to a terminal state. `rollback-stack` is the documented way out of a
# non-terminal UPDATE_FAILED; there is no waiter for it — `stack-update-complete`
# treats UPDATE_ROLLBACK_COMPLETE as a failure — so poll for any status that is
# not still in progress.
await_terminal() {
  local stack="$1" i st
  for i in $(seq 1 60); do
    st=$(stack_status "$stack")
    case "$st" in *_IN_PROGRESS) sleep 10 ;; *) echo "$st"; return 0 ;; esac
  done
  stack_status "$stack"
}

BLOCKED=()
if [[ "${REPLACE_RETRIED:-false}" == "false" ]]; then
  for stack in "${EXPECTED_STACKS[@]}"; do
    replacement_blocked "$stack" && BLOCKED+=("$stack")
  done
fi
if [[ ${#BLOCKED[@]} -gt 0 ]]; then
  echo ""
  echo "── ${#BLOCKED[@]} stack(s) need a resource REPLACEMENT, which --no-rollback forbids ──"
  for stack in "${BLOCKED[@]}"; do
    echo "  ${stack}: rolling back to a terminal state..."
    aws cloudformation rollback-stack --stack-name "$stack" --region "$REGION" >/dev/null 2>&1 || true
    echo "  ${stack}: now $(await_terminal "$stack")"
  done
  echo "  Re-running the deploy once WITH rollback enabled (replacements allowed)..."
  KEEP_FLAGS=()
  for f in "${CDK_FLAGS[@]}"; do
    [[ "$f" == "--no-rollback" ]] || KEEP_FLAGS+=("$f")
  done
  CDK_FLAGS=("${KEEP_FLAGS[@]}")
  REPLACE_RETRIED=true
  DEPLOY_RC=0
  run_cdk_deploy || DEPLOY_RC=$?
fi

# ──────────────────────────────────────────────────────────────────
# Reconcile expected stacks against their real CloudFormation status.
# ──────────────────────────────────────────────────────────────────
echo ""
echo "── Reconciling deployed stacks against CloudFormation ──"

FAILURES=()
for stack in "${EXPECTED_STACKS[@]}"; do
  st=$(stack_status "$stack")
  case "$st" in
    CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE)
      echo "  ✓ ${stack}  ${st}" ;;
    NOT_FOUND)
      # No stack by this name — skipped because a dependency failed, or never
      # deployed. This is the silent-partial-deploy case that exited 0 before.
      echo "  ✗ ${stack}  NOT_FOUND (skipped — a dependency failed, or never created)"
      FAILURES+=("${stack}: not created (dependency failed or skipped)") ;;
    *)
      # Everything else is unhealthy: CREATE_FAILED, *_FAILED, any *_IN_PROGRESS
      # left behind, and the ROLLBACK completes. ROLLBACK_COMPLETE /
      # UPDATE_ROLLBACK_COMPLETE end in _COMPLETE but are terminal FAILURES, so
      # they must NOT be mistaken for health.
      echo "  ✗ ${stack}  ${st}"
      FAILURES+=("${stack}: ${st}") ;;
  esac
done

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "✗ Deploy INCOMPLETE — ${#FAILURES[@]} of ${#EXPECTED_STACKS[@]} expected stack(s) not healthy:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  echo ""
  echo "  Note: cdk may have exited ${DEPLOY_RC} — a mid-fleet failure can skip"
  echo "  every downstream stack and still report success, which is why this"
  echo "  reconciliation exists. Fix the failed stack and re-run"
  echo "  ./scripts/deploy.sh (it is idempotent — healthy stacks are no-ops)."
  exit 1
fi
echo "✓ Deploy complete — all ${#EXPECTED_STACKS[@]} expected stack(s) healthy"
