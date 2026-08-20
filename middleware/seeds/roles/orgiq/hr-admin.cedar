// HRAdmin: People Ops. Sees everything (incl. salary/performance) and is the
// only tenant role that can edit guardrails / authorization policies. HR can
// label agent-output feedback for evaluator training, but cannot approve
// transactions (that authority belongs to org leaders only).
// Scoped to the orgiq tenant.
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
    OrgIQ::Action::"LabelFeedback",
    OrgIQ::Action::"ManageIngest",
    OrgIQ::Action::"ManageCanary",
    OrgIQ::Action::"ManageKB",
    OrgIQ::Action::"ManageDevbox",
    OrgIQ::Action::"ManageUsers"
  ],
  resource
)
when { principal.role == "hr-admin" && principal.tenant == "orgiq" };

// HR is explicitly NOT a transaction approver. Separation of duties.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "hr-admin" };
