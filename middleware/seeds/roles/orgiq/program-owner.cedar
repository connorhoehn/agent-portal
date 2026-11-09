// ProgramOwner: the solution/program owner — a PM who runs the delivery
// program across initiatives. Sits between an SME (who spends an envelope on
// one initiative's work) and the release manager / org-leader: a program
// owner reads the whole board, runs the cadence, stands up the automations,
// AND allocates the per-initiative budget they are accountable for — the
// same allocation authority hr-admin and org-leader hold. Only transaction
// approval and the admin surface stay closed to this role.
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
    // Direct agent work across the program — same authority an SME exercises
    // per-initiative; the route-layer grant scoping still applies to spend.
    OrgIQ::Action::"DispatchAgentRun",
    // Run the iteration calendar: create sprints, move work between them.
    OrgIQ::Action::"ManageSprints",
    // Stand up bots from predefined templates / loop crons — the mundane-work
    // automations (PR analysis, dependency watch) are the program owner's to
    // configure. Budget brakes on the dispatch pipeline still govern spend.
    OrgIQ::Action::"ManageBots",
    // Set the monthly allocation per initiative — the program owner runs the
    // delivery program, so they are exactly who should be setting its ceiling.
    // Only on initiatives they own: see the forbid at the end of this file.
    OrgIQ::Action::"ManageBudgets",
    // Read the session brief a run was given (GET /api/runs/:ref/brief, the work-item
    // brief preview). Every role that can see work can see what a box was told.
    OrgIQ::Action::"ViewSessionBrief",
    // Decide runbook proposals. Role-wide here; routes/runbooks.ts scopes it to the
    // runbook's owner or an SME on its initiative (lib/runbook-review.ts), with
    // org-leader and admin overriding.
    OrgIQ::Action::"ReviewRunbook",
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
when { principal.role == "program-owner" && principal has tenant && principal.tenant == "orgiq" };

// A program owner sets the ceiling but never signs the cheque: they allocate
// the monthly budget above, and are still refused transaction approval, which
// belongs to org leaders alone. Saying they touch "no money at all" stopped
// being true the moment ManageBudgets was granted — separation of duties here
// is between ALLOCATING and APPROVING, not between money and no money.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "program-owner" };

// A program owner allocates only within the initiatives they own
// (docs/next-steps.md §9 item 8a): an initiative allocation, its run limits
// and its sprint envelopes (routes/budgets.ts, routes/grants.ts) send
// `ownsInitiative`, true when the caller's person is the initiative's owner.
// The route refuses first (403 NOT_INITIATIVE_OWNER), because the local seed
// matrix ignores `when` clauses; this is the production copy. A bare
// capability probe sends no attribute, so the budget controls still show and
// reads stay open.
forbid (
  principal,
  action == OrgIQ::Action::"ManageBudgets",
  resource
)
when { principal.role == "program-owner" && resource has ownsInitiative && !resource.ownsInitiative };
