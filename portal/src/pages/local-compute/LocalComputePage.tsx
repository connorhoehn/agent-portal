// Local Compute — hand work to your paired machines and tail what they're doing.
//
// The browser control the user asked for: "i should be able to route work to that
// online machine". A CONNECTED machine with no dispatch route is a status light,
// not a fleet participant.

import { useState, useEffect, useMemo } from 'react';
import {
  Banner,
  Button,
  Chip,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  DetailSection,
  EmptyState,
  EntityCell,
  Inline,
  InlinePlaceholder,
  MetaLine,
  SegmentedControl,
  useToastOptional,
  PageSection,
  Select,
  Stack,
  Switch,
  PresenceDot,
  Tabs,
  Toolbar,
  ToolbarLabel,
  ToolbarSeparator,
  T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { LogStream, type LogLine } from '@connorhoehnslalom/ui-components/shared';
import { Link as RouterLink } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { presenceChip } from '../../lib/statusTone';
import { usd } from '../../lib/format';
import { PairMachineDialog, WORKER_COMMAND } from './PairMachineDialog';
import { statusLabel, statusTone, truncate, when, isLive, elapsedLabel, type JobStatus } from './localComputeFormat';
import { useNow } from '../../hooks/useNow';
import { LiveJobCell } from './LiveJobCell';
import { MachineConnection, type MachineMetrics } from './MachineConnection';
import { useLocalComputeStream } from './useLocalComputeStream';

// ─── Wire shapes ─────────────────────────────────────────────────────────────

interface NodePresence {
  status: 'connected' | 'stale' | 'offline';
  lastSeenAt: string | null;
  sessions: Array<{
    id: string;
    harness?: string;
    intent?: string;
    model?: string;
  }>;
}

interface ComputeNode {
  id: string;
  label: string;
  platform: string | null;
  acceptJobs: boolean;
  localModels: string[];
  jobKinds: string[];
  maxConcurrency?: number;
  presence: NodePresence;
  /** What the worker last reported about the machine it runs on. Null until a
   *  worker new enough to send it has announced. */
  metrics?: MachineMetrics | null;
}

type MachineTab = 'lane' | 'hand' | 'activity' | 'connection';

interface RunRow {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  nodeId: string | null;
  nodeLabel: string | null;
  createdAt: string;
  claimedAt?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Retry context. `GET /runs` spreads the whole job, so these already ride
   *  the wire — they were simply never declared here, which is why a second
   *  attempt used to look identical to a first. */
  attempts?: number;
  maxAttempts?: number;
  result: { provider?: string; costUsd?: number; summary?: string } | null;
}

interface WorkSuggestion {
  id: string;
  title: string;
  reason: string;
  initiativeId: string;
  initiativeName: string;
  workItemId: string;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
}

interface BotRow {
  id: string;
  name: string;
  model: string;
  cronExpr: string | null;
  enabled: boolean;
  pausedReason: string | null;
  lastRunAt: string | null;
  repoFullName?: string | null;
}

/** How many rows the pick list shows — a hand, not a backlog. */
const PICK_LIMIT = 8;

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LocalComputePage() {
  const { data: nodesData, error: nodesError, degraded: nodesDegraded, refresh: refreshNodes } = useFetch<{ nodes: ComputeNode[] }>('/api/local-compute/nodes', 15_000);
  const { data: runsData, error: runsError, degraded: runsDegraded, refresh: refreshRuns } = useFetch<{ runs: RunRow[] }>('/api/local-compute/runs', 15_000);
  const { can, ready } = useCapabilities();
  const canDispatch = ready && can('ConnectLocalCompute');
  const canRunBots = ready && can('ManageBots');
  // The pick list: the same ranked work the Automate overview suggests, and
  // the bots this person may run. Fetched only for someone who may dispatch.
  const { data: suggestData } = useFetch<{ suggestions: WorkSuggestion[] }>(canDispatch ? '/api/work/suggestions' : null, 60_000);
  const { data: botsData } = useFetch<{ bots: BotRow[] }>(canDispatch && canRunBots ? '/api/bots' : null, 60_000);
  const [pick, setPick] = useState<'work' | 'bots'>('work');
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const toast = useToastOptional();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // The accept-jobs switch, while its PATCH is in flight: the row shows the
  // requested state immediately rather than the 15s-poll-old one, and a
  // failure snaps it back and says why. Keyed by node so two machines can be
  // flipped without one clobbering the other.
  const [pendingAccept, setPendingAccept] = useState<Record<string, boolean>>({});
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // The pairing door. Anyone who may hand a machine work may pair one
  // (ConnectLocalCompute gates both routes); everyone else sees the empty
  // state without a dead-end call to action.
  const [pairOpen, setPairOpen] = useState(false);
  // Unpair: the machine pending confirmation, and a busy lock keyed by its id
  // so a double-click (or a second row's dialog opening mid-request) cannot
  // fire two DELETEs for the same machine.
  const [unpairTarget, setUnpairTarget] = useState<ComputeNode | null>(null);
  const [unpairBusy, setUnpairBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<MachineTab>('lane');

  const nodes = useMemo(
    () => (nodesData?.nodes ?? []).map((n) => (
      n.id in pendingAccept ? { ...n, acceptJobs: pendingAccept[n.id]! } : n
    )),
    [nodesData, pendingAccept],
  );
  const runs = runsData?.runs ?? [];
  const nodesFailure = nodesError ?? nodesDegraded;
  const runsFailure = runsError ?? runsDegraded;

  // Auto-select the first connected machine
  useEffect(() => {
    if (!selectedNodeId && nodes.length > 0) {
      const connected = nodes.find((n) => n.presence.status === 'connected');
      setSelectedNodeId(connected?.id ?? nodes[0].id);
    }
  }, [nodes, selectedNodeId]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId), [nodes, selectedNodeId]);

  // "Switch it on before handing it work" has to be doable HERE: the paused
  // banner below used to point at a control that existed only on the wire
  // (PATCH /nodes/:id already took `acceptJobs`), so a freshly paired machine
  // was a dead end from the browser.
  const handleAcceptJobs = async (node: ComputeNode, acceptJobs: boolean) => {
    setAcceptError(null);
    setPendingAccept((prev) => ({ ...prev, [node.id]: acceptJobs }));
    const res = await writeJson<ComputeNode>(`/api/local-compute/nodes/${node.id}`, 'PATCH', { acceptJobs });
    if (!res.ok) {
      setAcceptError(`Could not ${acceptJobs ? 'resume' : 'pause'} ${node.label}: ${res.error ?? 'request failed'}`);
    }
    await refreshNodes();
    setPendingAccept((prev) => {
      const next = { ...prev };
      delete next[node.id];
      return next;
    });
  };

  // Unpair: a soft revoke server-side (providers/local-compute.ts
  // `revokeNode`) — the row stays for audit, but the token dies immediately,
  // so the machine has to be paired again to reconnect. Confirmed first: this
  // is the one action on this page that stops a worker mid-flight.
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
      if (selectedNodeId === node.id) setSelectedNodeId(null);
      await refreshNodes();
    } else {
      toastError(toastId, `Could not unpair ${node.label}`, res.error ?? 'request failed');
    }
  };

  // What this machine will pick up: queued or in-flight runs targeted at it,
  // plus untargeted ones in a kind it has registered for. Work reaches a
  // machine from the governed paths — a bot's schedule, an initiative's work
  // item — never from a free prompt typed here. The composer this replaced
  // let anyone hand "what is 10+10" to a machine with no budget, no grant and
  // no attribution, and then parked the answer in a review lane built for
  // code changes.
  const upNext = useMemo(() => {
    if (!selectedNode) return [] as RunRow[];
    return runs.filter((r) => (r.status === 'queued' || r.status === 'claimed' || r.status === 'running')
      && (r.nodeId === selectedNode.id || (r.nodeId === null && selectedNode.jobKinds.includes(r.kind))));
  }, [runs, selectedNode]);

  // The clock behind every elapsed label on this page. It ticks only while at
  // least one job is actually in flight — a page of settled runs re-renders
  // exactly as often as its polls, which is what the request-budget pass asked
  // for — and it pauses with the tab.
  const anythingLive = useMemo(() => runs.some((r) => isLive(r.status)), [runs]);
  const now = useNow(anythingLive);

  // Live push on top of the 15s poll. The stream carries presence transitions,
  // new metrics and job state changes for this owner's machines; when it drops
  // the poll underneath is still the floor, and the panel says which of the
  // two the reader is looking at rather than claiming "live" either way.
  const { connected: streamLive } = useLocalComputeStream({
    onChange: () => { void refreshNodes(); void refreshRuns(); },
  });

  // What the selected machine is doing, counted from the runs already on the
  // page rather than asked for separately.
  const machineJobs = useMemo(() => {
    const mine = selectedNode ? runs.filter((r) => r.nodeId === selectedNode.id) : [];
    const current = mine.find((r) => r.status === 'running') ?? mine.find((r) => r.status === 'claimed');
    return {
      running: mine.filter((r) => r.status === 'running').length,
      queued: mine.filter((r) => r.status === 'queued').length,
      failedRecently: mine.filter((r) => r.status === 'failed' || r.status === 'cancelled').length,
      currentTitle: current?.title ?? null,
      currentStatus: current?.status ?? null,
      currentSince: current?.startedAt ?? current?.claimedAt ?? current?.createdAt ?? null,
    };
  }, [runs, selectedNode]);

  const pickWork = (suggestData?.suggestions ?? []).slice(0, PICK_LIMIT);
  const pickBots = (botsData?.bots ?? []).filter((b) => b.enabled && !b.pausedReason).slice(0, PICK_LIMIT);

  // Hand the selected machine a work item or a bot's mission. Same route the
  // fleet uses for a targeted local job; the server keeps the governed checks
  // (grant-scoped for a work item, ManageBots for a bot) and the review rule
  // (a run with a repo is reviewed, one without lands in done).
  const send = async (origin: { workItemId: string } | { botId: string }, label: string) => {
    if (!selectedNode) return;
    const key = 'workItemId' in origin ? origin.workItemId : origin.botId;
    setSendError(null);
    setSending(key);
    const res = await writeJson<{ id: string }>(`/api/local-compute/nodes/${selectedNode.id}/work`, 'POST', origin);
    setSending(null);
    if (res.ok) {
      toast?.toast(`${label} queued for ${selectedNode.label}`, { type: 'success' });
      refreshRuns();
    } else {
      setSendError(res.error ?? `Could not hand ${label} to ${selectedNode.label}`);
    }
  };

  // Presence maps onto the library's three-state dot; `stale` is its "away".
  const presenceState = (status: ComputeNode['presence']['status']): 'online' | 'away' | 'offline' =>
    status === 'connected' ? 'online' : status === 'stale' ? 'away' : 'offline';

  // One row per machine, carrying everything the tall panel below used to:
  // presence, a ticking heartbeat, what the worker reports about the hardware,
  // what it is doing, and the actions. A person with three laptops compares
  // them by scanning a column, which a stack of per-machine cards cannot do.
  const nodeColumns: DataTableColumn<ComputeNode>[] = [
    {
      key: 'label',
      header: 'Machine',
      render: (n) => (
        <Stack gap="none">
          <EntityCell label={n.label} id={n.platform ?? undefined} />
        </Stack>
      ),
    },
    {
      key: 'models',
      header: 'Models',
      // Self-registered: the worker announces what it can actually run, so
      // this is the machine telling you, not a setting someone typed.
      render: (n) => (
        n.localModels.length === 0
          ? <MetaLine size="xs" tone="tertiary" items={['none announced']} />
          : (
            <Inline gap="xs" wrap>
              {n.localModels.map((m) => <Chip key={m} tone="neutral" size="xs">{m}</Chip>)}
            </Inline>
          )
      ),
    },
    {
      key: 'kinds',
      header: 'Runs',
      render: (n) => (
        n.jobKinds.length === 0
          ? <MetaLine size="xs" tone="tertiary" items={['no kinds']} />
          : <MetaLine size="xs" items={[n.jobKinds.join(', ')]} />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (n) => {
        const beat = elapsedLabel(n.presence.lastSeenAt, now);
        return (
          <Stack gap="none">
            <Inline gap="xs" align="center">
              <PresenceDot state={presenceState(n.presence.status)} label={n.presence.status} />
              {!n.acceptJobs && <Chip tone="neutral" size="xs">paused</Chip>}
            </Inline>
            <MetaLine size="xs" tone="tertiary" aria-live="polite" items={[beat ? `beat ${beat} ago` : 'never announced']} />
          </Stack>
        );
      },
    },
    {
      key: 'load',
      header: 'Load',
      render: (n) => {
        const m = n.metrics;
        if (m?.loadAvg1 == null) return <MetaLine size="xs" tone="tertiary" items={['—']} />;
        const pct = m.cpuCount ? Math.round((m.loadAvg1 / m.cpuCount) * 100) : null;
        return (
          <Stack gap="none">
            <T className="text-[13px] tabular-nums">{m.loadAvg1.toFixed(2)}</T>
            <MetaLine size="xs" tone="tertiary" items={[pct != null ? `${pct}% of ${m.cpuCount}` : 'cores unknown']} />
          </Stack>
        );
      },
    },
    {
      key: 'memory',
      header: 'Memory',
      render: (n) => {
        const m = n.metrics;
        if (!m?.memTotalMb || m.memFreeMb == null) return <MetaLine size="xs" tone="tertiary" items={['—']} />;
        const used = m.memTotalMb - m.memFreeMb;
        const pct = Math.round((used / m.memTotalMb) * 100);
        return (
          <Stack gap="none">
            <T className="text-[13px] tabular-nums">{pct}%</T>
            <MetaLine size="xs" tone="tertiary" items={[`${(used / 1024).toFixed(1)}G of ${(m.memTotalMb / 1024).toFixed(0)}G`]} />
          </Stack>
        );
      },
    },
    {
      key: 'work',
      header: 'Work',
      render: (n) => {
        const mine = runs.filter((r) => r.nodeId === n.id);
        const running = mine.filter((r) => r.status === 'running').length;
        const queued = mine.filter((r) => r.status === 'queued' || r.status === 'claimed').length;
        const failed = mine.filter((r) => r.status === 'failed' || r.status === 'cancelled').length;
        return (
          <Inline gap="xs" align="center">
            {running > 0 && <Chip tone="accent" size="xs" dot="pulse">{running} running</Chip>}
            {queued > 0 && <Chip tone="neutral" size="xs">{queued} queued</Chip>}
            {failed > 0 && <Chip tone="danger" size="xs">{failed} failed</Chip>}
            {running + queued + failed === 0 && <MetaLine size="xs" tone="tertiary" items={['idle']} />}
          </Inline>
        );
      },
    },
    {
      key: 'accept',
      header: 'Accepting',
      render: (n) => (
        <Switch
          checked={n.acceptJobs}
          disabled={!canDispatch || n.id in pendingAccept}
          aria-label={`Accepting work on ${n.label}`}
          onChange={(v) => { void handleAcceptJobs(n, v); }}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (n) => (
        <Inline gap="xs" align="center" className="justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); void refreshNodes(); void refreshRuns(); }}
            aria-label={`Refresh ${n.label}`}
          >
            Refresh
          </Button>
          {canDispatch && (
            <Button
              variant="ghost"
              size="sm"
              disabled={unpairBusy === n.id}
              onClick={(e) => { e.stopPropagation(); setUnpairTarget(n); }}
              aria-label={`Unpair ${n.label}`}
            >
              Unpair
            </Button>
          )}
        </Inline>
      ),
    },
  ];

  const runColumns: DataTableColumn<RunRow>[] = [
    {
      key: 'title',
      header: 'Run',
      sortable: true,
      render: (r) => (
        <Stack gap="none">
          <EntityCell label={r.title} />
          {r.result?.summary && (
            <MetaLine size="xs" tone="tertiary" items={[truncate(r.result.summary, 80)]} />
          )}
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <LiveJobCell job={r} now={now} />,
    },
    {
      key: 'machine',
      header: 'Machine',
      render: (r) => <MetaLine size="xs" items={[r.nodeLabel ?? '—']} />,
    },
    {
      key: 'started',
      header: 'Started',
      sortable: true,
      render: (r) => when(r.startedAt ?? r.createdAt),
    },
    {
      key: 'cost',
      header: 'Cost',
      render: (r) => {
        if (r.result?.provider === 'local') return <Chip tone="success" size="xs">$0</Chip>;
        if (r.result?.costUsd != null) return <MetaLine size="xs" items={[usd(r.result.costUsd)]} />;
        return <MetaLine size="xs" tone="tertiary" items={['—']} />;
      },
    },
  ];

  return (
    <PageSection
      title="Local compute"
      description="Your paired machines and the work in their lane — they run it with their own models and credentials, and report back here."
    >
      {nodesFailure && (
        <UnavailableNotice
          error={nodesFailure}
          what="your paired machines"
          source="Nodes are read from Aurora"
          onRetry={refreshNodes}
          className="mb-4"
        />
      )}

      {!nodesFailure && nodes.length === 0 ? (
        <EmptyState
          title="No paired machines"
          description={canDispatch
            ? 'Pair a machine and it appears here; the dialog gives you a code, the command to run on it, and moves on by itself once the machine claims it.'
            : 'Pairing a machine needs machine-pairing access; ask a platform operator to pair one for you.'}
          {...(canDispatch ? { actionLabel: 'Pair a machine', onAction: () => setPairOpen(true) } : {})}
        />
      ) : (
        <Stack gap="lg">
          <DetailSection
            first
            title="Your machines"
            actions={canDispatch ? (
              <Button size="sm" variant="secondary" onClick={() => setPairOpen(true)}>Pair another</Button>
            ) : undefined}
          >
            <Stack gap="sm">
              {acceptError && (
                <Banner variant="error">{acceptError}</Banner>
              )}
              <DataTable
                data={nodes}
                keyField={(n) => n.id}
                columns={nodeColumns}
                onRowClick={(n) => setSelectedNodeId(n.id)}
                striped
                emptyMessage="No machines."
              />
            </Stack>
          </DetailSection>

          {selectedNode && (
            <DetailSection title="Machine details" hint={selectedNode.label}>
              {/* One tabbed area instead of four stacked sections. The page
                  used to run past a screen and a half for a single machine:
                  a per-machine card repeating what the row already said, then
                  its lane, then the pick list, then history — each with its
                  own heading and rule. These are four views of one machine,
                  not four topics, so they are tabs. */}
              <Tabs
                idPrefix="machine"
                aria-label={`${selectedNode.label} detail`}
                value={tab}
                onValueChange={(id) => setTab(id as MachineTab)}
                items={[
                  { id: 'lane', label: upNext.length > 0 ? `Queue · ${upNext.length}` : 'Queue' },
                  ...(canDispatch ? [{ id: 'hand', label: 'Assign work' }] : []),
                  { id: 'activity', label: 'History' },
                  { id: 'connection', label: 'Details' },
                ]}
              />

              <Stack hidden={tab !== 'lane'} gap="sm">
{/* The offline / paused / never-announced banners that used to
                    sit here are gone: MachineConnection above says the same
                    thing in its status line and carries the worker command
                    with it, so the page no longer explains the same state
                    twice in two different voices. */}
                {upNext.length === 0 ? (
                  <InlinePlaceholder>
                    Nothing queued for this machine. Work reaches it from a bot's schedule or an initiative's work item, in the kinds it registered
                    {selectedNode.jobKinds.length > 0 ? ` (${selectedNode.jobKinds.join(', ')})` : ''}.
                  </InlinePlaceholder>
                ) : (
                  <DataTable<RunRow>
                    columns={[
                      { key: 'title', header: 'Work', render: (r) => <EntityCell label={r.title} id={r.kind} /> },
                      { key: 'status', header: 'Status', render: (r) => (
                        <LiveJobCell job={r} now={now} lanePosition={upNext.findIndex((u) => u.id === r.id) + 1} />
                      ) },
                      { key: 'target', header: 'Targeted', render: (r) => (r.nodeId ? 'this machine' : 'any machine in the kind') },
                      { key: 'queued', header: 'Queued', render: (r) => when(r.createdAt) },
                    ]}
                    data={upNext}
                    keyField={(r) => r.id}
                    onRowClick={(r) => setSelectedRunId(r.id)}
                  />
                )}
              </Stack>

              {canDispatch && (
                <Stack hidden={tab !== 'hand'} gap="sm">
                  {/* A labelled switch between the two places work comes
                      from, not two counted chips with a link floating beside
                      them — the counts read as filters over one list, which
                      is not what they are: these are different sources. */}
                  <Toolbar wrap>
                    <ToolbarLabel>Source</ToolbarLabel>
                    <SegmentedControl
                      size="sm"
                      aria-label="Where the work comes from"
                      value={pick}
                      onChange={(v) => setPick(v as 'work' | 'bots')}
                      options={[
                        { label: 'Initiative work', value: 'work' },
                        ...(canRunBots ? [{ label: 'Bots', value: 'bots' }] : []),
                      ]}
                    />
                    <ToolbarSeparator />
                    <MetaLine
                      size="xs"
                      tone="tertiary"
                      items={[pick === 'work'
                        ? `${pickWork.length} open on your initiatives`
                        : `${pickBots.length} enabled bot${pickBots.length === 1 ? '' : 's'}`]}
                    />
                  </Toolbar>

                    {sendError && <Banner variant="error">{sendError}</Banner>}
                    {pick === 'work' ? (
                      <DataTable<WorkSuggestion>
                        columns={[
                          { key: 'title', header: 'Work item', render: (r) => (
                            <EntityCell label={r.title} id={r.workItemId} href={`/iq/projects/${r.initiativeId}?item=${encodeURIComponent(r.workItemId)}`} />
                          ) },
                          { key: 'initiative', header: 'Initiative', render: (r) => (
                            <RouterLink to={`/iq/projects/${r.initiativeId}`} className="text-primary hover:underline">{r.initiativeName}</RouterLink>
                          ) },
                          { key: 'why', header: 'Why now', render: (r) => <MetaLine items={[r.reason]} /> },
                          { key: 'size', header: 'Size', render: (r) => [r.storyPoints != null ? `${r.storyPoints} pts` : null, r.estimatedCostUsd != null ? usd(r.estimatedCostUsd) : null].filter(Boolean).join(' · ') || '—' },
                          { key: 'send', header: '', render: (r) => (
                            <Button size="sm" variant="secondary" disabled={!selectedNode.acceptJobs || sending === r.workItemId} onClick={(e) => { e.stopPropagation(); void send({ workItemId: r.workItemId }, r.title); }}>
                              {sending === r.workItemId ? 'Sending…' : `Send to ${selectedNode.label}`}
                            </Button>
                          ) },
                        ]}
                        data={pickWork}
                        keyField={(r) => r.workItemId}
                        emptyMessage="Nothing suggested right now — open work on your initiatives shows up here."
                      />
                    ) : (
                      <DataTable<BotRow>
                        columns={[
                          { key: 'name', header: 'Bot', render: (b) => (
                            <EntityCell label={b.name} id={b.repoFullName ?? undefined} href={`/admin/bots/${b.id}`} />
                          ) },
                          { key: 'schedule', header: 'Schedule', render: (b) => b.cronExpr ?? 'manual' },
                          { key: 'model', header: 'Model', render: (b) => b.model },
                          { key: 'last', header: 'Last ran', render: (b) => (b.lastRunAt ? when(b.lastRunAt) : 'never') },
                          { key: 'send', header: '', render: (b) => (
                            <Button size="sm" variant="secondary" disabled={!selectedNode.acceptJobs || sending === b.id} onClick={(e) => { e.stopPropagation(); void send({ botId: b.id }, b.name); }}>
                              {sending === b.id ? 'Sending…' : `Run on ${selectedNode.label}`}
                            </Button>
                          ) },
                        ]}
                        data={pickBots}
                        keyField={(b) => b.id}
                        emptyMessage="No enabled bots to run."
                      />
                    )}
                </Stack>
              )}

              <Stack hidden={tab !== 'activity'} gap="sm">

            {runsFailure ? (
              <UnavailableNotice
                error={runsFailure}
                what="run history"
                source="Runs are read from Aurora"
                onRetry={refreshRuns}
              />
            ) : (
              <DataTable
                data={runs}
                keyField={(r) => r.id}
                columns={runColumns}
                striped
                // Full run history for this machine, across every session
                // it's ever worked — 20 keeps a long-lived machine's ledger
                // a screenful instead of an ever-growing scroll.
                pageSize={20}
                emptyMessage="No runs yet."
              />
            )}
              </Stack>

              <Stack hidden={tab !== 'connection'} gap="sm">
                <MachineConnection
                  machine={selectedNode}
                  jobs={machineJobs}
                  now={now}
                  streamLive={streamLive}
                />
              </Stack>
            </DetailSection>
          )}

          {selectedRunId && (
            <DetailSection
              title="Log"
              actions={<Button variant="ghost" size="sm" onClick={() => setSelectedRunId(null)}>Close</Button>}
            >
              {/* Keyed on the run id: RunLog's "have we reached done" state must
                  not survive a switch to a different run's log. */}
              <RunLog key={selectedRunId} jobId={selectedRunId} />
            </DetailSection>
          )}
        </Stack>
      )}
      <PairMachineDialog open={pairOpen} onClose={() => setPairOpen(false)} />
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
    </PageSection>
  );
}

// ─── Log viewer ──────────────────────────────────────────────────────────────

interface RunLogPayload {
  entries: Array<{ seq: number; text: string }>;
  done: boolean;
}

// LogStream is a scroll box, not a windowed list — every line it's handed is
// its own DOM node for the life of the panel. A long-running job polling
// every 2s would otherwise grow that node count without bound for as long as
// the drawer stayed open. Keep the most recent lines, since that's what a
// live tail is for, and say so when older ones are dropped.
const RUN_LOG_LINE_CAP = 500;

function RunLog({ jobId }: { jobId: string }) {
  // Poll every 2s while the run is non-terminal; once the server reports
  // `done`, stop — the old hand-rolled interval kept hitting this endpoint
  // every 2s forever, for as long as the log panel stayed open.
  const [done, setDone] = useState(false);
  const { data } = useFetch<RunLogPayload>(
    `/api/local-compute/jobs/${jobId}/log`,
    done ? undefined : 2_000,
  );

  useEffect(() => {
    if (data?.done) setDone(true);
  }, [data]);

  // Memoised on the fetch payload, not recomputed on every render this
  // component happens to take part in (parent state changes elsewhere on
  // the page) — the old version remapped and re-sliced on every one of
  // those, not just on an actual new poll result.
  const { lines, totalLines } = useMemo(() => {
    const entries = data?.entries ?? [];
    const capped = entries.length > RUN_LOG_LINE_CAP ? entries.slice(entries.length - RUN_LOG_LINE_CAP) : entries;
    return {
      lines: capped.map((e) => ({ id: String(e.seq), message: e.text }) as LogLine),
      totalLines: entries.length,
    };
  }, [data]);
  const truncated = totalLines > RUN_LOG_LINE_CAP;

  return (
    <LogStream
      lines={lines}
      follow={!done}
      maxHeight="400px"
      tone="surface"
      emptyMessage={done ? 'This run produced no output.' : 'Waiting for output…'}
      // Overrides LogStream's default "N lines" header only when we've
      // actually dropped some — otherwise the default count is the honest
      // count already. `showingLabel` reads as "first N of M", which isn't
      // true here (we keep the tail, not the head), so this says "most
      // recent" explicitly rather than reusing that phrasing.
      headerSlot={truncated ? (
        <T className="text-text-tertiary">{`Showing the most recent ${lines.length.toLocaleString('en-US')} of ${totalLines.toLocaleString('en-US')} lines`}</T>
      ) : undefined}
    />
  );
}
