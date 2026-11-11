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
  ComputeProvider, installMockShellSocket, createComputeClient,
  type ComputeNotice, type ComputeProject,
} from '@connorhoehn/ui-components/compute';
import { withLocalMachines } from './localMachines';
import { labPaneKinds } from './localMachines.tsx';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { canOpenComputerLab } from '../../lib/devboxAccess';
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
  const { session } = useSession();
  // DRIVING the lab — provision, rename, stop, remove — is OperateDevbox, the
  // lab's drive split out of ManageDevbox on 11 November 2026 so a leader who
  // dispatches runs can drive a lab computer by hand; the library has one prop
  // for all of its mutating controls, and this is it. ManageDevbox (codebases,
  // capability writes, session bundles) and the shell stay with the operators.
  const canManage = ready && can('OperateDevbox');
  // READING the fleet and DRIVING it are different rights, and this file used
  // to conflate them. `/api/devbox` mounts
  // `readForRolesElseAction(['org-leader','hr-admin','program-owner'],
  // devboxWriteAction)` — a deliberate read tier on top of the write gates —
  // so the "it would be a 403 every poll" premise below is true only of roles
  // outside BOTH. Gating the poll on the write capability meant the lab
  // rendered "0 computers · Provision at least one" for precisely the roles the
  // server was willing to serve, including org-leader, which
  // devbox-visibility.ts treats as FLEET_WIDE and shows every computer.
  // Same conflation, one layer down, as the nav gate fixed in a257bf3.
  const canReadFleet = ready && canOpenComputerLab(canManage, session?.role);
  const visible = useIsDocumentVisible();
  // A backgrounded tab has no dock to glance at, so pause the fleet poll
  // there too — same reasoning as `enabled={canManage}` below, just gated on
  // a different reason to skip fetching.
  const pollEnabled = canReadFleet && visible;

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
  // Skipped entirely without the drive: charging a computer to an initiative
  // is part of provisioning it (POST /boxes, OperateDevbox), so a viewer who
  // cannot provision has nothing to charge and no reason to ask.
  const { data: orgProjects } = useFetch<OrgProject[]>(canManage ? '/api/graph/projects' : null);

  // Budgets ride a SEPARATE fetch rather than joining server-side, on purpose:
  // /api/graph/projects and /api/budgets are gated differently, so a caller
  // who can see the fleet may legitimately have no business reading the money.
  // The merge below no-ops when it is absent — a computer without a cost
  // centre still renders.
  //
  // Asked for only where it will be answered. This used to ride `canManage`
  // (ManageDevbox) with the reasoning that a 403 is harmless: `data` stays
  // null and the merge no-ops. It is harmless to the render and not harmless
  // to watch — ComputeHost is mounted above the router, so an SME (who holds
  // ManageDevbox and not the budgets tier) fired a request that could only be
  // refused on EVERY page, and their devtools showed a 403 everywhere they
  // went. The condition mirrors `budgetsRouter`'s own read gate
  // (readForRolesElseAction([...], 'ManageBudgets')), the same way
  // pages/projects/SprintsLens.tsx spells that tier out for `scope=all`. The
  // server is still the enforcement point; this only decides whether asking
  // is worth anyone's time.
  const role = session?.role;
  const canReadBudgets = ready && (can('ManageBudgets')
    || role === 'org-leader' || role === 'hr-admin' || role === 'program-owner' || role === 'admin');
  const { data: budgetsRes } = useFetch<BudgetsResponse>(
    canManage && canReadBudgets ? '/api/budgets' : null);
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

  // One transport for both kinds of computer. `client` overrides
  // `clientOptions`, so the reference client is built here and wrapped — see
  // localMachines.tsx for why the machines ride the same list rather than a
  // second poller. Memoized on `clientOptions`' identity for exactly the
  // reason spelled out above it: a new client per render is read as "the
  // transport changed" and re-fires every poll.
  const client = useMemo(() => withLocalMachines(createComputeClient(clientOptions)), [clientOptions]);

  // The library's own kinds, with the DEFAULT one taught to tell a laptop from
  // a microVM — see localMachines.tsx for why this cannot be a second kind —
  // and not to attach a shell the session's capabilities already refuse.
  // Attaching is POST /api/devbox/:sid/shell-url, which asks OpenDevboxShell
  // (DE-42, devbox.ts:860) behind the mount's ManageDevbox — the shell is not
  // part of the drive, so both are asked here too: a leader who can provision
  // and hand work (OperateDevbox, RunDevboxTask) still gets no terminal.
  const canOpenShell = ready && can('ManageDevbox') && can('OpenDevboxShell');
  const paneKinds = useMemo(() => labPaneKinds(canOpenShell), [canOpenShell]);

  return (
    <ComputeProvider
      client={client}
      paneKinds={paneKinds}
      canManage={canManage}
      // This provider polls on a timer for every user on every page, and every
      // route under it is gated (the read tier, else a Cedar action) — without
      // this it would be a 403 every poll for anyone outside the tier, invisible in
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
