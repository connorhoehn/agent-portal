#!/usr/bin/env bash
# Check current month's AWS cost for OrgIQ resources
set -euo pipefail

START=$(date -u +%Y-%m-01)
END=$(date -u +%Y-%m-%d)

echo "=== OrgIQ Cost Report ($START to $END) ==="

aws ce get-cost-and-usage \
  --time-period "Start=$START,End=$END" \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query "ResultsByTime[0].Groups[?Metrics.BlendedCost.Amount > '0'].[Keys[0], Metrics.BlendedCost.Amount]" \
  --output table 2>/dev/null || echo "Cost Explorer not available (enable in AWS Console first)"

echo ""
echo "Budget alarm threshold: \$200/month (set in OrgIQ-Observability stack)"
