#!/usr/bin/env bash
# List all OrgIQ CloudFormation stacks and their status
set -euo pipefail

echo "=== OrgIQ CloudFormation Stacks ==="
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE CREATE_FAILED UPDATE_FAILED DELETE_FAILED CREATE_IN_PROGRESS UPDATE_IN_PROGRESS \
  --query "StackSummaries[?starts_with(StackName, 'OrgIQ-')].[StackName, StackStatus, CreationTime]" \
  --output table

echo ""
echo "Expected stacks (10):"
echo "  OrgIQ-Foundation, OrgIQ-Neptune, OrgIQ-KnowledgeBase,"
echo "  OrgIQ-Guardrails, OrgIQ-Agents, OrgIQ-Observability,"
echo "  OrgIQ-AgentCoreMemory, OrgIQ-AgentCorePolicy,"
echo "  OrgIQ-AgentCoreRuntime, OrgIQ-AgentCoreGateway"
