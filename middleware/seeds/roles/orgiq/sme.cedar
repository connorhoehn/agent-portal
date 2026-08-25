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
    // The point of the role: assign computers to do the work.
    OrgIQ::Action::"DispatchAgentRun",
    // Sprints have a steward — the SME accountable for that iteration creates
    // it and moves work into it. Scoped to their initiatives at the route layer.
    OrgIQ::Action::"ManageSprints"
  ],
  resource
)
when { principal.role == "sme" && principal has tenant && principal.tenant == "orgiq" };

// SMEs spend inside a granted envelope; they never approve transactions.
// Explicit forbid wins under Cedar evaluation.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "sme" };
