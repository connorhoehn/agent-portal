// Approver: a requester who also decides the approval steps they are eligible
// for. Which steps those are is resolved live per request in the route
// (routes/access.ts) — Cedar cannot see request rows, so "never your own
// request" and "a step is decided once" are route rules with contract tests.
// Scoped to the access tenant (docs/access-tenant-goal.md §Cedar).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewAccess",
    OrgIQ::Action::"RequestAccess",
    OrgIQ::Action::"DecideAccess"
  ],
  resource
)
when { principal.role == "approver" && principal has tenant && principal.tenant == "access" };

// Separation of duties: an approver decides, never configures and never
// writes a grant by hand (the system provisions).
forbid (
  principal,
  action in [
    OrgIQ::Action::"ManageAccessCatalog",
    OrgIQ::Action::"ManageAccessPolicy",
    OrgIQ::Action::"ProvisionAccess"
  ],
  resource
)
when { principal.role == "approver" };
