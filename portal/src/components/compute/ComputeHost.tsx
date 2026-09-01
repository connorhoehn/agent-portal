// The app's one ComputeProvider.
//
// Mounted above the router so a shell survives navigation — that is the whole
// reason the dock exists — and so anything that wants the fleet (the Computers
// page, the ⌘K palette, the ⌘I switcher, Codebases) reads ONE list rather than
// each polling its own. Two components disagreeing about whether a computer
// exists is the class of bug the old localStorage mirror produced.
//
// Everything here is the part only this app can answer: the transport, who may
// mutate, the model catalogue, where a notice goes, and which initiatives a
// computer can be charged to.

import { useMemo, type ReactNode } from 'react';
import { ComputeProvider, type ComputeNotice, type ComputeProject } from '@connorhoehnslalom/ui-components/compute';
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

export function ComputeHost({ children }: { children: ReactNode }) {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  // Initiatives double as cost centres, and charging a computer to one shares
  // it with everyone attached to that initiative (middleware
  // lib/devbox-visibility.ts) — so this list is both "what can I bill" and
  // "who else will see this".
  //
  // Skipped entirely without the capability: the whole /api/devbox router is
  // ManageDevbox-gated, so there is nothing to charge and no reason to ask.
  const { data: orgProjects } = useFetch<OrgProject[]>(canManage ? '/api/graph/projects' : null);
  const projects = useMemo<ComputeProject[]>(
    () => (orgProjects ?? []).map((p) => ({ id: p.id, name: p.name })),
    [orgProjects],
  );

  return (
    <ComputeProvider
      clientOptions={{ baseUrl: '/api/devbox', credentials: 'include' }}
      canManage={canManage}
      // This provider polls on a timer for every user on every page, and every
      // route under it is ManageDevbox-gated — without this it would be a 403
      // every five seconds for anyone who lacks the capability, invisible in
      // development because the developer always has it.
      enabled={canManage}
      // Real fleet only. Fixtures belong in stories; a sample computer here is
      // indistinguishable from a real one you simply cannot connect to.
      useFixtures={false}
      models={DEVBOX_MODELS}
      projects={projects}
      onNotify={notify}
    >
      {children}
    </ComputeProvider>
  );
}
