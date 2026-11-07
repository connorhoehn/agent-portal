// admin_break_glass — the cross-tenant platform operator.
//
// Full access in whatever tenant the session is parked in, and the only role
// granted Masquerade. Deliberately NOT tenant-conditioned: `admin` is the one
// cross-tenant role (tenants/manifest.json crossTenantRoles), so a condition
// tying the principal's tenant to the resource's would break it by design.
// The Cedar resource is the singleton Application "app" and carries no
// tenant; the tenant boundary is requireTenant() in lib/authz.ts, which admin
// passes for every tenant (docs/next-steps.md §8 work item 22).
//
// Because it is break-glass, using it outside the session's own tenant is
// never silent: requireTenant emits an `AdminCrossTenant` authz event and an
// `audit-alert` line (lib/audit.ts alertAdminCrossTenant) when an admin enters
// another tenant's routes, at most once a minute per admin and tenant pair.
// The database side reads every tenant for admin too (app.tenant = '*',
// schema/row_level_security.sql).
//
// Cedar forbids still win: admin cannot ApproveTransaction while masquerading
// as a member, because the member forbid matches on principal.role.
permit (
  principal,
  action,
  resource
)
when { principal.role == "admin" };
