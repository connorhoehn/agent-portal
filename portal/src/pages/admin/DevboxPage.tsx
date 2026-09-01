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

import { useSearchParams } from 'react-router';
import { ErrorState } from '@connorhoehnslalom/ui-components/shared';
import { ComputerLab } from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';

export default function DevboxPage() {
  const { can, ready } = useCapabilities();
  // `?box=` is the deep link the rest of the app already writes — the "agent
  // working" chip on a work item, for one. The name is the old registry's and
  // stays: changing it would break links already rendered elsewhere for the
  // sake of a word only this file reads.
  const [params] = useSearchParams();
  const focusComputerId = params.get('box');

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
  // several shells open at once.
  //
  // `inline` rather than the default overlay: the lab fills the content column
  // and the portal keeps its rail, header and breadcrumbs, so Computers is a
  // place in the app instead of a thing that swallows it. The variant also
  // drops the modal semantics and the ✕ — see the prop's docs. `onClose` is a
  // no-op because inline never calls it.
  return (
    <ComputerLab
      open
      variant="inline"
      onClose={() => {}}
      focusComputerId={focusComputerId}
    />
  );
}
