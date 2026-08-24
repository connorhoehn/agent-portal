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

# ──────────────────────────────────────────────────────────────────
# 1. Orphaned S3 buckets
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned S3 buckets ──"

S3_BUCKETS=(
  "${PREFIX}-documents-${ACCOUNT}-${REGION}"
  "${PREFIX}-artifacts-${ACCOUNT}-${REGION}"
)

for bucket in "${S3_BUCKETS[@]}"; do
  if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
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
      echo "      OrgIQ-Foundation will FAIL to create this bucket while the name is taken."
      echo "      Contents are regenerable (schema/synth). To proceed:"
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
# 3. Orphaned ECR repositories
# (Should no longer be needed after emptyOnDelete:true, kept as safety net)
# ──────────────────────────────────────────────────────────────────
echo "── Checking for orphaned ECR repositories ──"

# Every repo the app owns, not just the six original agents. A repo missing
# from this list survives a teardown, and its stack then fails to create with
# "Resource of type 'AWS::ECR::Repository' ... already exists" — which is how
# OrgIQ-MiddlewareService blocked a rebuild here, three stacks from the end.
# Repos a stack CREATES. A leftover one blocks its stack from creating with
# "Resource of type 'AWS::ECR::Repository' ... already exists", which is how
# OrgIQ-MiddlewareService blocked a rebuild here three stacks from the end.
#
# The three news-* repos are deliberately ABSENT from this list. The runtime
# stack IMPORTS them (see EXTERNAL_AGENT_NAMES in agentcore-runtime-stack.ts) —
# they are external by design and never CFN-owned, so they look exactly like
# orphans and are not. Deleting them takes their images with them and leaves
# the stack importing repositories that no longer exist. Recreate with
# `aws ecr create-repository --repository-name orgiq-news-<agent>` if that
# happens.
ECR_REPOS=(
  "${PREFIX}-supervisor"
  "${PREFIX}-search"
  "${PREFIX}-scoring"
  "${PREFIX}-advisor"
  "${PREFIX}-ingestion"
  "${PREFIX}-graph-builder"
  "${PREFIX}-agent-base"
  "${PREFIX}-devbox"
  "${PREFIX}-middleware"
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
# 4. CDK deploy
#
# --concurrency 5   deploy independent stacks in parallel (CDK respects
#                   addDependency() so the order is still correct)
# --no-rollback     on failure, stop instead of rolling back — much faster
#                   to iterate in dev (fix the error, redeploy)
# --method direct   skip changeset create→wait→execute round-trip on updates,
#                   saves ~15-30s per stack. Safe for dev; remove for prod.
# ──────────────────────────────────────────────────────────────────
echo "── Running cdk deploy ──"
echo ""

# --method direct only works for updates, not initial stack creation.
# Detect whether any stacks are being created fresh and fall back to
# change-set method if so (change-set works for both create and update).
EXISTING_STACKS=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `OrgIQ`)].StackName' \
  --output text 2>/dev/null || echo "")

STACKS_TO_DEPLOY=$(npx cdk ls 2>/dev/null | grep "^OrgIQ" || echo "")
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

CDK_FLAGS=(
  --require-approval never
  --concurrency 5
  --no-rollback
  --method "$METHOD"
)

echo "  method=${METHOD}  concurrency=5  no-rollback=true"
echo ""

if [[ ${#CDK_ARGS[@]} -eq 0 ]]; then
  npx cdk deploy --all "${CDK_FLAGS[@]}"
else
  npx cdk deploy "${CDK_ARGS[@]}" "${CDK_FLAGS[@]}"
fi
