// Admin: cross-tenant platform operator. Full access in whatever tenant the
// session is parked in, and the only role granted Masquerade. Deliberately not
// tenant-conditioned — this is the break-glass / demo-driver identity.
// Cedar forbids still win: admin cannot ApproveTransaction while masquerading
// as a member, because the member forbid matches on principal.role.
permit (
  principal,
  action,
  resource
)
when { principal.role == "admin" };
