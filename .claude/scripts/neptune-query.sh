#!/usr/bin/env bash
# Execute an openCypher query against the Neptune Analytics graph
# Usage: ./neptune-query.sh "MATCH (n) RETURN count(n) AS total"
set -euo pipefail

QUERY="${1:?Usage: neptune-query.sh \"CYPHER_QUERY\"}"

GRAPH_ID=$(aws cloudformation describe-stacks --stack-name OrgIQ-Neptune \
  --query "Stacks[0].Outputs[?OutputKey=='GraphId'].OutputValue" --output text 2>/dev/null)

if [ -z "$GRAPH_ID" ] || [ "$GRAPH_ID" = "None" ]; then
  echo "ERROR: Neptune graph not deployed. Deploy with: cd infra && npx cdk deploy OrgIQ-Neptune"
  exit 1
fi

echo "Graph: $GRAPH_ID"
echo "Query: $QUERY"
echo "---"

aws neptune-graph execute-query \
  --graph-identifier "$GRAPH_ID" \
  --query-string "$QUERY" \
  --language OPEN_CYPHER \
  --output json 2>/dev/null | python3 -m json.tool
