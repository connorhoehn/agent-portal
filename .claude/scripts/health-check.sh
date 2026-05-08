#!/usr/bin/env bash
# Comprehensive health check of all OrgIQ AWS resources
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PREFIX="orgiq"
ERRORS=0

echo "=== OrgIQ Infrastructure Health Check ==="
echo "Region: $REGION"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. Neptune Analytics graph
echo "--- Neptune Analytics ---"
GRAPH_ID=$(aws cloudformation describe-stacks --stack-name OrgIQ-Neptune \
  --query "Stacks[0].Outputs[?OutputKey=='GraphId'].OutputValue" --output text 2>/dev/null || echo "")
if [ -n "$GRAPH_ID" ] && [ "$GRAPH_ID" != "None" ]; then
  STATUS=$(aws neptune-graph get-graph --graph-identifier "$GRAPH_ID" --query "status" --output text 2>/dev/null || echo "UNKNOWN")
  echo "  Graph: $GRAPH_ID → $STATUS"
  [ "$STATUS" != "AVAILABLE" ] && ERRORS=$((ERRORS+1))
else
  echo "  Graph: NOT DEPLOYED"
fi
echo ""

# 2. OpenSearch Serverless collection
echo "--- OpenSearch Serverless ---"
COLLECTION=$(aws opensearchserverless list-collections \
  --query "collectionSummaries[?starts_with(name, '${PREFIX}')].[name, status]" --output text 2>/dev/null || echo "")
if [ -n "$COLLECTION" ]; then
  echo "  $COLLECTION"
else
  echo "  No collections found"
fi
echo ""

# 3. Bedrock Knowledge Base
echo "--- Bedrock Knowledge Base ---"
KB_ID=$(aws cloudformation describe-stacks --stack-name OrgIQ-KnowledgeBase \
  --query "Stacks[0].Outputs[?OutputKey=='KnowledgeBaseId'].OutputValue" --output text 2>/dev/null || echo "")
if [ -n "$KB_ID" ] && [ "$KB_ID" != "None" ]; then
  STATUS=$(aws bedrock-agent get-knowledge-base --knowledge-base-id "$KB_ID" --query "knowledgeBase.status" --output text 2>/dev/null || echo "UNKNOWN")
  echo "  KB: $KB_ID → $STATUS"
  [ "$STATUS" != "ACTIVE" ] && ERRORS=$((ERRORS+1))
else
  echo "  KB: NOT DEPLOYED"
fi
echo ""

# 4. Bedrock Guardrails
echo "--- Bedrock Guardrails ---"
GUARDRAIL_ID=$(aws cloudformation describe-stacks --stack-name OrgIQ-Guardrails \
  --query "Stacks[0].Outputs[?OutputKey=='GuardrailId'].OutputValue" --output text 2>/dev/null || echo "")
if [ -n "$GUARDRAIL_ID" ] && [ "$GUARDRAIL_ID" != "None" ]; then
  STATUS=$(aws bedrock get-guardrail --guardrail-identifier "$GUARDRAIL_ID" --query "status" --output text 2>/dev/null || echo "UNKNOWN")
  echo "  Guardrail: $GUARDRAIL_ID → $STATUS"
  [ "$STATUS" != "READY" ] && ERRORS=$((ERRORS+1))
else
  echo "  Guardrail: NOT DEPLOYED"
fi
echo ""

# 5. S3 Buckets
echo "--- S3 Buckets ---"
for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, '${PREFIX}')].Name" --output text 2>/dev/null); do
  OBJECTS=$(aws s3api list-objects-v2 --bucket "$bucket" --max-items 0 --query "KeyCount" --output text 2>/dev/null || echo "?")
  echo "  $bucket (objects: $OBJECTS)"
done
echo ""

# 6. DynamoDB Tables
echo "--- DynamoDB Tables ---"
for table in $(aws dynamodb list-tables --query "TableNames[?starts_with(@, '${PREFIX}')]" --output text 2>/dev/null); do
  STATUS=$(aws dynamodb describe-table --table-name "$table" --query "Table.TableStatus" --output text 2>/dev/null || echo "UNKNOWN")
  ITEMS=$(aws dynamodb describe-table --table-name "$table" --query "Table.ItemCount" --output text 2>/dev/null || echo "?")
  echo "  $table → $STATUS ($ITEMS items)"
  [ "$STATUS" != "ACTIVE" ] && ERRORS=$((ERRORS+1))
done
echo ""

# 7. AgentCore status (if CLI available)
echo "--- AgentCore Agents ---"
if command -v agentcore &>/dev/null; then
  agentcore status 2>/dev/null || echo "  agentcore status failed (not configured?)"
else
  echo "  agentcore CLI not installed"
fi
echo ""

# Summary
echo "=== Summary ==="
if [ $ERRORS -eq 0 ]; then
  echo "All checks passed (or resources not yet deployed)"
else
  echo "ERRORS: $ERRORS resource(s) in unhealthy state"
  exit 1
fi
