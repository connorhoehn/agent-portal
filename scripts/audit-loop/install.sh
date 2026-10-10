#!/usr/bin/env bash
# Install / remove the launchd agent that runs scripts/audit-loop/run.sh.
#   ./scripts/audit-loop/install.sh            # every hour (skips when nothing changed)
#   AUDIT_INTERVAL_S=7200 ./scripts/audit-loop/install.sh
#   ./scripts/audit-loop/install.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.connorhoehn.orgiq-audit-loop"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${AUDIT_INTERVAL_S:-3600}"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--uninstall" ]; then rm -f "$PLIST"; echo "removed $LABEL"; exit 0; fi

mkdir -p "$ROOT/docs/audit-loop"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/audit-loop/run.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>LowPriorityIO</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$ROOT/docs/audit-loop/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/docs/audit-loop/launchd.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every ${INTERVAL}s); run now with: launchctl kickstart gui/$(id -u)/$LABEL"
