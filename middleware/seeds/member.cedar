// Member: rank-and-file IC. Can search and view org chart at a high level.
// Cannot view sensitive HR data, leaderboards, or any admin surface.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"LabelFeedback"
  ],
  resource
)
when { principal.role == "member" };

// Members can never approve transactions, even if some future broader permit
// rule would otherwise grant it. Explicit forbid wins under Cedar evaluation.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "member" };
