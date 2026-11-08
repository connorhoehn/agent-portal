// SME: subject-matter expert attached to initiatives. Everything a member can
// do, plus dispatching agent work — an SME spends the budget envelope a
// release manager granted them by assigning compute (bots, marketplace runs)
// to work items on their initiatives. They do not manage budgets, bots'
// standing missions, or any admin surface.
// Scoped to the orgiq tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"LabelFeedback",
    // Read the work board and write discussion on it (docs/next-steps.md §9
    // item 8d). A comment is discussion, not a state change: the route asks
    // this plus membership of the item's initiative (owner, contributor, or
    // an org-wide role); sprint, owner and status writes keep their own gates.
    OrgIQ::Action::"ViewWorkItems",
    // The point of the role: assign computers to do the work.
    OrgIQ::Action::"DispatchAgentRun",
    // Stand up the mundane-work automations themselves — a bot built from a
    // predefined template (PR analysis, dependency watch) or a loop cron. The
    // envelope/allocation brakes on the dispatch pipeline still govern what a
    // bot may spend; this only lets the SME author the standing mission.
    OrgIQ::Action::"ManageBots",
    // Reaching the Computers surface at all. Role-wide, like ManageSprints and
    // for the same reason: Cedar answers "may an SME ever use a computer", and
    // the route layer (lib/devbox-visibility.ts) then answers "which ones" —
    // their own, plus the ones shared on initiatives they own or contribute
    // to. Without this the role could dispatch agent runs but never open the
    // shell those runs happen in, which is the contradiction this grant
    // removes.
    OrgIQ::Action::"ManageDevbox",
    // Sprints have a steward — the SME accountable for that iteration creates
    // it and moves work into it. Cedar grants the capability role-wide; the
    // route layer (routes/sprints.ts requireInitiativeSteward) then scopes an
    // SME's writes to initiatives they own or contribute to, so an SME cannot
    // create/move sprints on an initiative they have nothing to do with.
    OrgIQ::Action::"ManageSprints",
    // Reaching an environment. This is the role the environments domain exists
    // for: an SME spans several initiatives and is the person who has to get
    // into a cluster from a devbox and run a command against it. Every tier —
    // an SME who can only reach dev cannot do the job they are on call for.
    //
    // The grant is reachability only. Getting in still means assuming the
    // environment's access_role_arn, and IAM decides what that role may do.
    OrgIQ::Action::"EnterEnvironment",
    // Pair their own machine as a local presence node (see member.cedar for
    // why this is personal, not fleet, authority).
    OrgIQ::Action::"ConnectLocalCompute",
    // Read the session brief a run was given (GET /api/runs/:ref/brief, the work-item
    // brief preview). Every role that can see work can see what a box was told.
    OrgIQ::Action::"ViewSessionBrief",
    // Decide runbook proposals. Role-wide here; routes/runbooks.ts scopes it to the
    // runbook's owner or an SME on its initiative (lib/runbook-review.ts), with
    // org-leader and admin overriding.
    OrgIQ::Action::"ReviewRunbook",
    // Mint a voice navigator session (docs/voice-navigator-spec.md §6). Each tool the
    // voice runs is then gated by the action of the button it stands in for.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "sme" && principal has tenant && principal.tenant == "orgiq" };

// A retired environment is not reachable. It is recorded so a postmortem can
// ask where something used to run, not so somebody can shell into it.
//
// This is the attribute escape hatch in use: the environment's properties ride
// on the singleton resource (lib/authz.ts environmentAttrs), the same mechanism
// ApproveTransaction uses for `resource.amount > 10000`. A check that carries
// no attributes — the portal's capability probe, asking "could this role ever
// reach an environment" — does not match, and stays allowed.
forbid (
  principal,
  action == OrgIQ::Action::"EnterEnvironment",
  resource
)
when { principal.role == "sme" && resource has envStatus && resource.envStatus == "retired" };

// SMEs spend inside a granted envelope; they never approve transactions.
// Explicit forbid wins under Cedar evaluation.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "sme" };

// The agent-code authorities split out of ManageDevbox (DE-42). Same role as
// above, but scoped: an SME acts only where the route found them on the
// initiative (`onInitiative`: owner or contributor of the box's or change's
// initiative) or, for a box, its owner (`ownsBox`). The route computes both
// booleans and refuses first (403 NOT_ON_INITIATIVE), because the local
// open-mode matrix ignores `when` clauses; this is the production copy.
// RunDevboxTask accepts `ownsBox` too: an SME's own unattributed box takes
// tasks today, and the split must not take that away.
permit (
  principal,
  action in [
    OrgIQ::Action::"OpenDevboxShell",
    OrgIQ::Action::"RunDevboxTask"
  ],
  resource
)
when {
  principal.role == "sme" && principal has tenant && principal.tenant == "orgiq" &&
  ((resource has onInitiative && resource.onInitiative) || (resource has ownsBox && resource.ownsBox))
};

// Approve and ship agent-written code on the initiatives they are on. Policy
// editing (ManageSdlcPolicies) is deliberately absent: the gates constrain the
// SME, so the SME does not get to move them (DE-43).
permit (
  principal,
  action in [
    OrgIQ::Action::"DecideAgentChange",
    OrgIQ::Action::"DeliverAgentChange"
  ],
  resource
)
when {
  principal.role == "sme" && principal has tenant && principal.tenant == "orgiq" &&
  resource has onInitiative && resource.onInitiative
};

// Nobody but admin decides a change they caused (DE-43). The route compares
// the decider with the change's requested_by and answers 409 self-approval;
// this forbid is the production copy. The capability probe sends
// isAuthor: false so the control still shows.
forbid (
  principal,
  action == OrgIQ::Action::"DecideAgentChange",
  resource
)
when { resource has isAuthor && resource.isAuthor && principal.role != "admin" };
