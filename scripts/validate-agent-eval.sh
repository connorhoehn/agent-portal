#!/usr/bin/env bash
# Definition of done for agent evals. Exit 0 only when every
# tool-bearing agent has a golden set and the structural harness (free,
# offline, no AWS) is clean for all of them. Deliberately does NOT run
# `golden_runner.py --mode live` — that mode spends real Bedrock $ and needs
# live credentials; it stays an operator workflow.
set -u
cd "$(dirname "$0")/.."
FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

PY=.venv-synth/bin/python
[ -x "$PY" ] || { echo "missing $PY — create the synth venv at .venv-synth first"; exit 1; }

section "golden set coverage"
for d in agents/*/; do
  name=$(basename "$d")
  [ -f "$d/main.py" ] || continue
  case "$name" in
    base|devbox) continue ;;
  esac
  f="agents/tests/golden/$name.json"
  if [ -f "$f" ]; then ok "$name has a golden set"; else fail "$name missing agents/tests/golden/$name.json"; fi
done

section "harness unit tests (agents/tests/test_golden_runner.py)"
if (cd agents/tests && "../../$PY" -m unittest test_golden_runner -v) >/tmp/agent-eval-unittest.log 2>&1; then
  ok "test_golden_runner passes"
else
  fail "test_golden_runner failing — see /tmp/agent-eval-unittest.log"
  tail -30 /tmp/agent-eval-unittest.log | sed 's/^/      /'
fi

section "structural grading (free, offline, no AWS)"
if (cd agents/tests && "../../$PY" golden_runner.py --mode structural) >/tmp/agent-eval-structural.log 2>&1; then
  ok "golden_runner.py --mode structural exits 0 for every agent"
else
  fail "golden_runner.py --mode structural failing — see /tmp/agent-eval-structural.log"
  tail -40 /tmp/agent-eval-structural.log | sed 's/^/      /'
fi

echo
if [ "${#FAILS[@]}" = 0 ]; then echo "ALL CHECKS PASS — every agent has a golden set, structural grading is clean."; exit 0; fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"; for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done; exit 1
