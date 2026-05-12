// HRAdmin: People Ops. Sees everything (incl. salary/performance) and is the
// only role that can edit guardrails / authorization policies.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewLeaderboard",
    OrgIQ::Action::"ViewSalary",
    OrgIQ::Action::"ViewPerformance",
    OrgIQ::Action::"EditGuardrail",
    OrgIQ::Action::"EditPolicy",
    OrgIQ::Action::"EditSchema",
    OrgIQ::Action::"ViewIdentityAdmin",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"ManageIngest"
  ],
  resource
)
when { principal.role == "hr-admin" };
