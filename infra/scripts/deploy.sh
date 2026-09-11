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

STACKS_TO_DEPLOY=$("${CDK[@]}" ls 2>/dev/null | grep "^OrgIQ" || echo "")
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
    "${CDK[@]}" deploy --all "${CDK_FLAGS[@]}"
  else
    "${CDK[@]}" deploy "${CDK_ARGS[@]}" "${CDK_FLAGS[@]}"
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
