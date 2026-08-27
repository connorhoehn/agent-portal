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
