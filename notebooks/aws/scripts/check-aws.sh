#!/bin/bash
set -e

echo "Checking AWS credentials..."
aws sts get-caller-identity --output table

echo ""
echo "Checking Bedrock model access..."
aws bedrock list-foundation-models --query "modelSummaries[?contains(modelId, 'anthropic')].{Model:modelId, Status:modelLifecycle.status}" --output table

echo ""
echo "Checking Neptune Analytics access..."
aws neptune-graph list-graphs --output table 2>/dev/null || echo "No Neptune graphs found (or service not available in region)"

echo ""
echo "All checks passed."
