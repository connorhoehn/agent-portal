// Local Compute — hand work to your paired machines and tail what they're doing.
//
// The browser control the user asked for: "i should be able to route work to that
// online machine". A CONNECTED machine with no dispatch route is a status light,
// not a fleet participant.

import { useState, useEffect, useMemo } from 'react';
import {
  Banner, Button, Card, Chip, CloseIcon, CodeBlock, CollectionToolbar, ConfirmDialog, DataTable,
  DetailSection, EmptyState, EntityCell, IconButton, Inline, InlinePlaceholder, MetaLine,
  PageSection, PlayCircleIcon, PresenceDot, SegmentedControl, Select, SendIcon, Stack, Switch, T,
  Tabs, Toolbar, ToolbarLabel, ToolbarSeparator, useToastOptional, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { LogStream, type LogLine } from '@connorhoehn/ui-components/shared';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { runsListHref } from '../iq/runsModel';
import { RunLog } from './RunLog';
import { CapabilityBrief, ModelChips } from './ModelCapability';
import { NoSuggestions } from './SuggestedWork';
import { HeadroomBar } from './HeadroomBar';
import { useFetch } from '../../hooks/useFetch';
import { filterRows } from '../../hooks/useRowSearch';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { localRunsCommandAdapter, machinesCommandAdapter } from './localComputeCommands';
import { useCapabilities } from '../../lib/capabilities';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { presenceChip } from '../../lib/statusTone';
import { usd } from '../../lib/format';
import { PairMachineDialog, WORKER_COMMAND } from './PairMachineDialog';
import { statusLabel, statusTone, truncate, when, isLive, elapsedLabel, pollState, type JobStatus } from './localComputeFormat';
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
  /**
   * When the worker last asked the queue for work.
   *
   * NOT presence. Presence is the 25-second announce, which a paired machine
   * keeps sending whether or not its work loop is running — so a laptop with
   * the worker switched off reads `connected` and is indistinguishable from
   * one pulling work all day. Only this separates them. Null on a machine
   * that has never claimed, and on a cluster without the column.
   */
  lastClaimAt?: string | null;
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
  /** What the run is ABOUT. `GET /runs` spreads the whole job, so the origin
   *  the dispatch route wrote (`workItemId` + `initiativeId`, or `botId`) has
   *  always been on the wire — the page simply never declared it, so a run
   *  named its title and led nowhere. That is the "no link to the work"
   *  report: every field needed to link was already here. */
  payload?: {
    workItemId?: string;
    initiativeId?: string;
    botId?: string;
    requiresReview?: boolean;
  };
  botId?: string | null;
  botName?: string | null;
}

/** Where a run's subject lives, if it has one a person can open. */
function runOrigin(r: RunRow): { href: string; label: string } | null {
  const p = r.payload ?? {};
  if (p.workItemId && p.initiativeId) {
    return { href: `/iq/projects/${p.initiativeId}?item=${encodeURIComponent(p.workItemId)}`, label: 'work item' };
  }
  const bot = p.botId ?? r.botId;
  if (bot) return { href: `/admin/bots/${bot}`, label: r.botName ?? 'bot' };
  return null;
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

const PRESENCE_OPTIONS = [
  { value: '', label: 'Any presence' },
  { value: 'connected', label: 'Connected' },
  { value: 'stale', label: 'Stale' },
  { value: 'offline', label: 'Offline' },
];
const RUN_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  ...(['queued', 'claimed', 'running', 'awaiting_review', 'done', 'failed', 'cancelled'] as const).map((value) => ({ value, label: statusLabel(value) })),
];

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
  // Whether a finished run waits for a person. True by default: a run that
  // touched a repo should be looked at unless someone says otherwise.
  const [requiresReview, setRequiresReview] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const toast = useToastOptional();

  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'runs' ? 'runs' : 'machines';
  const selectedNodeId = params.get('machine');
  const selectedRunId = params.get('run');
  const setSelection = (key: string, value: string | null) => setParams((previous) => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); return next; });
  const setSelectedNodeId = (id: string | null) => setSelection('machine', id);
  const setSelectedRunId = (id: string | null) => setSelection('run', id);
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

  // The machines and runs tables' search and one filter each: controlled
  // here so the toolbar and the command composer share one state.
  const [machineQuery, setMachineQuery] = useState('');
  const [machinePresence, setMachinePresence] = useState('');
  const visibleNodes = useMemo(
    () => filterRows(nodes.filter((n) => !machinePresence || n.presence.status === machinePresence), machineQuery, (n) => `${n.label} ${n.platform ?? ''} ${n.id}`),
    [nodes, machinePresence, machineQuery],
  );
  const [runQuery, setRunQuery] = useState('');
  const [runStatus, setRunStatus] = useState('');
  const visibleRuns = useMemo(
    () => filterRows(runs.filter((r) => !runStatus || r.status === runStatus), runQuery, (r) => `${r.title} ${r.kind} ${r.nodeLabel ?? ''} ${r.id}`),
    [runs, runStatus, runQuery],
  );
  const machineCommands = machinesCommandAdapter(visibleNodes, {
    setQuery: setMachineQuery, setPresence: setMachinePresence, refresh: () => { void refreshNodes(); }, selectMachine: setSelectedNodeId,
  });
  const runCommands = localRunsCommandAdapter(visibleRuns, {
    setQuery: setRunQuery, setStatus: setRunStatus, refresh: () => { void refreshRuns(); }, openRun: setSelectedRunId,
  });

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
    // `requiresReview` is a field the dispatch route has always accepted and
    // the worker has always honoured — this page just never offered it, so
    // every repo-backed run parked itself in `awaiting_review` and there was
    // no way to say "run it and be done". The default stays true, because a
    // run that changes a repo should be looked at unless someone chooses
    // otherwise.
    const res = await writeJson<{ id: string }>(
      `/api/local-compute/nodes/${selectedNode.id}/work`,
      'POST',
      { ...origin, requiresReview },
    );
    setSending(null);
    if (res.ok) {
      toast?.toast(
        requiresReview
          ? `${label} queued for ${selectedNode.label} — it will wait for your review`
          : `${label} queued for ${selectedNode.label} — it will finish without asking`,
        { type: 'success' },
      );
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
      // One line: the platform is the title, not a second line under the name.
      render: (n) => <T size="sm" weight="medium" title={n.platform ?? undefined} className="whitespace-nowrap">{n.label}</T>,
    },
    {
      key: 'models',
      header: 'Models',
      // Self-registered: the worker announces what it can actually run, so
      // this is the machine telling you, not a setting someone typed.
      render: (n) => <ModelChips models={n.localModels} />,
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
          <Inline gap="xs" align="center" wrap={false}>
            <PresenceDot state={presenceState(n.presence.status)} label={n.presence.status} />
            {!n.acceptJobs && <Chip tone="neutral" size="xs">paused</Chip>}
            <MetaLine size="xs" tone="tertiary" aria-live="polite" items={[beat ? `beat ${beat} ago` : 'never announced']} />
          </Inline>
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
          <HeadroomBar
            value={m.loadAvg1.toFixed(2)}
            pct={pct}
            detail={pct != null ? `${pct}% of ${m.cpuCount}` : 'cores unknown'}
            aria-label={`Load ${pct != null ? `${pct} percent` : 'unknown'}`}
          />
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
          <HeadroomBar
            value={`${pct}%`}
            pct={pct}
            detail={`${(used / 1024).toFixed(1)}G of ${(m.memTotalMb / 1024).toFixed(0)}G`}
            aria-label={`Memory ${pct} percent used`}
          />
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
          <Inline gap="xs" align="center" wrap={false}>
            {running > 0 && <Chip tone="accent" size="xs" dot="pulse">{running} running</Chip>}
            {queued > 0 && <Chip tone="neutral" size="xs">{queued} queued</Chip>}
            {failed > 0 && <Chip tone="danger" size="xs">{failed} failed</Chip>}
            {running + queued + failed === 0 && (() => {
              const poll = pollState(n.lastClaimAt, now);
              if (poll === 'pulling') {
                return <Chip tone="success" size="xs" dot="pulse" title={`Last asked the queue for work ${when(n.lastClaimAt)}`}>idle · pulling</Chip>;
              }
              if (poll === 'stopped') {
                return <Chip tone="warning" size="xs" dot="static" title={`Last asked for work ${when(n.lastClaimAt)} — the worker looks stopped`}>not polling</Chip>;
              }
              return <Chip tone="neutral" size="xs" title="Paired, but no worker has ever asked this queue for work">worker not started</Chip>;
            })()}
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
          {/* The per-row "Refresh" is gone. It promised a per-machine action —
              its own aria-label said `Refresh ${label}` — and called
              refreshNodes()+refreshRuns(), i.e. refetched the whole table. So
              it was one global action rendered once per row, N copies of the
              same button. And it was redundant on top of that: this table
              already polls on a 15s interval (useFetch above), so the data it
              fetched was arriving anyway.

              Unpair stays — it is the one thing here only a person can decide —
              but it is revealed on the row's hover / focus-within rather than
              sitting on every row at rest, the same treatment the other
              destructive row controls got. Its confirm dialog is unchanged. */}
          {canDispatch && (
            <IconButton
              size="sm"
              icon={<CloseIcon />}
              className="row-reveal"
              disabled={unpairBusy === n.id}
              onClick={(e) => { e.stopPropagation(); setUnpairTarget(n); }}
              aria-label={`Unpair ${n.label}`}
              title="Unpair"
            />
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
      // The run's own page (/iq/work/:jobId) is where the readable activity,
      // the produced proposals and the Accept/Reject live. This row used to be
      // a dead label: a machine would finish a job, park it in review, and the
      // only place that said so offered no way to go and look at it.
      render: (r) => {
        const origin = runOrigin(r);
        return (
          <Inline gap="sm" wrap={false} className="min-w-0" title={r.result?.summary ? truncate(r.result.summary, 200) : undefined}>
            <EntityCell label={r.title} href={`/iq/work/${encodeURIComponent(r.id)}`} className="min-w-0" />
            {origin && (
              <RouterLink
                to={origin.href}
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-primary no-underline hover:underline"
              >
                {origin.label} →
              </RouterLink>
            )}
          </Inline>
        );
      },
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
    {
      key: 'act',
      header: '',
      // `awaiting_review` is a request addressed to a person, and until now it
      // was delivered as a grey chip with nowhere to go. A state that is
      // waiting on you should carry the thing you do about it.
      render: (r) => (
        r.status === 'awaiting_review' ? (
          <RouterLink
            to={`/iq/work/${encodeURIComponent(r.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-medium text-primary no-underline hover:underline"
          >
            Review →
          </RouterLink>
        ) : null
      ),
    },
  ];

  if (view === 'runs') return <PageSection title="Runs" description="Work handed to your paired machines." actions={<RouterLink to={runsListHref({ executor: 'local' })} className="text-sm text-primary hover:underline" data-testid="local-runs-link">Open in Runs →</RouterLink>}>
    {runsFailure ? <UnavailableNotice error={runsFailure} what="run history" source="Runs on your machines are read from the job queue in Aurora" onRetry={refreshRuns} /> : (
      <Stack gap="sm" className="min-w-0">
        <CollectionToolbar
          label="Run filters"
          search={{ value: runQuery, onChange: setRunQuery, placeholder: 'Search runs', 'aria-label': 'Search runs' }}
          filters={[{ id: 'status', label: 'Status', value: runStatus, onChange: setRunStatus, options: RUN_STATUS_OPTIONS }]}
          summary={runsData ? `${visibleRuns.length} of ${runs.length} runs` : undefined}
          onRefresh={() => { void refreshRuns(); }}
        />
        <DataTable data={visibleRuns} keyField={(run) => run.id} columns={runColumns} frameless pageSize={20} onRowClick={(run) => setSelectedRunId(run.id)} emptyMessage={runs.length > 0 ? 'No run matches the search or status.' : 'No runs yet'} />
        <CollectionCommandHost adapter={runCommands} />
      </Stack>
    )}
    {selectedRunId && <DetailSection title="Run log" actions={<Button size="sm" variant="ghost" onClick={() => setSelectedRunId(null)}>Close</Button>}><RunLog key={selectedRunId} jobId={selectedRunId} /></DetailSection>}
  </PageSection>;

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

      {/* Three states, not two. The `EmptyState` below was already guarded on
          `!nodesFailure`, but the ELSE branch still rendered the machines
          table, whose `emptyMessage` is "No machines." — so a failed read
          printed the UnavailableNotice ("unknown rather than empty") and,
          directly beneath it, the sentence that contradicts it. Measured with
          `compute-nodes` pinned to `error`: both on screen at once. On failure
          the notice IS the answer; there is nothing to tabulate and no machine
          to select, so the table and the detail tabs below it go too. */}
      {nodesFailure ? null : nodes.length === 0 ? (
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
            {/* The machines are this page's collection: the toolbar, the
                table and the command composer share one search/presence
                state; the composer docks at the column's bottom (ColumnDock). */}
            <Stack gap="sm" className="min-w-0">
              {acceptError && (
                <Banner variant="error">{acceptError}</Banner>
              )}
              <CollectionToolbar
                label="Machine filters"
                search={{ value: machineQuery, onChange: setMachineQuery, placeholder: 'Search machines', 'aria-label': 'Search machines' }}
                filters={[{ id: 'presence', label: 'Presence', value: machinePresence, onChange: setMachinePresence, options: PRESENCE_OPTIONS }]}
                summary={`${visibleNodes.length} of ${nodes.length} machines`}
                onRefresh={() => { void refreshNodes(); }}
              />
              {/* A real surface, not the page ground. Everything on this page
                  used to sit directly on `bg-bg`, with the table head painting
                  `bg-surface-panel` a couple of points away from it — four
                  near-identical greys in one view and nothing reading as a
                  panel. A card gives the fleet an edge to sit inside. */}
              <Card>
                <DataTable
                  data={visibleNodes}
                  keyField={(n) => n.id}
                  columns={nodeColumns}
                  onRowClick={(n) => setSelectedNodeId(n.id)}
                  striped
                  emptyMessage={nodes.length > 0 ? 'No machine matches the search or presence.' : 'No machines.'}
                />
              </Card>
              <CollectionCommandHost adapter={machineCommands} />
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
              {/* The tabs and their panels share one surface. They used to sit
                  straight on the page ground, so a panel's content started
                  hard against the tab rule with no inset — the Queue message
                  read as a caption on the tab bar rather than the body of a
                  pane.
                  Every table in this Card is `striped`, and so is the fleet
                  table above it. Three of the four panels were not, so moving
                  between Queue and History — the same machine, one tab apart —
                  changed how a row was banded, and the page read as several
                  tables borrowed from different screens rather than one
                  machine seen four ways. */}
              <Card>
              <Stack gap="none" className="border-b border-border px-4 pt-3">
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
              </Stack>
              <Stack gap="none" className="p-4">

              <Stack hidden={tab !== 'lane'} gap="sm">
{/* The offline / paused / never-announced banners that used to
                    sit here are gone: MachineConnection above says the same
                    thing in its status line and carries the worker command
                    with it, so the page no longer explains the same state
                    twice in two different voices. */}
                {upNext.length === 0 ? (
                  // The one action that fills it, where this viewer may dispatch (UX walk, 9 November 2026).
                  <InlinePlaceholder data-testid="machine-queue-empty"
                    {...(canDispatch ? { action: <Button size="sm" variant="secondary" onClick={() => setTab('hand')}>Assign work</Button> } : {})}>
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
                    striped
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
                    <ToolbarSeparator />
                    {/* The other half of the review lane. Every repo-backed run
                        parked itself in `awaiting_review` with no way to opt
                        out, so a machine that finished its work still sat
                        waiting on a person who had not asked to be asked. */}
                    <ToolbarLabel>Wait for my review</ToolbarLabel>
                    <Switch
                      size="sm"
                      checked={requiresReview}
                      onChange={setRequiresReview}
                      aria-label="Wait for my review before the run is finished"
                    />
                    <MetaLine
                      size="xs"
                      tone="tertiary"
                      items={[requiresReview
                        ? 'It parks in review when it finishes'
                        : 'It finishes on its own — nothing waits for you']}
                    />
                  </Toolbar>

                    {sendError && <Banner variant="error">{sendError}</Banner>}
                    {pick === 'work' && pickWork.length === 0 ? (
                      <NoSuggestions
                        machineLabel={selectedNode.label}
                        models={selectedNode.localModels}
                        accepting={selectedNode.acceptJobs}
                        onTryBots={() => setPick('bots')}
                      />
                    ) : pick === 'work' ? (
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
                            <IconButton size="sm" icon={<SendIcon />} disabled={!selectedNode.acceptJobs || sending === r.workItemId} onClick={(e) => { e.stopPropagation(); void send({ workItemId: r.workItemId }, r.title); }} aria-label={`Send ${r.title} to ${selectedNode.label}`} title={sending === r.workItemId ? 'Sending…' : `Send to ${selectedNode.label}`} />
                          ) },
                        ]}
                        data={pickWork}
                        keyField={(r) => r.workItemId}
                        striped
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
                            <IconButton size="sm" icon={<PlayCircleIcon />} disabled={!selectedNode.acceptJobs || sending === b.id} onClick={(e) => { e.stopPropagation(); void send({ botId: b.id }, b.name); }} aria-label={`Run ${b.name} on ${selectedNode.label}`} title={sending === b.id ? 'Sending…' : `Run on ${selectedNode.label}`} />
                          ) },
                        ]}
                        data={pickBots}
                        keyField={(b) => b.id}
                        striped
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
                // The console, from here too. Only the Queue table opened it,
                // so the output of a run became unreachable the moment the run
                // ended: it left the queue for this table, and this table had
                // no way in. The transcript is worth most AFTER the run, which
                // is exactly when it could not be opened.
                onRowClick={(r) => setSelectedRunId(r.id)}
                // Full run history for this machine, across every session
                // it has ever worked — 20 keeps a long-lived machine ledger
                // a screenful instead of an ever-growing scroll.
                pageSize={20}
                emptyMessage="No runs yet."
              />
            )}
              </Stack>

              <Stack hidden={tab !== 'connection'} gap="md">
                {/* First, because it is the question this tab is usually open
                    to answer: what size of job can go to this machine. The
                    Models column says WHICH models; this says what they are
                    for. */}
                <Card padding="sm">
                  <Stack gap="sm">
                    <T size="xs" className="font-semibold uppercase tracking-wide text-text-tertiary">
                      What this machine can take on
                    </T>
                    <CapabilityBrief models={selectedNode.localModels} />
                  </Stack>
                </Card>
                <MachineConnection
                  machine={selectedNode}
                  jobs={machineJobs}
                  now={now}
                  streamLive={streamLive}
                />
              </Stack>
              </Stack>
              </Card>
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
      <PairMachineDialog
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        onPaired={() => { refreshNodes(); }}
      />
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

