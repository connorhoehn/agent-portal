#!/usr/bin/env bash
# Verify AWS credentials are valid and show current identity
set -euo pipefail

echo "=== AWS Authentication Status ==="
if ! aws sts get-caller-identity --output table 2>/dev/null; then
  echo "ERROR: No valid AWS credentials. Run: aws sso login --profile bedrock"
  exit 1
fi

echo ""
echo "Region: ${AWS_REGION:-us-east-1}"
echo "Profile: ${AWS_PROFILE:-default}"
