#!/usr/bin/env bash
# Check for orphaned resources that survive CDK destroy (billing risk)
set -euo pipefail

PREFIX="orgiq"
REGION="${AWS_REGION:-us-east-1}"

echo "=== Orphaned Resource Check ==="
echo "Looking for orgiq-* resources outside CloudFormation..."
echo ""

# Neptune graphs (billed per NCU-hour)
echo "--- Neptune Analytics Graphs ---"
aws neptune-graph list-graphs \
  --query "graphs[?starts_with(name, '${PREFIX}')].[name, id, status]" \
  --output table 2>/dev/null || echo "  (none or access denied)"
echo ""

# OpenSearch Serverless (2 OCU minimum, ~$700/mo if forgotten)
echo "--- OpenSearch Serverless Collections ---"
aws opensearchserverless list-collections \
  --query "collectionSummaries[?starts_with(name, '${PREFIX}')].[name, id, status]" \
  --output table 2>/dev/null || echo "  (none or access denied)"
echo ""

# S3 buckets (won't delete if non-empty)
echo "--- S3 Buckets ---"
aws s3api list-buckets \
  --query "Buckets[?starts_with(Name, '${PREFIX}')].Name" \
  --output text 2>/dev/null || echo "  (none)"
echo ""

# DynamoDB tables
echo "--- DynamoDB Tables ---"
aws dynamodb list-tables \
  --query "TableNames[?starts_with(@, '${PREFIX}')]" \
  --output text 2>/dev/null || echo "  (none)"
echo ""

# CloudWatch log groups
echo "--- CloudWatch Log Groups ---"
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/${PREFIX}" \
  --query "logGroups[].logGroupName" \
  --output text 2>/dev/null || echo "  (none)"
echo ""

echo "If resources exist above but stacks are deleted, these are orphaned and billing."
echo "Delete manually or use: cd infra && npx cdk destroy --all"
