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
    OrgIQ::Action::"LabelFeedback"
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
