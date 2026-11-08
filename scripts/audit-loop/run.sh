#!/usr/bin/env bash
# Recurring component-discipline / realtime-mapping audit. One iteration:
#   1. skip unless the audited code changed since the last run (--force overrides)
#   2. deterministic gates + scanners (free)
#   3. read-only Sonnet audit
#   4. Opus escalation review, only when Sonnet asks for it or a gate failed
# Reports land in docs/audit-loop/runs/<stamp>/; docs/audit-loop/latest.md
# points at the newest. Scheduled by launchd (see install.sh), never by Claude.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECTS="$(dirname "$ROOT")"
OUT="$ROOT/docs/audit-loop"
STATE="$OUT/.state"
LOCK="$STATE/lock"
SONNET_BUDGET="${AUDIT_SONNET_BUDGET_USD:-3}"
OPUS_BUDGET="${AUDIT_OPUS_BUDGET_USD:-8}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p "$STATE"
if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock older than 3 hours belongs to a crashed run.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"
  else echo "audit already running"; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$ROOT"
AUDITED=(portal/src middleware/src scripts/validate-component-discipline.sh portal/package.json middleware/package.json)
fingerprint() {
  {
    git rev-parse HEAD
    git diff HEAD -- "${AUDITED[@]}"
    git ls-files --others --exclude-standard -- portal/src middleware/src | sort | xargs -I{} shasum -a 256 {} 2>/dev/null
    for repo in ui-components realtime-modules realtime-examples; do git -C "$PROJECTS/$repo" rev-parse HEAD 2>/dev/null; done
  } | shasum -a 256 | cut -d' ' -f1
}
FP="$(fingerprint)"
if [ "$FORCE" = 0 ] && [ -f "$STATE/fingerprint" ] && [ "$(cat "$STATE/fingerprint")" = "$FP" ]; then
  echo "$(date '+%F %T') no change since last audit; skipping"; exit 0
fi

# ---- 0. install guard -------------------------------------------------------
# The 12:16 tick on 2026-10-06 escalated a tsc error that was really the gate
# racing an `npm install`: gates.log was written six seconds before the new
# ui-components dist landed. A library pin that does not match what npm has
# recorded as installed, or a node_modules that changed in the last two
# minutes, means an install is in flight — skip the tick rather than judge a
# half-written tree.
for consumer in portal middleware; do
  for dep in ui-components realtime-modules; do
    want="$(grep -oE "$dep#[0-9a-f]{40}" "$consumer/package.json" | head -1 | cut -d# -f2)"
    [ -n "$want" ] || continue
    have="$(grep -oE "$dep\.git#[0-9a-f]{40}" "$consumer/node_modules/.package-lock.json" 2>/dev/null | head -1 | cut -d# -f2)"
    if [ "$want" != "$have" ]; then echo "$(date '+%F %T') skip: $consumer $dep pin $want not installed (have ${have:-none})"; exit 0; fi
  done
  if [ -n "$(find "$consumer/node_modules/.package-lock.json" -mmin -2 2>/dev/null)" ]; then
    echo "$(date '+%F %T') skip: $consumer/node_modules changed under two minutes ago"; exit 0
  fi
done

STAMP="$(date '+%Y-%m-%dT%H%M')"
RUN="$OUT/runs/$STAMP"; mkdir -p "$RUN"
PREV="$(readlink "$OUT/latest.md" 2>/dev/null || true)"; [ -n "$PREV" ] && PREV="$OUT/$PREV"
[ -f "${PREV:-}" ] || PREV="(none — first run)"

# ---- 1. deterministic stage ------------------------------------------------
GATE_FAIL=0
{
  for gate in validate-component-discipline.sh validate-nav-parity.sh; do
    echo "=== $gate"
    if ./scripts/$gate > "$RUN/$gate.log" 2>&1; then tail -1 "$RUN/$gate.log"
    else GATE_FAIL=1; echo "FAILED"; grep -E "✗|FAIL" "$RUN/$gate.log" | head -40; fi
  done
  # Informational (does not set GATE_FAIL): the Communication plane judge is a
  # goal in flight; its backlog is reported, not a loop-stopping gate.
  echo "=== validate-communication-plane.sh --quick (informational)"
  ./scripts/validate-communication-plane.sh --quick > "$RUN/validate-communication-plane.sh.log" 2>&1 \
    && tail -1 "$RUN/validate-communication-plane.sh.log" \
    || grep -E "CHECK\(S\) FAILING" "$RUN/validate-communication-plane.sh.log"
} > "$RUN/gates.log"
node scripts/audit-loop/raw-scan.mjs > "$RUN/raw-scan.txt" 2>&1
{
  echo "## static inline styles (style={{) outside tests"; grep -rn 'style={{' portal/src | grep -v __tests__ | grep -v '\.test\.' || true
  echo "## useNotifications( call sites"; grep -rn 'useNotifications(' portal/src | grep -v __tests__ || true
  echo "## raw WebSocket / EventSource"; grep -rnE 'new (WebSocket|EventSource)\(' portal/src | grep -v __tests__ || true
  echo "## local copies of library DM/channel helpers"; grep -rnE 'function (dmChannelFor|dmMembers|parseDmLobby|stripServicePrefix)|DM_PREFIX *=' portal/src middleware/src | grep -v __tests__ || true
} > "$RUN/signals.txt"
{ git diff --name-only HEAD -- "${AUDITED[@]}"; git ls-files --others --exclude-standard -- portal/src middleware/src; } | sort -u > "$RUN/changed-files.txt"

# ---- 2. Sonnet audit -------------------------------------------------------
TOOLS=(Read Grep Glob "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git -C:*)" "Bash(ls:*)" "Bash(wc:*)")
DENY=(Edit Write NotebookEdit WebFetch WebSearch Agent)
DIRS=(--add-dir "$PROJECTS/ui-components" --add-dir "$PROJECTS/realtime-modules" --add-dir "$PROJECTS/realtime-examples")
prompt() { sed -e "s|{{RUN_DIR}}|$RUN|g" -e "s|{{PREV_REPORT}}|$PREV|g" -e "s|{{SONNET_REPORT}}|$RUN/sonnet.md|g" "$1"; }

prompt scripts/audit-loop/sonnet-prompt.md | claude -p --model sonnet --max-budget-usd "$SONNET_BUDGET" \
  --allowedTools "${TOOLS[@]}" --disallowedTools "${DENY[@]}" "${DIRS[@]}" > "$RUN/sonnet.md" 2> "$RUN/sonnet.err"
SONNET_RC=$?
REPORT="$RUN/sonnet.md"

# ---- 3. Opus escalation ----------------------------------------------------
if [ "$SONNET_RC" = 0 ] && { [ "$GATE_FAIL" = 1 ] || grep -qiE '^ESCALATE: *yes' "$RUN/sonnet.md"; }; then
  prompt scripts/audit-loop/opus-prompt.md | claude -p --model opus --max-budget-usd "$OPUS_BUDGET" \
    --allowedTools "${TOOLS[@]}" --disallowedTools "${DENY[@]}" "${DIRS[@]}" > "$RUN/opus.md" 2> "$RUN/opus.err"
  [ $? = 0 ] && REPORT="$RUN/opus.md"
fi

# ---- 4. publish ------------------------------------------------------------
if [ "$SONNET_RC" = 0 ]; then
  ln -sfn "runs/$STAMP/sonnet.md" "$OUT/latest.md"
  [ "$REPORT" = "$RUN/opus.md" ] && ln -sfn "runs/$STAMP/opus.md" "$OUT/latest-escalation.md"
  echo "$FP" > "$STATE/fingerprint"
fi
FINDINGS=$(grep -cE '^\| *[0-9]+ *\|' "$REPORT" 2>/dev/null || echo 0)
ESC=$([ "$REPORT" = "$RUN/opus.md" ] && echo opus || echo sonnet)
printf '%s\t%s\tsonnet_rc=%s\tgates_failed=%s\tfindings=%s\treviewer=%s\n' "$STAMP" "$FP" "$SONNET_RC" "$GATE_FAIL" "$FINDINGS" "$ESC" >> "$OUT/history.tsv"
osascript -e "display notification \"$FINDINGS findings ($ESC), gates_failed=$GATE_FAIL\" with title \"OrgIQ audit $STAMP\"" >/dev/null 2>&1 || true
echo "$(date '+%F %T') audit done: $REPORT"
