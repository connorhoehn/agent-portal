#!/usr/bin/env bash
# Definition of done for nav ↔ route parity: the command palette must never
# offer a jump that bounces. Exit 0 only when every check passes.
#
#   --quick   skip the portal tsc (the parity scan still runs — it is fast and
#             it is the whole point of this validator)
#
# WHY THIS EXISTS. `portal/src/components/shell/portalCommands.ts` opens with a
# promise: "Every page with a rail or sub-rail entry is here; gates mirror the
# routes' RequireRole so the palette never offers a jump that bounces." Both
# halves are mechanically checkable against App.tsx, and until now neither was
# checked — a palette entry is a plain object literal, so a route that gains a
# gate, moves, or is deleted leaves the catalog making a promise it no longer
# keeps.
#
# The failure lands on the worst possible person. The palette is how someone
# who does not yet know the rail finds a page; a jump that 404s or drops them
# on HomeRedirect hits exactly the user with the least context to work out why.
#
# THIS IS A HARD ZERO, not a ratchet. Both findings are mechanically decidable
# and the calibration below shows the scanner has no false positives on this
# codebase's history, so any finding fails the build.
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"
QUICK=0; for a in "$@"; do case "$a" in --quick) QUICK=1;; esac; done

FAILS=()
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS+=("$1"); }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

section "palette ↔ route parity"
node "$REPO/scripts/lib/nav-route-parity.cjs" > "$TMP/nav.jsonl" 2>"$TMP/nav.err"
rc=$?
if [ $rc -ne 0 ] || [ -s "$TMP/nav.err" ]; then
  fail "the nav parity scanner crashed or could not parse its inputs (exit $rc)"
  sed 's/^/      /' "$TMP/nav.err"
else
  n=$(grep -c . "$TMP/nav.jsonl" 2>/dev/null); n=${n:-0}
  if [ "$n" = 0 ]; then
    ok "every palette entry resolves to a route, with a matching role gate"
  else
    fail "$n palette entr(ies) disagree with App.tsx"
    node -e '
      const fs=require("fs");
      for (const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean)) {
        const f=JSON.parse(l);
        if (f.rule==="missing-route") {
          console.log(`      ${f.label} (${f.path}) — no such route; this jump 404s  [portalCommands.ts:${f.line}]`);
        } else {
          console.log(`      ${f.label} (${f.path}) — palette says [${f.palette}], route says [${f.route}]  [portalCommands.ts:${f.line}]`);
        }
      }
    ' "$TMP/nav.jsonl"
  fi
fi

# ── Calibration ─────────────────────────────────────────────────────────────
# A parity checker that passes is indistinguishable from one that is broken,
# so prove it against the commit that FIXED this exact drift. dd95c1b ("the
# rail, the palette and the breadcrumbs agree") added the RequireRole gates to
# the three /iq/scores routes and widened the assessment Configuration entry.
# Its parent therefore holds four real mismatches — and App.tsx's own comment
# at the fix says what they cost: "the routes were open, so /scores →
# /iq/scores walked any role into a raw API 403".
section "calibration — would this have caught the drift it was built for"
CAL="$TMP/cal"
mkdir -p "$CAL/portal/src/components/shell" "$CAL/scripts/lib" "$CAL/middleware"
if git -C "$REPO" cat-file -e dd95c1b^:portal/src/App.tsx 2>/dev/null; then
  git -C "$REPO" show dd95c1b^:portal/src/App.tsx > "$CAL/portal/src/App.tsx"
  git -C "$REPO" show dd95c1b^:portal/src/components/shell/portalCommands.ts > "$CAL/portal/src/components/shell/portalCommands.ts"
  # Layout.tsx too — the scanner reads all three nav surfaces, and a missing
  # input makes it throw, which reads as "0 findings" and silently passes the
  # recall check. That happened once; hence the >= assertion below.
  git -C "$REPO" show dd95c1b^:portal/src/components/shell/Layout.tsx > "$CAL/portal/src/components/shell/Layout.tsx"
  ln -sfn "$REPO/middleware/node_modules" "$CAL/middleware/node_modules"
  ln -sfn "$REPO/middleware/seeds" "$CAL/middleware/seeds"
  cp "$REPO/scripts/lib/nav-route-parity.cjs" "$CAL/scripts/lib/"
  caln=$(node "$CAL/scripts/lib/nav-route-parity.cjs" 2>/dev/null | grep -c . ); caln=${caln:-0}
  if [ "$caln" -ge 4 ]; then
    ok "catches the pre-dd95c1b drift: $caln mismatches flagged (3 × /iq/scores + assessment Configuration)"
  else
    fail "calibration: expected ≥4 mismatches before dd95c1b, got $caln — the scanner has stopped detecting real drift"
  fi
  # Precision: the CURRENT assessment Configuration entry lists all three
  # assessment roles against an ungated route. That is equivalent, not drift —
  # an ungated route inside RequireTenant already means "any role this tenant
  # has". If this ever fails, the tenant-equivalence rule has broken and the
  # validator's only finding would be a documented non-bug.
  if node "$REPO/scripts/lib/nav-route-parity.cjs" 2>/dev/null | grep -q '"path":"/assessment/configuration"'; then
    fail "calibration: /assessment/configuration flagged — it lists its tenant's whole role set against an ungated route, which is equivalent, not drift"
  else
    ok "precision: a palette entry listing its tenant's whole role set is correctly NOT flagged"
  fi
else
  note "skipped: commit dd95c1b is not in this clone's history"
fi

# Recall for the rail↔palette rule specifically. The history calibration above
# only exercises role-mismatch, so without this the rail rule could break and
# every run would still read green. Synthetic, so it cannot rot when the real
# nav changes: one rail row and one palette row for a path that really exists
# (/admin/budgets), gated differently on purpose.
RCAL="$TMP/rcal"
mkdir -p "$RCAL/portal/src/components/shell" "$RCAL/scripts/lib" "$RCAL/middleware"
cp "$REPO/portal/src/App.tsx" "$RCAL/portal/src/App.tsx"
ln -sfn "$REPO/middleware/node_modules" "$RCAL/middleware/node_modules"
ln -sfn "$REPO/middleware/seeds" "$RCAL/middleware/seeds"
cp "$REPO/scripts/lib/nav-route-parity.cjs" "$RCAL/scripts/lib/"
cat > "$RCAL/portal/src/components/shell/Layout.tsx" <<'EOF_RCAL'
const RAIL = [
  { path: '/admin/budgets', label: 'Budgets', tenant: 'admin', requireRoles: ['hr-admin'], group: 'Plan' },
];
EOF_RCAL
cat > "$RCAL/portal/src/components/shell/portalCommands.ts" <<'EOF_RCAL'
const PAGES = [
  { label: 'Budgets', hint: 'x', path: '/admin/budgets', tenant: 'admin', group: 'Plan',
    roles: ['org-leader', 'hr-admin', 'program-owner'] },
];
EOF_RCAL
if node "$RCAL/scripts/lib/nav-route-parity.cjs" 2>/dev/null | grep -q '"rule":"rail-mismatch"'; then
  ok "class rail recall: a rail row gating a page differently from the palette is flagged"
else
  fail "class rail recall: a deliberately mismatched rail row was NOT flagged — the rail rule has stopped working"
fi

# ── Build ───────────────────────────────────────────────────────────────────
if [ "$QUICK" = 0 ]; then
  section "builds"
  if (cd "$REPO/portal" && npx tsc --noEmit >"$TMP/tsc.log" 2>&1); then ok "portal tsc"; else
    fail "portal tsc"; sed 's/^/      /' "$TMP/tsc.log" | head -20
  fi
fi

printf '\n'
if [ ${#FAILS[@]} -eq 0 ]; then
  printf 'ALL CHECKS PASS — the palette and the routes agree.\n'
  exit 0
fi
printf '%d CHECK(S) FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
exit 1
