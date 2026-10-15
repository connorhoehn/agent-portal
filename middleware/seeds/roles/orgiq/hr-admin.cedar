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
    OrgIQ::Action::"ManageBots",
    OrgIQ::Action::"ManageUsers",
    // Dispatch agent runs against initiatives (bots, marketplace authorize).
    // Held globally by hr-admin and org-leader; the middleware additionally
    // honors initiative-scoped owner/SME membership at the route layer.
    OrgIQ::Action::"DispatchAgentRun",
    // Program management — allocating agent spend per initiative.
    OrgIQ::Action::"ManageBudgets",
    // Keep the environment record straight — this is the administrative half of
    // the domain, and hr-admin already holds every other registry-editing
    // authority here. Note it is the RECORD, not the environment.
    OrgIQ::Action::"ManageEnvironments",
    // Pair their own machine as a local presence node (see member.cedar for
    // why this is personal, not fleet, authority).
    OrgIQ::Action::"ConnectLocalCompute",
    // Read the session brief a run was given (GET /api/runs/:ref/brief, the work-item
    // brief preview). Every role that can see work can see what a box was told.
    OrgIQ::Action::"ViewSessionBrief"
  ],
  resource
)
when { principal.role == "hr-admin" && principal has tenant && principal.tenant == "orgiq" };

// ...and explicitly not inside one. Being able to correct a cluster ARN in a
// table is not the same authority as assuming a role against that cluster, and
// People Ops has no reason to hold the second. Same separation-of-duties shape
// as the ApproveTransaction forbid below: whoever curates the record is not
// automatically whoever may act on what it describes.
forbid (
  principal,
  action == OrgIQ::Action::"EnterEnvironment",
  resource
)
when { principal.role == "hr-admin" };

// HR is explicitly NOT a transaction approver. Separation of duties.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "hr-admin" };
