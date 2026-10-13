// The access tenant's route parent (docs/access-tenant-design.md §6).
//
// Bare, on purpose, exactly like PipelinesLayout: the tenant's hierarchy is the
// shell rail (NAV_ITEMS in components/shell/Layout.tsx, grouped Request /
// Approve / Govern / System), so there is no second rail inside the page and
// the shell draws the trail as the content column's first row
// (docs/layout-cascade.md rules 1–2). App.tsx wraps this in
// `RequireTenant tenant="access"`.

import { Outlet } from 'react-router';

export default function AccessLayout() {
  return <Outlet />;
}
