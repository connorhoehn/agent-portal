#!/usr/bin/env bash
# Apply orgiq_schema.sql to Aurora one statement at a time (RDS Data API doesn't support multistatement).
set -euo pipefail

AURORA_CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
AURORA_SECRET_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='CredentialsSecretArn'].OutputValue" --output text)

SCHEMA_FILE="$(dirname "$0")/orgiq_schema.sql"

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
  # Print a short preview
  preview="$(echo "$stmt" | head -c 80)"
  echo "→ $preview..."
  aws rds-data execute-statement \
    --resource-arn "$AURORA_CLUSTER_ARN" \
    --secret-arn "$AURORA_SECRET_ARN" \
    --database orgiq \
    --region us-east-1 \
    --sql "$stmt" \
    --output json > /dev/null
done

echo ""
echo "Verifying tables:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1" \
  --query "records[].[0].stringValue" --output text
