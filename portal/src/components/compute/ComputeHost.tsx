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

import { useEffect, useMemo, type ReactNode } from 'react';
import {
  ComputeProvider, installMockShellSocket,
  type ComputeNotice, type ComputeProject,
} from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { toastError, toastInfo, toastSuccess } from '../../lib/toastStore';

const IS_DEV = !!(import.meta as unknown as { env?: Record<string, unknown> }).env?.['DEV'];

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

  // Route `mock-shell:` sockets to the library's PTY simulator, in dev only.
  //
  // `npm run dev:mock` makes the middleware hand back a `mock-shell://` URL
  // rather than a presigned one, and without a simulator the browser just
  // fails to open it. Together they are what makes the Computers page
  // developable with no AWS: it is 80% terminal, and before this the terminal
  // was the one panel with no mock behind it — a 503 and a black rectangle
  // where the thing you were working on should have been.
  //
  // Guarded on DEV, so a production bundle never patches the global
  // WebSocket. The uninstall is refcounted by the library; returning it
  // matters because swapping the global and not putting it back would break
  // every other live surface on the page.
  //
  // Read through a cast for the same reason as GatewayStatusBadge: this repo
  // has no vite-env.d.ts, so `import.meta.env` is untyped.
  useEffect(() => {
    if (!IS_DEV) return;
    return installMockShellSocket();
  }, []);

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
