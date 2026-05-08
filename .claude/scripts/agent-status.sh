#!/usr/bin/env bash
# Check status of all OrgIQ agents deployed to AgentCore Runtime
set -euo pipefail

AGENTS=(
  orgiq-supervisor
  orgiq-search
  orgiq-scoring
  orgiq-advisor
  orgiq-ingestion
  orgiq-graph-builder
)

echo "=== OrgIQ Agent Status ==="

if ! command -v agentcore &>/dev/null; then
  echo "ERROR: agentcore CLI not installed"
  echo "Install: npm install -g @aws/agentcore"
  exit 1
fi

for agent in "${AGENTS[@]}"; do
  echo "--- $agent ---"
  agentcore status --agent "$agent" 2>/dev/null || echo "  Not deployed"
done
