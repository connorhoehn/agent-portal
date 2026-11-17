# Row I1.3, Openings and the kit editor. Sourced by scripts/validate-interviews.sh.

row_I1.3() {
  exists $MW/lib/interviews/kit.ts "the kit's checks (lib/interviews/kit.ts)"
  needF "export function checkKit(" $MW/lib/interviews/kit.ts "checkKit: required fields, the question's competency, starter code, limits, what is in use"
  needF "export interface OpeningWrites" $MW/lib/interviews/store.ts "OpeningWrites in the store interface"
  needF "export interface InterviewsStore extends OpeningWrites" $MW/lib/interviews/store.ts "InterviewsStore extends OpeningWrites"
  needF "async replaceOpeningKit(" $MW/lib/interviews/store.ts "the memory store writes"
  needF "async replaceOpeningKit(" $MW/lib/interviews/store-sql.ts "the SQL store writes"
  needF "WHERE id = :id AND revision = :revision" $MW/lib/interviews/store-sql.ts "a compare-and-set against the revision"
  need "revision +INTEGER NOT NULL" schema/interviews_schema.sql "interview_openings.revision in the schema"
  exists $MW/routes/interviews/openings.ts "the openings write routes"
  want_count "^interviewsRouter\.use\(openingsRouter\)" $MW/routes/interviews.ts 1 "mounted with one line"
  needF "const manage = requireAction('ManageCandidates');" $MW/routes/interviews/openings.ts "the openings authority is ManageCandidates, the recruiter's"
  want_count "^openingsRouter\.(get|post|put)\('[^']+', manage," $MW/routes/interviews/openings.ts 4 "every openings route gated on it"
  for p in OpeningsPage OpeningPage KitEditor NewOpeningPage; do exists $PAGES/$p.tsx "the $p page"; done
  needF "ComposerPrompt" $PAGES/OpeningPage.tsx "saving and discarding asked in the composer's prompt deck"
  if has "<(Modal|Dialog|ConfirmDialog)[ >]" $PAGES/OpeningPage.tsx; then fail "a modal on the opening page"; else ok "no modal on the opening page"; fi
  for h in "'Opening'" "'Team'" "'Hiring manager'" "'Candidates by stage'" "'Kit'"; do needF "header: $h" $PAGES/OpeningsPage.tsx "Openings column $h"; done
  needF "'/interviews/openings'," portal/src/components/shell/Layout.tsx "a nav row"
  needF "group: 'Hire', requireRoles: ['recruiter', 'hiring-manager', 'admin']" portal/src/components/shell/Layout.tsx "under Hire for the recruiter and the hiring manager"
  needF "'openings'," portal/e2e/ui-dom-audit.policies.ts "a DOM audit route"
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "kit checks, the store writes in both stores, the write routes and the authz matrix" \
      src/lib/interviews/__tests__/kit.test.ts src/lib/interviews/__tests__/store.test.ts src/routes/__tests__/interviews-openings.test.ts src/lib/__tests__/authz-matrix.test.ts
    if ( cd portal && node --test src/lib/__tests__/interviewsKit.test.ts ) >"$LOGS/portal-interviews-kit.log" 2>&1; then ok "portal kit helpers: $(grep -E '^ℹ pass' "$LOGS/portal-interviews-kit.log")"; else fail "portal kit helpers (see $LOGS/portal-interviews-kit.log)"; fi
    run_journey
    for s in I1.3a I1.3b I1.3c I1.3d I1.3e I1.3f I1.3g I1.3h; do journey_step "$s"; done
  fi
}

built_row I1.3 row_I1.3
