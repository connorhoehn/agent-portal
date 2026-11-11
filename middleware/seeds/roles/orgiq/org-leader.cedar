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
    // Read the work board and write discussion on it (docs/next-steps.md §9
    // item 8d). A comment is discussion, not a state change: the route asks
    // this plus membership of the item's initiative (owner, contributor, or
    // an org-wide role); sprint, owner and status writes keep their own gates.
    OrgIQ::Action::"ViewWorkItems",
    OrgIQ::Action::"ManageCanary",
    // Dispatch agent runs against initiatives (bots, marketplace authorize).
    // Leaders direct agent work across the org the same way they approve the
    // spend it represents.
    OrgIQ::Action::"DispatchAgentRun",
    // Program management — allocating agent spend per initiative.
    OrgIQ::Action::"ManageBudgets",
    // Author standing missions too — the leader who allocates the spend can
    // set up the bots that burn it.
    OrgIQ::Action::"ManageBots",
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
    OrgIQ::Action::"ConnectLocalCompute",
    // Drive a lab computer by hand: start, rename, stop and remove one
    // (OperateDevbox) and hand it work (RunDevboxTask). A leader who dispatches
    // agent runs (DispatchAgentRun) already starts microVMs and hands them work
    // through the governed path; the lab is the by-hand form of that authority.
    // The lab's CONFIGURATION — linking codebases, capability writes, session
    // bundles — is ManageDevbox, which this role does not hold: DE-43 keeps the
    // policy editor (ManageSdlcPolicies, below) out of every ManageDevbox role,
    // and the shell (OpenDevboxShell) stays with the operators. Decided 11 Nov
    // 2026 (docs/next-steps.md, "Lane E5").
    OrgIQ::Action::"OperateDevbox",
    OrgIQ::Action::"RunDevboxTask",
    // Read the session brief a run was given (GET /api/runs/:ref/brief, the work-item
    // brief preview). Every role that can see work can see what a box was told.
    OrgIQ::Action::"ViewSessionBrief",
    // Decide runbook proposals. Role-wide here; routes/runbooks.ts scopes it to the
    // runbook's owner or an SME on its initiative (lib/runbook-review.ts), with
    // org-leader and admin overriding.
    OrgIQ::Action::"ReviewRunbook",
    // Change the SDLC policies that govern agent-written code (POST/DELETE
    // /api/sdlc/policies, PUT /api/sdlc/policy-sets/:scope) and approve a
    // second-person loosening. Held by org-leader and admin only, never by a
    // devbox operator, so nobody who runs the boxes moves the rules their own
    // runs are judged by (docs/next-steps.md §9 item 8b). Replaces
    // EditSdlcPolicy, which hr-admin held.
    OrgIQ::Action::"ManageSdlcPolicies",
    // Edit the Bedrock guardrail (PII filters, denied topics). The guardrail
    // editor is open to org-leader, hr-admin and admin (§9 item 8c); everyone
    // with ViewObservability keeps the read-only detail view.
    OrgIQ::Action::"EditGuardrail",
    // Resolve or reject a waiting decision (G54, POST /api/graph/decisions/:id/decide).
    // Role-wide, because anyone can be named a decision's decider; the route
    // scopes it to the decider and the initiative's owner, with org-leader and
    // admin overriding (`decidesThis`, the forbid in member.cedar).
    OrgIQ::Action::"DecideDecision",
    // Mint a voice navigator session (docs/voice-navigator-spec.md §6). Each tool the
    // voice runs is then gated by the action of the button it stands in for.
    OrgIQ::Action::"VoiceNavigate"
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
