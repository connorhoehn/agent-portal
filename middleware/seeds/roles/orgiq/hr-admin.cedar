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
    // Read the work board and write discussion on it (docs/next-steps.md §9
    // item 8d). A comment is discussion, not a state change: the route asks
    // this plus membership of the item's initiative (owner, contributor, or
    // an org-wide role); sprint, owner and status writes keep their own gates.
    OrgIQ::Action::"ViewWorkItems",
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
    OrgIQ::Action::"ViewSessionBrief",
    // Mint a voice navigator session (docs/voice-navigator-spec.md §6). Each tool the
    // voice runs is then gated by the action of the button it stands in for.
    OrgIQ::Action::"VoiceNavigate"
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

// The agent-code authorities split out of ManageDevbox (DE-42). hr-admin held
// every one of them through ManageDevbox and keeps them: whether People Ops
// should lose shell and task is an open decision (DE-42), and the split must
// not narrow a role on its own. Org-wide, so no initiative condition; the
// route layer treats hr-admin as on every initiative. Editing the SDLC
// policies is NOT here: it is ManageSdlcPolicies (org-leader and admin),
// because hr-admin operates the boxes those policies govern
// (docs/next-steps.md §9 item 8b).
permit (
  principal,
  action in [
    OrgIQ::Action::"OpenDevboxShell",
    OrgIQ::Action::"RunDevboxTask",
    OrgIQ::Action::"DecideAgentChange",
    OrgIQ::Action::"DeliverAgentChange"
  ],
  resource
)
when { principal.role == "hr-admin" && principal has tenant && principal.tenant == "orgiq" };

// Nobody but admin decides a change they caused (DE-43); see sme.cedar.
forbid (
  principal,
  action == OrgIQ::Action::"DecideAgentChange",
  resource
)
when { resource has isAuthor && resource.isAuthor && principal.role != "admin" };
