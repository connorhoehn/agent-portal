// The shell owns the call runtime, playback and call log across navigation.
// Eligible authenticated shell sessions own the sole Social workspace
// presence announcement. Routes only read it; Settings keeps call and DM state.
import { Outlet } from 'react-router';

export default function SocialLayout() {
  return <Outlet />;
}
