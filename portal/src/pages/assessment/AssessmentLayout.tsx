// Calls and accepted document-invite navigation belong to authenticated
// Layout, so leaving assessment pages cannot unmount an active call.
import { Outlet } from 'react-router';

export default function AssessmentLayout() {
  return <Outlet />;
}
