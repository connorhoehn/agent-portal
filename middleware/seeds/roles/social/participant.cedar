// Participant: a member of the social tenant. Reads the tenant, posts in the
// channels and DMs they belong to, and starts or joins calls. Creating and
// moderating channels, teams and recordings is a moderator's call.
// Scoped to the social tenant (docs/social-tenant-design.md §4.1).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewSocial",
    OrgIQ::Action::"PostMessage",
    OrgIQ::Action::"StartCall"
  ],
  resource
)
when { principal.role == "participant" && principal has tenant && principal.tenant == "social" };

// Separation of duties: a participant never manages the spaces they post in —
// channels, teams and the recordings made in them are moderated by someone else.
forbid (
  principal,
  action in [
    OrgIQ::Action::"ManageChannels",
    OrgIQ::Action::"ManageTeams",
    OrgIQ::Action::"ManageRecordings"
  ],
  resource
)
when { principal.role == "participant" };
