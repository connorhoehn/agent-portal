// Member: rank-and-file IC. Can search and view org chart at a high level.
// Cannot view sensitive HR data, leaderboards, or any admin surface.
permit (
  principal,
  action in [OrgIQ::Action::"Search", OrgIQ::Action::"ViewOrgChart"],
  resource
)
when { principal.role == "member" };
