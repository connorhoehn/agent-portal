// Member: rank-and-file IC. Can search and view org chart at a high level.
// Deliberately holds ViewObservability as an ALL-HANDS read — a member labels
// answer quality via LabelFeedback, which needs to see the answer/trace. The
// mutations that ride the observability read tier (invocation replay,
// calibration, memory writes) are separately gated on ManageCanary, so this
// read grant does not let a member spend or re-invoke agents. Still cannot view
// sensitive HR data, leaderboards, or any admin/write surface.
// Scoped to the orgiq tenant — the same session in another tenant gets nothing.
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
    // Pair their OWN machine as a presence node. This is personal, not fleet
    // authority: the routes bind every node to the pairing session's sub, and
    // a member only ever sees or manages their own machines. Dispatching work
    // TO a machine stays behind DispatchAgentRun, which members do not hold.
    OrgIQ::Action::"ConnectLocalCompute",
    // Read the session brief a run was given (GET /api/runs/:ref/brief, the work-item
    // brief preview). Every role that can see work can see what a box was told.
    OrgIQ::Action::"ViewSessionBrief",
    // Resolve or reject a waiting decision (G54, POST /api/graph/decisions/:id/decide).
    // Role-wide, because anyone can be named a decision's decider; the route
    // scopes it to the decider and the initiative's owner, with org-leader and
    // admin overriding (`decidesThis`, the forbid in member.cedar).
    OrgIQ::Action::"DecideDecision",
    // Mint a voice navigator session (docs/voice-navigator-spec.md §6). Each tool the
    // voice runs is then gated by the action of the button it stands in for.
    OrgIQ::Action::"VoiceNavigate",
    // Invite the call assistant (Nova) into a call you hold a seat in (POST /api/calls/:callId/assistant/invite).
    // Held by every orgiq role that may join a call; the route also needs the seat.
    OrgIQ::Action::"InviteMeetingAssistant"
  ],
  resource
)
when { principal.role == "member" && principal has tenant && principal.tenant == "orgiq" };

// Members can never approve transactions, even if some future broader permit
// rule would otherwise grant it. Explicit forbid wins under Cedar evaluation.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "member" };

// A member may SEE the environments an initiative runs on — the rows describe
// accounts, regions and role names, none of which are secret, and hiding the
// map from the people who work on the initiative buys nothing. A member may
// not REACH one: getting inside means assuming an IAM role against live
// infrastructure, and that authority belongs to the SMEs and leaders who are
// accountable for the initiative. Unconditional on the environment's tier —
// this is not "members get dev", it is "members get none".
forbid (
  principal,
  action == OrgIQ::Action::"EnterEnvironment",
  resource
)
when { principal.role == "member" };

// A decision is decided by its decider or its initiative's owner (G54). The
// route computes `decidesThis` and refuses first (403 NOT_DECIDER), because
// the local seed matrix ignores `when` clauses; this is the production copy,
// for every orgiq role but the org-leader, who overrides (admin is never
// matched: its role is not in the list). A bare capability probe sends no
// attribute, so the control's capability still answers.
forbid (
  principal,
  action == OrgIQ::Action::"DecideDecision",
  resource
)
when {
  resource has decidesThis && !resource.decidesThis &&
  ["member", "sme", "program-owner", "hr-admin"].contains(principal.role)
};
