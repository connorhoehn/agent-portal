// Interviewer: reads only the interviews assigned to them (and, through each,
// that candidate and the opening) and conducts them (docs/interviews-tenant-plan.md,
// decision 2). "Only their own" is a route rule (lib/interviews/scope.ts).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewInterviews",
    OrgIQ::Action::"ConductInterview"
  ],
  resource
)
when { principal.role == "interviewer" && principal has tenant && principal.tenant == "interviews" };

// An interviewer never manages candidates, assigns rounds or decides a stage.
forbid (
  principal,
  action in [
    OrgIQ::Action::"ManageCandidates",
    OrgIQ::Action::"AssignInterviews",
    OrgIQ::Action::"DecideCandidate"
  ],
  resource
)
when { principal.role == "interviewer" };
