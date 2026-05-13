// Passthrough wrapper for the Harness sub-section. The parent
// ObservabilityLayout already provides the section nav rail, so this is
// purely a route nesting hook for /observability/harness and its children.

import { Outlet } from 'react-router';

function HarnessLayout() {
  return <Outlet />;
}

export default HarnessLayout;
