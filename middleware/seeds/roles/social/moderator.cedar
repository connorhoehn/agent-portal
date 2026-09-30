// Moderator: everything a participant can do, plus managing the tenant's
// spaces — creating and archiving channels, curating teams, and deciding what
// happens to call recordings. Tenant-wide configuration (retention, who may
// start a room, integrations) stays the community admin's.
// Scoped to the social tenant (docs/social-tenant-design.md §4.1).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewSocial",
    OrgIQ::Action::"PostMessage",
    OrgIQ::Action::"StartCall",
    OrgIQ::Action::"ManageChannels",
    OrgIQ::Action::"ManageTeams",
    OrgIQ::Action::"ManageRecordings"
  ],
  resource
)
when { principal.role == "moderator" && principal has tenant && principal.tenant == "social" };

// The tenant's configuration is a community-admin decision, not a moderator one.
forbid (
  principal,
  action == OrgIQ::Action::"ManageSocialConfig",
  resource
)
when { principal.role == "moderator" };
