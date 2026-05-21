#!/usr/bin/env bash
# Apply seed.sql to Aurora one statement at a time (RDS Data API is single-statement only).
# Wipes and re-inserts all seed tables — safe to re-run.
set -euo pipefail

AURORA_CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
AURORA_SECRET_ARN=$(aws cloudformation describe-stacks --stack-name OrgIQ-Aurora --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='CredentialsSecretArn'].OutputValue" --output text)

SEED_FILE="$(dirname "$0")/seed.sql"

echo "Applying $SEED_FILE to Aurora..."
echo "Cluster: $AURORA_CLUSTER_ARN"
echo ""

count=0
python3 - "$SEED_FILE" <<'PYEOF' | while IFS= read -r stmt; do
import sys, re
src = open(sys.argv[1]).read()
src = re.sub(r'--[^\n]*', '', src)
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
  count=$((count + 1))
  preview="$(echo "$stmt" | head -c 72)"
  echo "[$count] $preview..."
  aws rds-data execute-statement \
    --resource-arn "$AURORA_CLUSTER_ARN" \
    --secret-arn "$AURORA_SECRET_ARN" \
    --database orgiq \
    --region us-east-1 \
    --sql "$stmt" \
    --output json > /dev/null
done

echo ""
echo "Done. Verifying row counts:"
for tbl in people skills projects collaborations person_skills project_contributions decision_participants; do
  cnt=$(aws rds-data execute-statement \
    --resource-arn "$AURORA_CLUSTER_ARN" \
    --secret-arn "$AURORA_SECRET_ARN" \
    --database orgiq \
    --region us-east-1 \
    --sql "SELECT COUNT(*) FROM $tbl" \
    --query "records[0][0].longValue" --output text)
  printf "  %-28s %s rows\n" "$tbl" "$cnt"
done
