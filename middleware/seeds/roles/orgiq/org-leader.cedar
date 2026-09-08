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
    OrgIQ::Action::"ManageSprints",
    // Reach a deployed environment, and describe the estate. A leader who
    // allocates the spend an initiative burns is accountable for where it runs,
    // so both the reachability and the record are theirs. ManageEnvironments is
    // the narrow write half of the domain — the read half is open to any
    // signed-in member, since an environment row holds no secret.
    OrgIQ::Action::"EnterEnvironment",
    OrgIQ::Action::"ManageEnvironments",
    // Pair their own machine as a local presence node (see member.cedar for
    // why this is personal, not fleet, authority).
    OrgIQ::Action::"ConnectLocalCompute"
  ],
  resource
)
when { principal.role == "org-leader" && principal has tenant && principal.tenant == "orgiq" };

// A retired environment is not reachable — see sme.cedar for why, and for how
// the attribute condition works.
forbid (
  principal,
  action == OrgIQ::Action::"EnterEnvironment",
  resource
)
when { principal.role == "org-leader" && resource has envStatus && resource.envStatus == "retired" };

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
