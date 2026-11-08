// Community admin: owns the social tenant end to end. Everything a moderator
// can do, plus the tenant's configuration and its users. No forbids of its
// own — the top of the social role ladder, one step below the cross-tenant
// admin. Scoped to the social tenant (docs/social-tenant-design.md §4.1).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewSocial",
    OrgIQ::Action::"PostMessage",
    OrgIQ::Action::"StartCall",
    OrgIQ::Action::"ManageChannels",
    OrgIQ::Action::"ManageTeams",
    OrgIQ::Action::"ManageRecordings",
    OrgIQ::Action::"ManageSocialConfig",
    OrgIQ::Action::"ManageUsers",
    // Mint a voice navigator session (docs/voice-navigator-spec.md §6). Each tool the
    // voice runs is then gated by the action of the button it stands in for.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "community-admin" && principal has tenant && principal.tenant == "social" };
