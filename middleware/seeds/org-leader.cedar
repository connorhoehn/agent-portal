// OrgLeader: VPs/Directors. Full org visibility incl. expertise leaderboards.
// Still blocked from salary/performance reviews and admin surfaces.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewLeaderboard",
    OrgIQ::Action::"ViewObservability"
  ],
  resource
)
when { principal.role == "org-leader" };
