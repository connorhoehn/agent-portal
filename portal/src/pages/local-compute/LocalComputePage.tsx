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
  SectionLabel,
  SegmentedControl,
  useToastOptional,
  PageSection,
  Select,
  Stack,
  Switch,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { LogStream, type LogLine } from '@connorhoehnslalom/ui-components/shared';
import { Link as RouterLink } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from './writeJson';
import { PairMachineDialog, WORKER_COMMAND } from './PairMachineDialog';
import { statusLabel, statusTone, truncate, when, type JobStatus } from './localComputeFormat';

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
  presence: NodePresence;
}

interface RunRow {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  nodeId: string | null;
  nodeLabel: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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

  const nodeColumns: DataTableColumn<ComputeNode>[] = [
    {
      key: 'label',
      header: 'Machine',
      render: (n) => (
        <Inline gap="xs" align="center">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={n.id === selectedNodeId}
            onClick={() => setSelectedNodeId(n.id)}
          >
            <EntityCell label={n.label} />
          </Button>
          <Chip
            tone={n.presence.status === 'connected' ? 'success' : n.presence.status === 'stale' ? 'warning' : 'neutral'}
            size="xs"
            dot={n.presence.status === 'connected' ? 'pulse' : 'static'}
          >
            {n.presence.status}
          </Chip>
          {!n.acceptJobs && <Chip tone="neutral" size="xs">paused</Chip>}
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
    {
      key: 'models',
      header: 'Models',
      render: (n) => (
        <MetaLine size="xs" items={n.localModels.length > 0 ? n.localModels.slice(0, 3) : ['none']} />
      ),
    },
    {
      key: 'kinds',
      header: 'Kinds',
      render: (n) => (
        <MetaLine size="xs" tone="tertiary" items={n.jobKinds.length > 0 ? n.jobKinds : ['default']} />
      ),
    },
    {
      key: 'sessions',
      header: 'Sessions',
      render: (n) => {
        const count = n.presence.sessions.length;
        return <MetaLine size="xs" items={[`${count} ${count === 1 ? 'session' : 'sessions'}`]} />;
      },
    },
    {
      key: 'acceptJobs',
      header: 'Accepting work',
      render: (n) => (
        // Stop the row's click so flipping the switch doesn't also read as
        // "select this machine" (which would be harmless, but surprising).
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={n.acceptJobs}
            disabled={!canDispatch || n.id in pendingAccept}
            onChange={(next) => { void handleAcceptJobs(n, next); }}
            size="sm"
            aria-label={`${n.acceptJobs ? 'Pause' : 'Resume'} work on ${n.label}`}
            data-testid={`accept-jobs-${n.id}`}
          />
        </span>
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
          <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(r.id)}>
            {r.title}
          </Button>
          {r.result?.summary && (
            <MetaLine size="xs" tone="tertiary" items={[truncate(r.result.summary, 80)]} />
          )}
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Chip tone={statusTone(r.status)} size="xs">{statusLabel(r.status)}</Chip>,
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
        if (r.result?.costUsd != null) return <MetaLine size="xs" items={[`$${r.result.costUsd.toFixed(2)}`]} />;
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
            : 'Pairing a machine needs the ConnectLocalCompute capability; ask a platform operator to pair one for you.'}
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
            <DetailSection title={`Up next on ${selectedNode.label}`} hint={upNext.length > 0 ? `${upNext.length} in its lane` : undefined}>
              <Stack gap="sm">
                {!selectedNode.acceptJobs ? (
                  <Banner variant="warning">
                    This machine is paused — switch on “Accepting work” in the row above and it will start claiming from its lane.
                  </Banner>
                ) : selectedNode.presence.status === 'offline' && selectedNode.jobKinds.length === 0 ? (
                  // Paired but never announced: the worker has not run on it
                  // yet. Say the command here, because "offline" alone read as
                  // a failed pairing to the first person who hit it.
                  <Banner variant="warning">
                    <Stack gap="xs">
                      <Inline as="span" gap="none" wrap>
                        This machine is paired but its worker has not run yet, so it is offline and has announced nothing it can run. On that machine, from the repo checkout:
                      </Inline>
                      <CodeBlock code={WORKER_COMMAND} language="bash" copyButton ariaLabel="Worker command" />
                    </Stack>
                  </Banner>
                ) : selectedNode.presence.status === 'offline' ? (
                  <Banner variant="warning">
                    This machine is offline — anything queued for it waits until its worker announces again.
                  </Banner>
                ) : null}
                {upNext.length === 0 ? (
                  <InlinePlaceholder>
                    Nothing queued for this machine. Work reaches it from a bot's schedule or an initiative's work item, in the kinds it registered
                    {selectedNode.jobKinds.length > 0 ? ` (${selectedNode.jobKinds.join(', ')})` : ''}.
                  </InlinePlaceholder>
                ) : (
                  <DataTable<RunRow>
                    columns={[
                      { key: 'title', header: 'Work', render: (r) => (
                        <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(r.id)}>
                          <EntityCell label={r.title} id={r.kind} />
                        </Button>
                      ) },
                      { key: 'status', header: 'Status', render: (r) => <Chip tone={statusTone(r.status)} size="xs">{statusLabel(r.status)}</Chip> },
                      { key: 'target', header: 'Targeted', render: (r) => (r.nodeId ? 'this machine' : 'any machine in the kind') },
                      { key: 'queued', header: 'Queued', render: (r) => when(r.createdAt) },
                    ]}
                    data={upNext}
                    keyField={(r) => r.id}
                    onRowClick={(r) => setSelectedRunId(r.id)}
                  />
                )}
                {canDispatch && (
                  <Stack gap="xs" data-testid="pick-list">
                    <Inline gap="sm" align="center" wrap>
                      <SectionLabel as="div">Hand it something</SectionLabel>
                      <SegmentedControl
                        size="sm"
                        aria-label="What to pick from"
                        value={pick}
                        onChange={(v) => setPick(v as 'work' | 'bots')}
                        options={[
                          { label: `Initiative work · ${pickWork.length}`, value: 'work' },
                          ...(canRunBots ? [{ label: `Bots · ${pickBots.length}`, value: 'bots' }] : []),
                        ]}
                      />
                      <MetaLine
                        className="ml-auto"
                        items={[
                          pick === 'work'
                            ? <RouterLink key="all" to="/iq/projects" className="text-primary hover:underline">Browse all initiatives →</RouterLink>
                            : <RouterLink key="all" to="/admin/bots" className="text-primary hover:underline">All bots →</RouterLink>,
                        ]}
                      />
                    </Inline>
                    {sendError && <Banner variant="error">{sendError}</Banner>}
                    {pick === 'work' ? (
                      <DataTable<WorkSuggestion>
                        columns={[
                          { key: 'title', header: 'Work item', render: (r) => <EntityCell label={r.title} id={r.workItemId} /> },
                          { key: 'initiative', header: 'Initiative', render: (r) => r.initiativeName },
                          { key: 'why', header: 'Why now', render: (r) => <MetaLine items={[r.reason]} /> },
                          { key: 'size', header: 'Size', render: (r) => [r.storyPoints != null ? `${r.storyPoints} pts` : null, r.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(2)}` : null].filter(Boolean).join(' · ') || '—' },
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
                          { key: 'name', header: 'Bot', render: (b) => <EntityCell label={b.name} id={b.repoFullName ?? undefined} /> },
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
              </Stack>
            </DetailSection>
          )}

          <DetailSection title="Your runs">
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
                emptyMessage="No runs yet."
              />
            )}
          </DetailSection>

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

  const lines: LogLine[] = (data?.entries ?? []).map((e) => ({ id: String(e.seq), message: e.text }));

  return (
    <LogStream
      lines={lines}
      follow={!done}
      maxHeight="400px"
      tone="surface"
      emptyMessage={done ? 'This run produced no output.' : 'Waiting for output…'}
    />
  );
}
