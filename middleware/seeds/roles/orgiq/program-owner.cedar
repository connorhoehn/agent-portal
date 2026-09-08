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
    OrgIQ::Action::"ManageBudgets"
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
