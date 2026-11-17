# Row I6.2, the export of what Milo showed. Sourced by scripts/validate-interviews.sh.
# The phase's floor runs src/lib/interviews/export and interviews-records.test.ts.

row_I6.2() {
  needF "recordsRouter.get('/interviews/:id/milo-export'" $MW/routes/interviews/records.ts "the export route"
  needF "if (session.role !== 'recruiter') throw new NotFoundError" $MW/routes/interviews/records.ts "the recruiter only; everyone else not-found"
  needF "Content-Disposition', \`attachment" $MW/routes/interviews/records.ts "the export is an attachment"
  # The export is no-store: the header is set on the export's own response (the line after the log line).
  if awk '/milo-export/{f=1} f && /Cache-Control/ && /no-store/{print; exit}' $MW/routes/interviews/records.ts | grep -q no-store; then ok "the export is never cached"; else fail "the export is never cached (no no-store on the export's response)"; fi
  # Logs no content: the route's one log line names who, which interview and when; the export module writes no log.
  want_count "console\." $MW/routes/interviews/records.ts 1 "one log line in the records routes"
  if grep -n "console\." $MW/routes/interviews/records.ts | grep -qE "event: 'interviews.milo-export', by: session.sub, interviewId: interview.id, at: doc.exportedAt \}"; then
    ok "the export's log line holds who, which and when, nothing of the document"
  else fail "the export's log line carries more than who, which and when"; fi
  if grep -rn "console\." $MW/lib/interviews/export/*.ts >/dev/null 2>&1; then fail "the export module writes a log line"; else ok "the export module writes no log line"; fi
  for key in suggestions notices recap milo-for-you panel-notices; do
    needF "key: '$key'" $MW/lib/interviews/export/sections.ts "the export's section '$key'"
  done
  needF "interviews-milo-export" portal/src/pages/interviews/ProfileConsents.tsx "the export button on the Consents table"
  refuses_404 I6.2
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in I6.2a I6.2b; do journey_step "$s"; done
  fi
}

built_row I6.2 row_I6.2
