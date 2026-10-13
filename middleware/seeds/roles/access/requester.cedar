// Requester: browses the access catalog and requests access for themselves.
// Scoped to the access tenant (docs/access-tenant-goal.md §Cedar).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewAccess",
    OrgIQ::Action::"RequestAccess"
  ],
  resource
)
when { principal.role == "requester" && principal has tenant && principal.tenant == "access" };

// Separation of duties: a requester never decides a request, never edits the
// catalog or the SoD policies, and never writes a grant by hand.
forbid (
  principal,
  action in [
    OrgIQ::Action::"DecideAccess",
    OrgIQ::Action::"ManageAccessCatalog",
    OrgIQ::Action::"ManageAccessPolicy",
    OrgIQ::Action::"ProvisionAccess"
  ],
  resource
)
when { principal.role == "requester" };
