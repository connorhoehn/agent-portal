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

// Inviting Milo into an interview, turning its voice on and adding time (row I3.2). Cedar says an interviewer may;
// the interview's Milo policy (lib/interviews/milo-policy.ts) then narrows it to the LEAD of that interview
// (decision 20). The recruiter and the hiring manager never hold it.
permit (
  principal,
  action == OrgIQ::Action::"InviteMeetingAssistant",
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
