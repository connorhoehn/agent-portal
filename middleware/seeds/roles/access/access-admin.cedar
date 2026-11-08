// Access admin: an approver plus the catalog, the separation-of-duties
// policies, manual revoke / SoD override, and the tenant's users. No forbids
// of its own — the top of the access role ladder, one step below the
// cross-tenant admin. Scoped to the access tenant
// (docs/access-tenant-goal.md §Cedar).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewAccess",
    OrgIQ::Action::"RequestAccess",
    OrgIQ::Action::"DecideAccess",
    OrgIQ::Action::"ManageAccessCatalog",
    OrgIQ::Action::"ManageAccessPolicy",
    OrgIQ::Action::"ProvisionAccess",
    OrgIQ::Action::"ManageUsers",
    // Mint a voice navigator session: reads and navigation only in this tenant
    // (docs/voice-navigator-gaps.md Q1); each tool is gated by its own read's action.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "access-admin" && principal has tenant && principal.tenant == "access" };
