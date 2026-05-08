#!/usr/bin/env bash
# Show all CloudFormation outputs for OrgIQ stacks (resource IDs, ARNs, endpoints)
set -euo pipefail

STACKS=(
  OrgIQ-Foundation
  OrgIQ-Neptune
  OrgIQ-KnowledgeBase
  OrgIQ-Guardrails
  OrgIQ-Agents
  OrgIQ-Observability
  OrgIQ-AgentCoreMemory
  OrgIQ-AgentCorePolicy
  OrgIQ-AgentCoreRuntime
  OrgIQ-AgentCoreGateway
)

for stack in "${STACKS[@]}"; do
  echo "=== $stack ==="
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[].[OutputKey, OutputValue]" \
    --output table 2>/dev/null || echo "  (not deployed)"
  echo ""
done
