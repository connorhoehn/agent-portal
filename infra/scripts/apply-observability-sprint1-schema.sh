#!/usr/bin/env bash
# Apply observability_sprint1_schema.sql to Aurora one statement at a time
# (RDS Data API doesn't support multistatement SQL).
#
# Same pattern as apply-observability-schema.sh and
# apply-observability-approvals-schema.sh. Idempotent — every ALTER / CREATE
# uses IF NOT EXISTS, so this can be run repeatedly without effect.
set -euo pipefail

AURORA_CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
AURORA_SECRET_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='CredentialsSecretArn'].OutputValue" --output text)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../../schema/observability_sprint1_schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "Schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

python3 - "$SCHEMA_FILE" <<'PYEOF' | while IFS= read -r stmt; do
import sys, re
src = open(sys.argv[1]).read()
# Strip line comments
src = re.sub(r'--[^\n]*', '', src)
# Split on semicolons not inside parens
out, depth, buf = [], 0, []
for ch in src:
    if ch == '(':
        depth += 1
    elif ch == ')':
        depth -= 1
    if ch == ';' and depth == 0:
        s = ''.join(buf).strip()
        if s:
            print(s.replace('\n', ' '))
        buf = []
    else:
        buf.append(ch)
PYEOF
  if [ -z "$stmt" ]; then continue; fi
  preview="$(echo "$stmt" | head -c 80)"
  echo "-> $preview..."
  aws rds-data execute-statement \
    --resource-arn "$AURORA_CLUSTER_ARN" \
    --secret-arn "$AURORA_SECRET_ARN" \
    --database orgiq \
    --region us-east-1 \
    --sql "$stmt" \
    --output json > /dev/null
done

echo ""
echo "Verifying new columns on invocation_traces:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT column_name FROM information_schema.columns WHERE table_schema='observability' AND table_name='invocation_traces' AND column_name IN ('input_tokens','output_tokens','judge_input_tokens','judge_output_tokens','est_cost_usd','judge_cost_usd','total_cost_usd','prompt_version','model_id','runtime_image_digest') ORDER BY column_name" \
  --query "records[].[0].stringValue" --output text

echo ""
echo "Verifying new columns on test_results:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT column_name FROM information_schema.columns WHERE table_schema='observability' AND table_name='test_results' AND column_name IN ('input_tokens','output_tokens','est_cost_usd') ORDER BY column_name" \
  --query "records[].[0].stringValue" --output text

echo ""
echo "Verifying mode column on test_runs:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT column_name FROM information_schema.columns WHERE table_schema='observability' AND table_name='test_runs' AND column_name='mode'" \
  --query "records[].[0].stringValue" --output text

echo ""
echo "Verifying prompt_versions table:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='observability' AND table_name='prompt_versions'" \
  --query "records[].[0].stringValue" --output text
