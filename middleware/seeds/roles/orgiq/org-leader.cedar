// OrgLeader: VPs/Directors. Full org visibility incl. expertise leaderboards.
// Still blocked from salary/performance reviews and admin surfaces.
// Scoped to the orgiq tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewLeaderboard",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"LabelFeedback",
    OrgIQ::Action::"ManageCanary",
    // Dispatch agent runs against initiatives (bots, marketplace authorize).
    // Leaders direct agent work across the org the same way they approve the
    // spend it represents.
    OrgIQ::Action::"DispatchAgentRun",
    // Program management — allocating agent spend per initiative.
    OrgIQ::Action::"ManageBudgets",
    // Run the program cadence — create sprints and move work between them.
    // The release manager owns the iteration calendar for the initiative.
    OrgIQ::Action::"ManageSprints"
  ],
  resource
)
when { principal.role == "org-leader" && principal has tenant && principal.tenant == "orgiq" };

// Org leaders are the only role allowed to approve human-in-the-loop
// transaction requests, and only when the resource amount exceeds the
// $10,000 threshold (below that, transactions auto-approve in the agent layer
// and never reach the approval queue at all).
permit (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "org-leader" && principal has tenant && principal.tenant == "orgiq" && resource has amount && resource.amount > 10000 };
