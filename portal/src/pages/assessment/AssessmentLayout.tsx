// The assessment tenant's route parent — and nothing more.
//
// This used to render a SubNavLayout with the Assess / Analyze / Informatics /
// System groups inside the page, beneath a shell rail that showed one
// "Assessment" entry. Two navs for one product. The tenant's hierarchy now IS
// the shell rail (see NAV_ITEMS in components/shell/Layout.tsx), the way the
// source app's sidebar is its only navigation, so this parent just mounts the
// child route.

import { Outlet } from 'react-router';

export default function AssessmentLayout() {
  return <Outlet />;
}
