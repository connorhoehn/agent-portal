// Hiring manager: reads their own openings and everything that hangs off them
// (candidates, rounds, results) and decides a candidate's next stage
// (docs/interviews-tenant-plan.md, decisions 2 and 15). "Their own openings"
// is a route rule (lib/interviews/scope.ts).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewInterviews",
    OrgIQ::Action::"DecideCandidate"
  ],
  resource
)
when { principal.role == "hiring-manager" && principal has tenant && principal.tenant == "interviews" };

// A hiring manager decides; they never manage candidates, assign rounds or
// conduct an interview in this role.
forbid (
  principal,
  action in [
    OrgIQ::Action::"ManageCandidates",
    OrgIQ::Action::"AssignInterviews",
    OrgIQ::Action::"ConductInterview"
  ],
  resource
)
when { principal.role == "hiring-manager" };
