// The pipelines tenant's route parent (docs/social-tenant-design.md §5).
//
// Bare, on purpose: the tenant's hierarchy is the shell rail (NAV_ITEMS in
// components/shell/Layout.tsx, grouped Catalog / Runs / Sources / System),
// exactly as the assessment tenant's is, so there is no second rail inside the
// page. App.tsx wraps this in `RequireTenant tenant="pipelines"`.

import { Outlet } from 'react-router';

export default function PipelinesLayout() {
  return <Outlet />;
}
