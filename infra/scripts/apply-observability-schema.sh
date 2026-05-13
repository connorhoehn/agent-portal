#!/usr/bin/env bash
# Apply observability_schema.sql to Aurora one statement at a time
# (RDS Data API doesn't support multistatement SQL).
#
# Idempotent: every CREATE / INSERT uses IF NOT EXISTS / ON CONFLICT, so this
# can be run as many times as you like. Pairs with `schema/apply-schema.sh` —
# they live in different directories because the observability tables ship as
# part of an infra-side migration, not the base org-graph schema.
set -euo pipefail

AURORA_CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
AURORA_SECRET_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='CredentialsSecretArn'].OutputValue" --output text)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../../schema/observability_schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "schema file not found: $SCHEMA_FILE" >&2
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
            # Emit as a single line for shell consumption (escape newlines)
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
echo "Verifying observability tables:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='observability' ORDER BY 1" \
  --query "records[].[0].stringValue" --output text
