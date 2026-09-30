// The social tenant's route parent (docs/social-tenant-design.md §4).
//
// Bare, on purpose: the tenant's hierarchy is the shell rail (NAV_ITEMS in
// components/shell/Layout.tsx, grouped Talk / Meet / People / Library /
// System), exactly as the assessment tenant's is, so there is no second rail
// inside the page. App.tsx wraps this in `RequireTenant tenant="social"`.
// The call host joins it when calls land (lane S2).

import { Outlet } from 'react-router';

export default function SocialLayout() {
  return <Outlet />;
}
