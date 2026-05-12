#!/usr/bin/env bash
# idle.sh — pause/resume idle-billable resources without destroying them.
#
# What it does:
#   - Stops the Aurora Serverless v2 cluster (~$0.30/day → ~$0/day idle).
#
# What it intentionally doesn't touch:
#   - Bedrock, AgentCore Runtime, Memory, Gateway, Code Interpreter, Browser,
#     Verified Permissions, Guardrails — all pay-per-invocation, $0 idle.
#   - Secrets Manager, GuardDuty, Config — can't pause individual entries.
#   - ECR / DynamoDB / S3 — storage is cents/month; not worth stopping.
#
# Usage:
#   ./scripts/idle.sh down      # stop everything pausable
#   ./scripts/idle.sh up        # resume everything
#   ./scripts/idle.sh status    # show current state
#
# AWS will auto-restart a stopped Aurora cluster after 7 days. If you stay
# offline longer, rerun `./scripts/idle.sh down` after the auto-resume.

set -euo pipefail

PREFIX="${PREFIX:-orgiq}"
AURORA_CLUSTER="${PREFIX}-aurora"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACTION="${1:-status}"

# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────

aurora_status() {
  aws rds describe-db-clusters \
    --db-cluster-identifier "$AURORA_CLUSTER" \
    --query 'DBClusters[0].Status' \
    --output text 2>/dev/null || echo "not-found"
}

wait_for_aurora_status() {
  local target="$1"
  local last=""
  local tries=0
  while true; do
    local s
    s=$(aurora_status)
    if [ "$s" != "$last" ]; then
      echo "  aurora: $s"
      last="$s"
    fi
    [ "$s" = "$target" ] && return 0
    [ "$s" = "not-found" ] && return 1
    tries=$((tries + 1))
    # Aurora cluster stop can take 8-10 min while writer instances drain.
    if [ "$tries" -gt 180 ]; then
      echo "  timed out waiting for status=$target (last=$s) after 15 min"
      return 2
    fi
    sleep 5
  done
}

# ──────────────────────────────────────────────────────────────────
# Subcommands
# ──────────────────────────────────────────────────────────────────

cmd_status() {
  echo "═══ ${PREFIX} idle state ════════════════════════════════════"
  local s
  s=$(aurora_status)
  printf "  %-30s %s\n" "Aurora cluster ($AURORA_CLUSTER)" "$s"
  case "$s" in
    available)
      echo ""
      echo "  ⚠️  Aurora is running — ~\$0.30/day burn."
      echo "      Run: ./scripts/idle.sh down"
      ;;
    stopped)
      echo ""
      echo "  ✓  Aurora is paused — \$0/day."
      echo "      Run: ./scripts/idle.sh up  (when you want to use it again)"
      ;;
    starting|stopping|configuring-iam-database-auth|backing-up|modifying)
      echo "  ⏳ Transitioning — re-run status in 30 s."
      ;;
    not-found)
      echo "  Cluster not found in this account/region. Nothing to do."
      ;;
  esac
}

cmd_down() {
  echo "═══ pausing ${PREFIX} idle-billable resources ══════════════"
  local s
  s=$(aurora_status)
  case "$s" in
    available)
      echo "Stopping Aurora cluster $AURORA_CLUSTER..."
      aws rds stop-db-cluster --db-cluster-identifier "$AURORA_CLUSTER" >/dev/null
      wait_for_aurora_status stopped || true
      echo ""
      echo "  ✓  Aurora paused. Estimated savings: ~\$0.30/day."
      ;;
    stopped)
      echo "  Aurora already stopped — nothing to do."
      ;;
    stopping)
      echo "  Aurora is already stopping — waiting..."
      wait_for_aurora_status stopped || true
      ;;
    starting|configuring-iam-database-auth|modifying|backing-up)
      echo "  Aurora is in transition ($s). Wait for it to finish, then retry."
      exit 1
      ;;
    not-found)
      echo "  Cluster $AURORA_CLUSTER not found. Nothing to pause."
      ;;
    *)
      echo "  Aurora status=$s — unknown. Aborting to avoid surprises."
      exit 1
      ;;
  esac
}

cmd_up() {
  echo "═══ resuming ${PREFIX} idle-billable resources ═════════════"
  local s
  s=$(aurora_status)
  case "$s" in
    stopped)
      echo "Starting Aurora cluster $AURORA_CLUSTER..."
      aws rds start-db-cluster --db-cluster-identifier "$AURORA_CLUSTER" >/dev/null
      wait_for_aurora_status available || true
      echo ""
      echo "  ✓  Aurora available. Agents and middleware queries will work now."
      ;;
    available)
      echo "  Aurora already running — nothing to do."
      ;;
    starting)
      echo "  Aurora is already starting — waiting..."
      wait_for_aurora_status available || true
      ;;
    stopping|modifying|backing-up)
      echo "  Aurora is in transition ($s). Wait for it to finish, then retry."
      exit 1
      ;;
    not-found)
      echo "  Cluster $AURORA_CLUSTER not found. Nothing to resume."
      ;;
    *)
      echo "  Aurora status=$s — unknown. Aborting to avoid surprises."
      exit 1
      ;;
  esac
}

# ──────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────

case "$ACTION" in
  down)   cmd_down ;;
  up)     cmd_up ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 {down|up|status}" >&2
    exit 2
    ;;
esac
