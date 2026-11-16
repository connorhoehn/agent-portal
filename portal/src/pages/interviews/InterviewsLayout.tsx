// The interviews tenant's route parent (docs/interviews-tenant-plan.md "Pages").
//
// Bare, on purpose, like AccessLayout and PipelinesLayout: the tenant's
// hierarchy is the shell rail (NAV_ITEMS in components/shell/Layout.tsx,
// grouped Hire / Interview), so there is no second rail inside the page and
// the shell draws the trail as the content column's first row
// (docs/layout-cascade.md rules 1–2). App.tsx wraps this in
// `RequireTenant tenant="interviews"`.

import { Outlet } from 'react-router';

export default function InterviewsLayout() {
  return <Outlet />;
}
