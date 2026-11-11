// Computers — every computer an agent can work on, in one list.
//
// A paired machine (your own laptop, running the worker) and a lab machine (one the platform
// starts for you) used to live on two pages with two row shapes. Here they share one: name, kind,
// state, what it is running, last seen. Each kind keeps its own actions: a paired machine can be
// paused, unpaired and handed work; a lab machine can be stopped and driven from its workspace.
//
// Nothing here is a new backend: the rows come from the two reads that already existed
// (GET /api/local-compute/nodes with its runs, and the lab's fleet from the app's ComputeProvider).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Banner, Button, Card, Chip, CloseIcon, CollectionToolbar, ConfirmDialog, DataTable, DetailSection,
  EmptyState, EntityCell, IconButton, Inline, InlineAlert, MetaLine, PauseCircleIcon, Stack, Switch, T, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { ComputerLab, useComputeOptional } from '@connorhoehn/ui-components/compute';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useNow } from '../../hooks/useNow';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { isLive } from '../local-compute/localComputeFormat';
import { LocalMachineDetail } from '../local-compute/LocalMachineDetail';
import { PairMachineDialog } from '../local-compute/PairMachineDialog';
import { RunLog } from '../local-compute/RunLog';
import { useLocalComputeStream } from '../local-compute/useLocalComputeStream';
import type { ComputeNode, RunRow } from '../local-compute/localComputeTypes';
import { runsListHref } from '../iq/runsModel';
import { computersCommandAdapter } from './computersCommands';
import { computerRows, filterComputers, KIND_LABEL, LOCAL_KEY_PREFIX, type ComputerRow, type KindFilter } from './computersModel';
import { READ_ONLY_REASON, refuseInstruction } from './devboxReadOnly';

const KIND_OPTIONS = [
  { value: '', label: 'All computers' },
  { value: 'local', label: KIND_LABEL.local },
  { value: 'lab', label: KIND_LABEL.lab },
];

export default function ComputersPage() {
  const { data: nodesData, error: nodesError, degraded: nodesDegraded, refresh: refreshNodes } = useFetch<{ nodes: ComputeNode[] }>('/api/local-compute/nodes', 15_000);
  const { data: runsData, error: runsError, degraded: runsDegraded, refresh: refreshRuns } = useFetch<{ runs: RunRow[] }>('/api/local-compute/runs', 15_000);
  const { can, ready } = useCapabilities();
  const canPair = ready && can('ConnectLocalCompute');
  const compute = useComputeOptional();
  const canDriveLab = !!compute?.canManage;
  const labReadOnly = ready && !(can('ManageDevbox') && (can('OpenDevboxShell') || can('RunDevboxTask')));

  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('computer');
  const selectedRunId = params.get('run');
  const setParam = (key: string, value: string | null) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [pairOpen, setPairOpen] = useState(false);
  const [pendingAccept, setPendingAccept] = useState<Record<string, boolean>>({});
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [unpairTarget, setUnpairTarget] = useState<ComputeNode | null>(null);
  const [unpairBusy, setUnpairBusy] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const nodes = useMemo(
    () => (nodesData?.nodes ?? []).map((n) => (n.id in pendingAccept ? { ...n, acceptJobs: pendingAccept[n.id]! } : n)),
    [nodesData, pendingAccept],
  );
  const runs = runsData?.runs ?? [];
  const nodesFailure = nodesError ?? nodesDegraded;
  const runsFailure = runsError ?? runsDegraded;

  const rows = useMemo(() => computerRows(nodes, runs, compute?.computers ?? []), [nodes, runs, compute?.computers]);
  const visible = useMemo(() => filterComputers(rows, { query, kind }), [rows, query, kind]);
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const selectedNode = selectedRow?.kind === 'local' ? nodes.find((n) => n.id === selectedRow.nodeId) ?? null : null;

  // The clock behind "last seen" and the run clocks: it ticks only while a run is in flight.
  const now = useNow(runs.some((r) => isLive(r.status)));
  const { connected: streamLive } = useLocalComputeStream({ onChange: () => { void refreshNodes(); void refreshRuns(); } });

  // A selected row's working area opens below the table; bring it into view so the click visibly does something.
  useEffect(() => {
    if (!selectedKey) return;
    const id = window.setTimeout(() => document.querySelector('[data-testid="computer-detail"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
    return () => window.clearTimeout(id);
  }, [selectedKey]);

  const refreshAll = () => { void refreshNodes(); void refreshRuns(); void compute?.refresh(); };

  const handleAcceptJobs = async (node: ComputeNode, acceptJobs: boolean) => {
    setAcceptError(null);
    setPendingAccept((prev) => ({ ...prev, [node.id]: acceptJobs }));
    const res = await writeJson<ComputeNode>(`/api/local-compute/nodes/${node.id}`, 'PATCH', { acceptJobs });
    if (!res.ok) setAcceptError(`Could not ${acceptJobs ? 'resume' : 'pause'} ${node.label}: ${res.error ?? 'request failed'}`);
    await refreshNodes();
    setPendingAccept((prev) => { const next = { ...prev }; delete next[node.id]; return next; });
  };

  // Unpair is a soft revoke server-side: the token dies at once, so the machine has to be paired
  // again to reconnect. Confirmed first, as before.
  const handleUnpair = async () => {
    if (!unpairTarget || unpairBusy) return;
    const node = unpairTarget;
    setUnpairBusy(node.id);
    const toastId = toastPending(`Unpairing ${node.label}…`);
    const res = await writeJson<{ ok: boolean }>(`/api/local-compute/nodes/${node.id}`, 'DELETE');
    setUnpairBusy(null);
    if (res.ok) {
      toastSuccess(toastId, `${node.label} unpaired`, 'Its token stopped working — pair it again to reconnect.');
      setUnpairTarget(null);
      if (selectedKey === `${LOCAL_KEY_PREFIX}${node.id}`) setParam('computer', null);
      await refreshNodes();
    } else {
      toastError(toastId, `Could not unpair ${node.label}`, res.error ?? 'request failed');
    }
  };

  const stopLab = async (row: ComputerRow) => {
    if (!compute || !row.sessionId || stopBusy) return;
    setStopBusy(row.key);
    try { await compute.stop(row.sessionId); await compute.refresh(); } catch (e) {
      toastError(null, `Could not stop ${row.name}`, e instanceof Error ? e.message : 'request failed');
    }
    setStopBusy(null);
  };

  const startLab = async () => {
    if (!compute || starting) return;
    setStarting(true);
    try {
      const created = await compute.create();
      setParam('computer', created.id);
    } catch (e) {
      toastError(null, 'Could not start a lab machine', e instanceof Error ? e.message : 'request failed');
    }
    setStarting(false);
  };

  const columns: DataTableColumn<ComputerRow>[] = [
    {
      key: 'name',
      header: 'Computer',
      render: (r) => <EntityCell label={r.name} className="min-w-0" />,
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (r) => <Chip tone={r.kind === 'local' ? 'info' : 'purple'} size="xs">{KIND_LABEL[r.kind]}</Chip>,
    },
    {
      key: 'state',
      header: 'State',
      render: (r) => <Chip tone={r.tone} size="xs" dot={r.live ? 'pulse' : 'static'}>{r.state}</Chip>,
    },
    {
      key: 'running',
      header: 'Running',
      render: (r) => <T size="sm" className="block max-w-[16rem] truncate" title={r.running}>{r.running}</T>,
    },
    {
      key: 'seen',
      header: 'Last seen',
      render: (r) => (r.lastSeen ? <MetaLine size="xs" aria-live="off" items={[relativeTime(r.lastSeen)]} /> : <MetaLine size="xs" tone="tertiary" items={['never']} />),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        if (r.kind === 'local') {
          const node = nodes.find((n) => n.id === r.nodeId);
          if (!node) return null;
          return (
            <Inline gap="xs" align="center" justify="end" wrap={false}>
              <Switch
                checked={node.acceptJobs}
                disabled={!canPair || node.id in pendingAccept}
                aria-label={`Accepting work on ${node.label}`}
                onChange={(v) => { void handleAcceptJobs(node, v); }}
              />
              {canPair && (
                <IconButton
                  size="sm"
                  icon={<CloseIcon />}
                  className="row-reveal"
                  disabled={unpairBusy === node.id}
                  onClick={(e) => { e.stopPropagation(); setUnpairTarget(node); }}
                  aria-label={`Unpair ${node.label}`}
                  title="Unpair"
                />
              )}
            </Inline>
          );
        }
        return canDriveLab && r.stoppable ? (
          <Inline gap="xs" align="center" justify="end" wrap={false}>
            <IconButton
              size="sm"
              icon={<PauseCircleIcon />}
              disabled={stopBusy === r.key}
              onClick={(e) => { e.stopPropagation(); void stopLab(r); }}
              aria-label={`Stop ${r.name}`}
              title={stopBusy === r.key ? 'Stopping…' : 'Stop'}
            />
          </Inline>
        ) : null;
      },
    },
  ];

  const adapter = computersCommandAdapter(visible, {
    setQuery, setKind, refresh: refreshAll, open: (key) => setParam('computer', key),
  });

  const headerActions = (
    <Inline gap="xs" align="center">
      <Button size="sm" variant="link" onClick={() => navigate(runsListHref({ executor: 'local' }))} data-testid="local-runs-link">Runs on your machines</Button>
      {canPair && <Button size="sm" variant="secondary" onClick={() => setPairOpen(true)}>Pair a machine</Button>}
      {canDriveLab && <Button size="sm" variant="primary" disabled={starting} onClick={() => { void startLab(); }}>{starting ? 'Starting…' : 'Start a lab machine'}</Button>}
    </Inline>
  );

  const labError = compute?.error ?? null;
  const nothingAtAll = !nodesFailure && rows.length === 0;

  return (
    <CollectionCommandPage
      data-testid="computers-page"
      title="Computers"
      description="Your paired machines and the lab's machines in one list. Hand either kind work, and start or stop what you are allowed to."
      headerActions={headerActions}
    >
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          {nodesFailure && (
            <UnavailableNotice error={nodesFailure} what="your paired machines" source="Paired machines are read from Aurora" onRetry={refreshNodes} />
          )}
          {labError && <InlineAlert tone="warning">The lab's machines could not be read ({labError}); the list below shows your paired machines only.</InlineAlert>}
          {acceptError && <Banner variant="error">{acceptError}</Banner>}

          {nothingAtAll ? (
            <EmptyState
              title="No computers yet"
              description={canPair
                ? 'Pair a machine and it appears here; the dialog gives you a code and the command to run on it.'
                : 'Pairing a machine needs machine-pairing access; ask a platform operator to pair one for you.'}
              {...(canPair ? { actionLabel: 'Pair a machine', onAction: () => setPairOpen(true) } : {})}
            />
          ) : (
            <>
              <CollectionToolbar
                label="Computer filters"
                search={{ value: query, onChange: setQuery, placeholder: 'Search by name, state or what it is running…', 'aria-label': 'Search computers' }}
                filters={[{ id: 'kind', label: 'Kind', value: kind, emptyValue: '', onChange: (v) => setKind(v as KindFilter), options: KIND_OPTIONS }]}
                summary={`${visible.length} of ${rows.length} computers`}
                onRefresh={refreshAll}
              />
              <DataTable<ComputerRow>
                data-testid="computers-table"
                data={visible}
                keyField={(r) => r.key}
                columns={columns}
                striped
                onRowClick={(r) => setParam('computer', r.key)}
                emptyMessage={rows.length > 0 ? 'No computer matches the search or kind.' : 'No computers.'}
              />
            </>
          )}

          {selectedRow?.kind === 'local' && selectedNode && (
            <DetailSection data-testid="computer-detail" title={selectedNode.label} hint={KIND_LABEL.local} actions={<Button size="sm" variant="ghost" onClick={() => setParam('computer', null)}>Close</Button>}>
              <LocalMachineDetail
                node={selectedNode}
                runs={runs}
                runsFailure={runsFailure}
                refreshRuns={() => { void refreshRuns(); }}
                now={now}
                streamLive={streamLive}
                onOpenRun={(id) => setParam('run', id)}
              />
            </DetailSection>
          )}

          {selectedRow?.kind === 'lab' && (
            <DetailSection data-testid="computer-detail" title={selectedRow.name} hint={KIND_LABEL.lab} actions={<Button size="sm" variant="ghost" onClick={() => setParam('computer', null)}>Close</Button>}>
              <Stack gap="sm">
                {labReadOnly && <InlineAlert tone="info">{READ_ONLY_REASON}</InlineAlert>}
                <Card padding="none" className="h-[34rem] min-h-0 overflow-hidden">
                  <ComputerLab
                    open
                    variant="inline"
                    appearance="workspace"
                    title={null}
                    onClose={() => {}}
                    focusComputerId={selectedRow.key}
                    {...(labReadOnly ? { onInstruct: refuseInstruction } : {})}
                  />
                </Card>
              </Stack>
            </DetailSection>
          )}

          {selectedRunId && (
            <DetailSection title="Log" actions={<Button variant="ghost" size="sm" onClick={() => setParam('run', null)}>Close</Button>}>
              {/* Keyed on the run id: RunLog's "have we reached done" state must not survive a switch of run. */}
              <RunLog key={selectedRunId} jobId={selectedRunId} />
            </DetailSection>
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>

      <PairMachineDialog open={pairOpen} onClose={() => setPairOpen(false)} onPaired={() => { void refreshNodes(); }} />
      <ConfirmDialog
        open={unpairTarget !== null}
        tone="destructive"
        title={unpairTarget ? `Unpair ${unpairTarget.label}?` : 'Unpair this machine?'}
        body="Its token stops working immediately — any worker running on it loses its connection, and you'll need to pair it again from this page to reconnect."
        confirmLabel={unpairTarget && unpairBusy === unpairTarget.id ? 'Unpairing…' : 'Unpair'}
        confirmDisabled={unpairTarget !== null && unpairBusy === unpairTarget.id}
        onConfirm={() => void handleUnpair()}
        onCancel={() => setUnpairTarget(null)}
      />
    </CollectionCommandPage>
  );
}
