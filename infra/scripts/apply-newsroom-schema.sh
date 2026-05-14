#!/usr/bin/env bash
# Apply newsroom_schema.sql to Aurora one statement at a time.
# (RDS Data API doesn't support multi-statement SQL.)
#
# Idempotent: every ALTER uses ADD COLUMN IF NOT EXISTS, every CREATE uses
# IF NOT EXISTS — safe to run multiple times.
#
# Required env vars (or exported before calling this script):
#   AURORA_CLUSTER_ARN  — ARN of the Aurora Serverless v2 cluster
#   AURORA_SECRET_ARN   — ARN of the Secrets Manager secret with DB credentials
#
# Optional:
#   DATABASE            — database name (default: orgiq)
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve ARNs
# ---------------------------------------------------------------------------
if [ -z "${AURORA_CLUSTER_ARN:-}" ]; then
  echo "ERROR: AURORA_CLUSTER_ARN is not set." >&2
  echo "  Export it or source your environment before running this script." >&2
  exit 1
fi

if [ -z "${AURORA_SECRET_ARN:-}" ]; then
  echo "ERROR: AURORA_SECRET_ARN is not set." >&2
  echo "  Export it or source your environment before running this script." >&2
  exit 1
fi

DATABASE="${DATABASE:-orgiq}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../../schema/newsroom_schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "ERROR: schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

echo "Applying newsroom schema to database '$DATABASE'..."
echo "  cluster : $AURORA_CLUSTER_ARN"
echo "  secret  : $AURORA_SECRET_ARN"
echo "  file    : $SCHEMA_FILE"
echo ""

# ---------------------------------------------------------------------------
# Split multi-statement SQL and execute each statement individually
# ---------------------------------------------------------------------------
python3 - "$SCHEMA_FILE" <<'PYEOF' | while IFS= read -r stmt; do
import sys, re
src = open(sys.argv[1]).read()
# Strip line comments
src = re.sub(r'--[^\n]*', '', src)
# Split on semicolons not inside parentheses
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
  preview="$(printf '%s' "$stmt" | head -c 80)"
  echo "-> ${preview}..."
  aws rds-data execute-statement \
    --resource-arn "$AURORA_CLUSTER_ARN" \
    --secret-arn "$AURORA_SECRET_ARN" \
    --database "$DATABASE" \
    --region us-east-1 \
    --sql "$stmt" \
    --output json > /dev/null
done

echo ""
echo "Verifying newsroom tables:"
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database "$DATABASE" \
  --region us-east-1 \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('entities','article_entities','sources','story_clusters','cluster_articles','pitches') ORDER BY 1" \
  --query "records[].[0].stringValue" --output text

echo ""
echo "Newsroom schema applied successfully."
