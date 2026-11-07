#!/usr/bin/env bash
# validate-ui.sh — the definition of done for any change under portal/src.
#
# Three judges, in order; every one must pass:
#   1. lint:ui        the ui-components ESLint plugin over portal/src, held to
#                     the per-file baseline in portal/eslint-suppressions.json
#                     (a new file must be clean; a fixed violation must be pruned)
#   2. discipline     scripts/validate-component-discipline.sh (raw elements,
#                     raw buttons, style props, typography, layout drift)
#   3. audit:ui       the packaged ui-dom-audit on each changed route, both
#                     themes, 1440 and 900 wide, resting states
#
# Which routes a change renders cannot be read reliably from a diff, so the
# author names them. A diff that touches portal/src with no route named fails:
# either name the routes, or say why there is no route to audit.
#
# Usage:
#   scripts/validate-ui.sh --route orgiq:/admin/observability/invocations/:invocationId
#   scripts/validate-ui.sh --route access:/access/settings --route access:/access/configuration
#   scripts/validate-ui.sh --no-audit "shell hook only; no rendered change"
#   scripts/validate-ui.sh --base origin/main ...     # diff base (default: main)
#
# A route is <tenant>:<path>, where <path> is an inventory URL or pattern
# (portal/e2e/route-inventory.ts); an unknown path selects nothing and the
# audit fails empty coverage, so add the route to the inventory first.
# The audit needs the portal and middleware up (Tilt, or `npm run dev` in
# both); UI_AUDIT_BASE_URL points it at another portal (default :5183).
# Reports land in .scratch/validate-ui/<tenant>-<route>/.
set -u
cd "$(dirname "$0")/.."

BASE=main
ROUTES=()
NO_AUDIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --route) ROUTES+=("${2:?--route needs <tenant>:<path>}"); shift 2 ;;
    --no-audit) NO_AUDIT="${2:?--no-audit needs a reason}"; shift 2 ;;
    --base) BASE="${2:?--base needs a ref}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
section() { printf '\n== %s ==\n' "$1"; }

# Changed portal UI files: committed since the merge base, staged, unstaged
# and untracked.
CHANGED=$( { git diff --name-only "$(git merge-base "$BASE" HEAD 2>/dev/null || echo "$BASE")" -- portal/src 2>/dev/null
             git ls-files --others --exclude-standard -- portal/src; } | grep -E '\.(tsx|ts|css)$' | sort -u)

section "lint:ui (ui-components ESLint plugin, per-file baseline)"
if npm --prefix portal run --silent lint:ui; then ok "lint:ui clean against portal/eslint-suppressions.json"
else fail "lint:ui — fix the new violation (or prune a fixed one: npm --prefix portal run lint:ui -- --prune-suppressions)"; fi

section "component discipline"
if DISC=$(bash scripts/validate-component-discipline.sh 2>&1); then ok "validate-component-discipline.sh passes"
else printf '%s\n' "$DISC" | grep '✗' ; fail "validate-component-discipline.sh"; fi

section "ui-dom-audit on the changed routes"
if [ -z "$CHANGED" ] && [ ${#ROUTES[@]} -eq 0 ]; then
  ok "no portal/src change since $BASE and no route named — nothing to audit"
elif [ ${#ROUTES[@]} -eq 0 ] && [ -n "$NO_AUDIT" ]; then
  ok "audit skipped by the author: $NO_AUDIT"
  printf '%s\n' "$CHANGED" | sed 's/^/      changed: /'
elif [ ${#ROUTES[@]} -eq 0 ]; then
  printf '%s\n' "$CHANGED" | sed 's/^/      changed: /'
  fail "portal/src changed but no --route named: pass --route <tenant>:<path> for each route these files render (or --no-audit \"<reason>\")"
else
  BASE_URL=${UI_AUDIT_BASE_URL:-http://127.0.0.1:5183}
  if ! curl -sf -o /dev/null --max-time 5 "$BASE_URL/"; then
    fail "no portal at $BASE_URL — start the stack (Tilt, or npm run dev in middleware and portal) or set UI_AUDIT_BASE_URL"
  else
    # One run at a time: concurrent runs share the fixture identity, and a
    # tenant switch revokes the other's cookie.
    mkdir -p .scratch/validate-ui
    for spec in "${ROUTES[@]}"; do
      tenant=${spec%%:*}; path=${spec#*:}
      if [ "$tenant" = "$spec" ] || [ -z "$path" ]; then fail "--route $spec: expected <tenant>:<path>"; continue; fi
      out=".scratch/validate-ui/${tenant}-$(printf '%s' "$path" | tr -c 'A-Za-z0-9._-' '_')"
      if npm --prefix portal run --silent audit:ui -- --tenant "$tenant" --path "$path" --states default \
           --themes light,dark --widths 1440,900 --out "$out" > "$out.log" 2>&1; then
        ok "$tenant $path: $(head -1 "$out/summary.txt" 2>/dev/null)"
      else
        fail "$tenant $path: $(head -1 "$out/summary.txt" 2>/dev/null || echo "audit did not run — see $out.log")"
        sed -n '2,12p' "$out/summary.txt" 2>/dev/null | cut -c1-220 | sed 's/^/      /'
      fi
    done
  fi
fi

echo
if [ ${#FAILS[@]} -eq 0 ]; then echo "UI CHECKS PASS"; exit 0; fi
echo "${#FAILS[@]} UI CHECK(S) FAILING:"; printf '  - %s\n' "${FAILS[@]}"; exit 1
