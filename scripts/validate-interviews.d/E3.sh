# Row E3: the DOM audit and the type-scale sweep over every interviews page and the candidate's pages (O-188, O-279, O-280).
# Sourced by scripts/validate-interviews.sh, which defines ok/fail/exists/jest_ok/run_journey, $PAGES and $QUICK.
#
# The audit is a browser run on its own stack (under the walk lock), so the judge reads its report rather than running it:
#   node <hardening>/tools/with-stack.mjs "$PWD" <mw> <portal> -- node scripts/audit-ui-dom.cjs --tenant interviews --all --widths 1440,1280 --themes light --no-screenshots
# The report lands in .scratch/ui-dom-audit/report.json. This row holds that every finding in it is on the list in
# E3.findings (rule, route, the most instances accepted, who owns it, why), that no composer policy is left unclassified,
# and that the report is newer than every page it measured. A finding that is not on the list, or is more frequent than
# listed, fails; a finding the page can fix is fixed, not listed.
row_E3() {
  local R=.scratch/ui-dom-audit/report.json L=scripts/validate-interviews.d/E3.findings
  exists "$R" "the DOM audit's report (run the audit with --tenant interviews --all, see the header of $0)"
  exists "$L" "the list of findings the pages and the library own"
  if [ -f "$R" ] && [ -f "$L" ]; then
    local newer; newer=$(find portal/src/pages/interviews portal/src/pages/join portal/src/components/shell -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "$R" ! -path '*__tests__*' | head -3 | tr '\n' ' ')
    if [ -z "$newer" ]; then ok "the audit's report is newer than every interviews and join page"; else fail "the audit's report is older than: $newer(run the audit again)"; fi
    local out; out=$(node -e '
      const fs = require("fs");
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const listed = new Map();
      for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
        if (!line.trim() || line.startsWith("#")) continue;
        const [rule, route, max, owner] = line.split("\t");
        listed.set(`${rule}\t${route}`, { max: Number(max), owner });
      }
      const seen = new Map();
      for (const c of r.cases) for (const i of c.issues) { const k = `${i.rule}\t${c.route}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
      const bad = [];
      let n = 0;
      for (const [k, v] of seen) { n += v; const l = listed.get(k); if (!l) bad.push(`not listed: ${k.replace("\t", " on ")} x${v}`); else if (v > l.max) bad.push(`more than listed: ${k.replace("\t", " on ")} x${v} > ${l.max}`); }
      console.log(`CASES ${r.cases.length} FINDINGS ${n} UNCLASSIFIED ${(r.unclassified ?? []).length}`);
      for (const b of bad.slice(0, 8)) console.log(`BAD ${b}`);
      console.log(`BADCOUNT ${bad.length}`);
    ' "$R" "$L" 2>&1)
    local head; head=$(echo "$out" | grep '^CASES' | head -1)
    local nbad; nbad=$(echo "$out" | sed -n 's/^BADCOUNT //p')
    if [ "${nbad:-1}" -eq 0 ]; then ok "every audit finding is on the list ($head)"; else fail "audit findings not on the list: ${nbad:-?}"; echo "$out" | grep '^BAD ' | sed 's/^BAD /      /'; fi
    local un; un=$(echo "$head" | sed -n 's/.*UNCLASSIFIED //p')
    if [ "${un:-1}" -eq 0 ]; then ok "every composer policy is classified (0 unclassified)"; else fail "composer policies unclassified: ${un:-?}"; fi
  fi
  # The discipline script: the count of ✗ at or under the baseline (9, one of them the tenant's UpcomingPage) and the type-scale ratchet at or under 6 of 8.
  local disc; disc=$(bash scripts/validate-component-discipline.sh 2>&1)
  local nd; nd=$(printf '%s\n' "$disc" | grep -c '✗')
  if [ "$nd" -le 9 ]; then ok "the discipline script: $nd failing, baseline 9"; else fail "the discipline script: $nd failing, baseline 9"; fi
  local ty; ty=$(printf '%s\n' "$disc" | sed -n 's/.*raw typography utilities on bare text: \([0-9]*\).*/\1/p' | head -1)
  if [ -n "$ty" ] && [ "$ty" -le 6 ]; then ok "the type-scale ratchet: $ty of 8"; else fail "the type-scale ratchet: ${ty:-?} of 8, want at most 6"; fi
  # The seeded ids: no first name in an interview id; the other three kinds are written it.failing until the reseed script runs.
  [ "$QUICK" -eq 1 ] || jest_ok "the seeded-id guard" src/mock/__tests__/interviews-seed-ids.test.ts
  # The candidate's pages and both live rooms, every state at 1440 and 1280 (E3-door).
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    local p f; p=$(grep -c '^PASS E3\.' "$JOURNEY_LOG"); f=$(grep -c '^FAIL E3\.' "$JOURNEY_LOG")
    if [ "$f" -eq 0 ] && [ "$p" -ge 26 ]; then ok "walk: the candidate's side and both rooms, $p states, none failing"; else fail "walk E3-door: $p passed, $f failed (want 26 or more passed, none failed)"; grep '^FAIL E3\.' "$JOURNEY_LOG" | head -5 | cut -c1-220 | sed 's/^/      /'; fi
  fi
}

built_row E3 row_E3
