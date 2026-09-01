// Computers — the fleet of microVMs agents work in.
//
// This page was 825 lines of hand-rolled fleet list, task composer, workspace
// tree and terminal chrome. All of it now lives in
// `@connorhoehnslalom/ui-components/compute`: a pane tree with geometry-based
// focus, the xterm lifecycle, the AgentCore shell framing, expiry meters and
// broadcast are library problems, and the library is what gets tested and
// storybooked.
//
// The provider is not here — it is `ComputeHost`, mounted above the router in
// App.tsx, so a shell survives navigating away from this page and every other
// consumer of the fleet reads the same list.

import { ErrorState } from '@connorhoehnslalom/ui-components/shared';
import { ComputerLab } from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';

export default function DevboxPage() {
  const { can, ready } = useCapabilities();

  if (ready && !can('ManageDevbox')) {
    return (
      <ErrorState
        title="No computers here"
        body="Reaching a computer needs the ManageDevbox capability. An SME gets their own plus the ones shared on their initiatives; ask a platform operator if you expected one."
      />
    );
  }

  // The lab IS the page, not a mode you enter from it. The old page put a fleet
  // list in front of the work and made the terminal the thing you opened
  // afterwards, which is backwards for a surface whose whole purpose is having
  // several shells open at once. `onClose` is a no-op for the same reason:
  // there is nothing behind it to return to.
  return <ComputerLab open onClose={() => {}} />;
}
