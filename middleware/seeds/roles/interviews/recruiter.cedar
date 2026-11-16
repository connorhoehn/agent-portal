// Recruiter: owns openings, candidates, assignment and scheduling, and reads
// everything in the interviews tenant (docs/interviews-tenant-plan.md,
// decision 2). Which rows a role reads is a route rule (routes/interviews.ts,
// lib/interviews/scope.ts): Cedar cannot see interview rows.
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewInterviews",
    OrgIQ::Action::"ManageCandidates",
    OrgIQ::Action::"AssignInterviews"
  ],
  resource
)
when { principal.role == "recruiter" && principal has tenant && principal.tenant == "interviews" };

// A recruiter arranges interviews; they never conduct one or decide a
// candidate's stage (that is the hiring manager's).
forbid (
  principal,
  action in [
    OrgIQ::Action::"ConductInterview",
    OrgIQ::Action::"DecideCandidate"
  ],
  resource
)
when { principal.role == "recruiter" };
