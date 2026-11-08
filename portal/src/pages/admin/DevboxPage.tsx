// Computers — the fleet of microVMs agents work in.
//
// This page was 825 lines of hand-rolled fleet list, task composer, workspace
// tree and terminal chrome. All of it now lives in
// `@connorhoehn/ui-components/compute`: a pane tree with geometry-based
// focus, the xterm lifecycle, the AgentCore shell framing, expiry meters and
// broadcast are library problems, and the library is what gets tested and
// storybooked.
//
// The provider is not here — it is `ComputeHost`, mounted above the router in
// App.tsx, so a shell survives navigating away from this page and every other
// consumer of the fleet reads the same list.

import { useSearchParams } from 'react-router';
import { ErrorState, InlineAlert, Stack, VisuallyHidden } from '@connorhoehn/ui-components/shared';
import { ComputerLab } from '@connorhoehn/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { canOpenComputerLab } from '../../lib/devboxAccess';

export default function DevboxPage() {
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  // `?box=` is the deep link the rest of the app already writes — the "agent
  // working" chip on a work item, for one. The name is the old registry's and
  // stays: changing it would break links already rendered elsewhere for the
  // sake of a word only this file reads.
  const [params] = useSearchParams();
  const focusComputerId = params.get('box');

  // Reading the fleet and driving it are different rights, and this guard used
  // to conflate them: it short-circuited on the WRITE capability before any
  // fetch, so a leader who can legitimately see the fleet (the server's read
  // tier, and FLEET_WIDE_ROLES in devbox-visibility.ts) was shown a permission
  // wall instead of their computers. Writes are still refused by the API.
  const canRead = canOpenComputerLab(can('ManageDevbox'), session?.role);
  if (ready && !canRead) {
    return (
      <ErrorState
        title="No computers here"
        body="Reaching a computer needs computer access. An SME gets their own plus the ones shared on their initiatives; ask a platform operator if you expected one."
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
  // A reader without ManageDevbox can list the fleet but not attach a shell,
  // and the lab surfaces that refusal as a bare `error · Forbidden` in the
  // terminal pane — technically accurate, and indistinguishable from a broken
  // product. Name the boundary before they hit it, the same way the empty
  // state above names its cause rather than blaming permissions for an empty
  // fleet.
  // Since DE-42 the lab's two driving routes ask their own actions on top of
  // the mount's ManageDevbox: shell-url / command → OpenDevboxShell
  // (devbox.ts:737, :913), task (the Nudge bar) → RunDevboxTask (devbox.ts:710).
  // Read-only means the viewer can do neither.
  const readOnly = ready && !(can('ManageDevbox') && (can('OpenDevboxShell') || can('RunDevboxTask')));

  return (
    <Stack gap="none" className="h-full min-h-0">
      {/* The lab fills the viewport and owns its own chrome, so there is no
          PageSection title block here. That left this route (with
          Architecture) as the only one whose document outline had no `h1`:
          the breadcrumb is a nav landmark, not a heading. Hidden rather than
          drawn — the lab does not want a title bar above it. */}
      <VisuallyHidden as="h1">Computer Lab</VisuallyHidden>
      {readOnly && (
        <InlineAlert tone="info" className="mx-4 mt-3 mb-3">
          You can see the fleet but not drive it. Opening a shell or dispatching work
          needs computer access, which an SME or a platform operator can grant.
        </InlineAlert>
      )}
      {/* Paired machines are IN the lab now, not stacked above it. They used
          to render as their own band here while <ComputerLab> reported "0
          computers · nothing here" and told you to provision one — two
          machines on screen and the surface whose job is to show your machines
          claiming it had none. The band also squeezed the lab's rail until its
          section headings overlapped. They reach the lab through the fleet the
          ComputeProvider serves; see components/compute/localMachines.tsx. */}
      <Stack gap="none" className="min-h-0 flex-1">
        {/* `workspace`: status pills, + Computer and Keys in the lab's own
            header; a tabbed, numbered rail grouped by initiative; Shell / Bot
            logs / Agent panes; and a Nudge bar aimed at the focused pane, a
            selection or the whole fleet. `title={null}` because the shell's
            breadcrumb already names the page. Nudge needs no `onInstruct`:
            the library's default is a resumed task on each targeted box
            through this provider's client — POST /api/devbox/:sessionId/task,
            the RunDevboxTask-gated route (devbox.ts:710) the composer always used. */}
        <ComputerLab
          open
          variant="inline"
          appearance="workspace"
          title={null}
          onClose={() => {}}
          focusComputerId={focusComputerId}
        />
      </Stack>
    </Stack>
  );
}
