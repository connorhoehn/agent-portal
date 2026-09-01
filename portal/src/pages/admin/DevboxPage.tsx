// Computers — the fleet of microVMs agents work in.
//
// This page was 825 lines of hand-rolled fleet list, task composer, workspace
// tree and terminal chrome. All of it now lives in
// `@connorhoehnslalom/ui-components/compute`, which is where it belongs: a pane
// tree with geometry-based focus, the xterm lifecycle, the AgentCore shell
// framing, expiry meters and broadcast are library problems, and the library is
// the thing that gets tested and storybooked.
//
// What is left is what only this app can answer:
//
//   - the transport (`/api/devbox`, cookie-authenticated),
//   - who may mutate (`ManageDevbox`),
//   - the model catalogue this deployment actually runs,
//   - where a notice goes (the portal's toast store),
//   - which initiatives a computer can be charged to.
//
// Everything else is a prop.

import { useMemo } from 'react';
import { ErrorState } from '@connorhoehnslalom/ui-components/shared';
import {
  ComputeProvider,
  ComputerLab,
  type ComputeNotice,
  type ComputeProject,
} from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { toastError, toastInfo, toastSuccess } from '../../lib/toastStore';

/** /api/graph/projects, narrowed to what a cost centre needs. */
interface OrgProject {
  id: string;
  name: string;
}

function notify(notice: ComputeNotice): void {
  if (notice.tone === 'error') { toastError(null, notice.title, notice.detail); return; }
  if (notice.tone === 'success') { toastSuccess(null, notice.title, notice.detail); return; }
  toastInfo(notice.title, notice.detail);
}

export default function DevboxPage() {
  // Provisioning, renaming, removing and running all POST to /api/devbox, which
  // index.ts gates on ManageDevbox. Passed through so the library never renders
  // a mutating control on a guess.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  // Initiatives double as cost centres, and charging a computer to one shares
  // it with everyone attached to that initiative (middleware
  // lib/devbox-visibility.ts) — so this list is both "what can I bill" and
  // "who else will see this".
  const { data: orgProjects } = useFetch<OrgProject[]>('/api/graph/projects');
  const projects = useMemo<ComputeProject[]>(
    () => (orgProjects ?? []).map((p) => ({ id: p.id, name: p.name })),
    [orgProjects],
  );

  if (ready && !canManage) {
    return (
      <ErrorState
        title="No computers here"
        body="Reaching a computer needs the ManageDevbox capability. An SME gets their own and their initiatives'; ask a platform operator if you expected one."
      />
    );
  }

  return (
    <ComputeProvider
      clientOptions={{ baseUrl: '/api/devbox', credentials: 'include' }}
      canManage={canManage}
      // The whole router is ManageDevbox-gated, so a viewer without it would
      // poll a 403 every five seconds. Off rather than noisy.
      enabled={canManage}
      // Real fleet only. Fixtures are for stories; a sample computer here would
      // be indistinguishable from a real one you simply could not connect to.
      useFixtures={false}
      models={DEVBOX_MODELS}
      projects={projects}
      onNotify={notify}
    >
      {/*
        The lab IS the page, not a mode you enter from it. The old page put a
        fleet list in front of the work and made the terminal the thing you
        opened afterwards, which is backwards for a surface whose entire purpose
        is having several shells open at once. `onClose` is a no-op here for the
        same reason: there is nothing behind it to return to.
      */}
      <ComputerLab open onClose={() => {}} />
    </ComputeProvider>
  );
}
