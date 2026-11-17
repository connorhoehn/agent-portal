# Row I1.6, a candidate's résumé: upload, the facts, the viewer, replace and remove. Sourced by scripts/validate-interviews.sh.

row_I1.6() {
  for f in bytes-store row-store rules service types; do exists $MW/lib/interviews/resume/$f.ts "the résumé's $f module"; done
  needF "export const RESUME_MAX_BYTES = 10 * 1024 * 1024;" $MW/lib/interviews/resume/rules.ts "the 10 MB limit"
  want_count "^interviewsRouter\.use\(resumeRouter\)" $MW/routes/interviews.ts 1 "mounted with one line"
  needF "const manage = requireAction('ManageCandidates');" $MW/routes/interviews/resume.ts "writing a résumé is the recruiter's action"
  want_count "^resumeRouter\.(get|put|delete)\('/candidates/:id/resume" $MW/routes/interviews/resume.ts 4 "four routes: read, file, upload, remove"
  want_count "^resumeRouter\.(put|delete)\('[^']+', manage," $MW/routes/interviews/resume.ts 2 "both writes gated on it"
  need "interview_resumes" schema/interviews_schema.sql "the résumé table is in the schema"
  # Only ResumeViewer imports the pdf viewer and its worker.
  if grep -rlE "pdfWorker|PdfViewer|pdfjs-dist" portal/src --include='*.ts' --include='*.tsx' | grep -vE "pdfWorker(Url)?\.d?\.?ts$|ResumeViewer\.tsx$" | grep -q .; then fail "something but ResumeViewer imports the pdf viewer"; else ok "only ResumeViewer imports the pdf viewer"; fi
  for id in interviews-resume-viewer interviews-resume-upload interviews-resume-remove interviews-resume-facts interviews-profile-resume-section; do
    if grep -rqF "$id" $PAGES; then ok "test id $id"; else fail "test id $id is gone from the pages"; fi
  done
  refuses_404 I1.6
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the résumé rules, both stores and the four routes" \
      src/lib/interviews/resume src/routes/__tests__/interviews-resume.test.ts
    run_journey
    for s in I1.6a I1.6b I1.6c I1.6d I1.6e; do journey_step "$s"; done
  fi
}

built_row I1.6 row_I1.6
