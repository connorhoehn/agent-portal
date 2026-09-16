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

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ComputeProvider, installMockShellSocket,
  type ComputeNotice, type ComputeProject,
} from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { isDocumentHidden } from '../../hooks/pollSchedule';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { toastError, toastInfo, toastSuccess } from '../../lib/toastStore';

const IS_DEV = !!(import.meta as unknown as { env?: Record<string, unknown> }).env?.['DEV'];

// Glanceable header-chip cadence, not a terminal-grade one — the dock/palette
// only need to know a computer exists and roughly what it's doing. The
// library's own default (pollIntervalMs 5000) was fine in isolation, but see
// the `clientOptions` note below for why it was firing far hotter than that
// in practice.
const FLEET_POLL_MS = 15_000;

/** Tab visibility, so the fleet poll can pause in a background tab. */
function useIsDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !isDocumentHidden());
  useEffect(() => {
    const onChange = () => setVisible(!isDocumentHidden());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** /api/graph/projects, narrowed to what a cost centre needs. */
interface OrgProject {
  id: string;
  name: string;
}

/**
 * /api/budgets response, narrowed to the rollup fields a cost centre needs.
 * Mirrors middleware's `BudgetRow` (providers/budgets.ts) — see that file for
 * the full shape and the "allocatedUsd: null means spending with no
 * allocation" note. `runCountThisPeriod` stands in for `botCount`: budgets
 * has no per-initiative automation count of its own, and a run count is the
 * closest honest proxy already riding this same response, rather than
 * standing up a second endpoint just for a number this page treats as
 * decoration.
 */
interface BudgetRow {
  orgProjectId: string;
  allocatedUsd: number | null;
  spentThisPeriodUsd: number;
  maintenanceUsd: number;
  runCountThisPeriod: number;
}
interface BudgetsResponse {
  budgets: BudgetRow[];
}

function notify(notice: ComputeNotice): void {
  if (notice.tone === 'error') { toastError(null, notice.title, notice.detail); return; }
  if (notice.tone === 'success') { toastSuccess(null, notice.title, notice.detail); return; }
  toastInfo(notice.title, notice.detail);
}

export function ComputeHost({ children }: { children: ReactNode }) {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const visible = useIsDocumentVisible();
  // A backgrounded tab has no dock to glance at, so pause the fleet poll
  // there too — same reasoning as `enabled={canManage}` below, just gated on
  // a different reason to skip fetching.
  const pollEnabled = canManage && visible;

  // `clientOptions` MUST be a stable reference. The library memoizes its
  // client on this prop's identity (`useMemo(() => client ?? createClient(
  // clientOptions), [client, clientOptions])`), and an inline object literal
  // here recreated a NEW client on every ComputeHost render — which the
  // library reads as "the transport changed", tearing down and immediately
  // re-firing BOTH the fleet poll (`GET /boxes`) and the one-shot runtime
  // probe (`GET /status`) together. That is the "devbox/boxes + devbox/status
  // paired, far hotter than the 5s default" behavior the shell-baseline audit
  // measured — not a second poller, one client being reborn on every render.
  const clientOptions = useMemo(
    () => ({ baseUrl: '/api/devbox', credentials: 'include' as const }),
    [],
  );

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

  // Budgets ride a SEPARATE fetch rather than joining server-side, on purpose:
  // /api/graph/projects and /api/budgets are gated differently (budgets reads
  // are org-leader/hr-admin/ManageBudgets, not ManageDevbox), so a caller who
  // can see the fleet may legitimately get nothing back here — the fetch just
  // 403s, `data` stays null, and the merge below no-ops instead of the whole
  // project list failing to load over one field it didn't have permission
  // for anyway. Gating this fetch on canManage rather than a budgets-specific
  // check keeps the Computer Lab's ask simple ("give me what you have"); the
  // server, not this component, is the enforcement point.
  const { data: budgetsRes } = useFetch<BudgetsResponse>(canManage ? '/api/budgets' : null);
  const budgetsById = useMemo(() => {
    const m = new Map<string, BudgetRow>();
    for (const b of budgetsRes?.budgets ?? []) m.set(b.orgProjectId, b);
    return m;
  }, [budgetsRes]);

  const projects = useMemo<ComputeProject[]>(
    () => (orgProjects ?? []).map((p) => {
      const b = budgetsById.get(p.id);
      if (!b) return { id: p.id, name: p.name };
      return {
        id: p.id,
        name: p.name,
        // null allocatedUsd (spending with no allocation) stays absent here
        // too — a confident 0 would read as "budgeted to nothing" instead of
        // "nobody set a budget".
        ...(b.allocatedUsd != null ? { budgetUsd: b.allocatedUsd } : {}),
        spentUsd: b.spentThisPeriodUsd,
        maintenanceUsd: b.maintenanceUsd,
        botCount: b.runCountThisPeriod,
      };
    }),
    [orgProjects, budgetsById],
  );

  return (
    <ComputeProvider
      clientOptions={clientOptions}
      canManage={canManage}
      // This provider polls on a timer for every user on every page, and every
      // route under it is ManageDevbox-gated — without this it would be a 403
      // every poll for anyone who lacks the capability, invisible in
      // development because the developer always has it. Also paused while
      // the tab is backgrounded — see `pollEnabled` above.
      enabled={pollEnabled}
      pollIntervalMs={FLEET_POLL_MS}
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
