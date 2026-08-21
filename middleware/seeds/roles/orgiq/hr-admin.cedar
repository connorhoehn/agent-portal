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
    // RESERVED: ViewSalary / ViewPerformance are granted here but not yet
    // enforced by any route — the salary/performance data surface doesn't
    // exist in the service yet. They pre-declare the grant so the PEP is a
    // one-line add when those endpoints land; today they gate nothing.
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
    OrgIQ::Action::"ManageUsers",
    // Dispatch agent runs against initiatives (bots, marketplace authorize).
    // Held globally by hr-admin and org-leader; the middleware additionally
    // honors initiative-scoped owner/SME membership at the route layer.
    OrgIQ::Action::"DispatchAgentRun"
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
