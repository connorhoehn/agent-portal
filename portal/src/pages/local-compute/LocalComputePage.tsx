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
  DataTable,
  DetailSection,
  EmptyState,
  EntityCell,
  Inline,
  InlinePlaceholder,
  MetaLine,
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
import { writeJson } from './writeJson';
import { PairMachineDialog, WORKER_COMMAND } from './PairMachineDialog';
import { statusLabel, statusTone, when, type JobStatus } from './localComputeFormat';

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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LocalComputePage() {
  const { data: nodesData, error: nodesError, degraded: nodesDegraded, refresh: refreshNodes } = useFetch<{ nodes: ComputeNode[] }>('/api/local-compute/nodes', 15_000);
  const { data: runsData, error: runsError, degraded: runsDegraded, refresh: refreshRuns } = useFetch<{ runs: RunRow[] }>('/api/local-compute/runs', 15_000);
  const { can, ready } = useCapabilities();
  const canDispatch = ready && can('ConnectLocalCompute');

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

  const nodeColumns: DataTableColumn<ComputeNode>[] = [
    {
      key: 'label',
      header: 'Machine',
      render: (n) => (
        <Inline gap="xs" align="center">
          <EntityCell label={n.label} />
          <Chip
            tone={n.presence.status === 'connected' ? 'success' : n.presence.status === 'stale' ? 'warning' : 'neutral'}
            size="xs"
            dot={n.presence.status === 'connected' ? 'pulse' : 'static'}
          >
            {n.presence.status}
          </Chip>
          {!n.acceptJobs && <Chip tone="neutral" size="xs">paused</Chip>}
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
        <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(r.id)}>
          {r.title}
        </Button>
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
                      { key: 'title', header: 'Work', render: (r) => <EntityCell label={r.title} id={r.kind} /> },
                      { key: 'status', header: 'Status', render: (r) => <Chip tone={statusTone(r.status)} size="xs">{statusLabel(r.status)}</Chip> },
                      { key: 'target', header: 'Targeted', render: (r) => (r.nodeId ? 'this machine' : 'any machine in the kind') },
                      { key: 'queued', header: 'Queued', render: (r) => when(r.createdAt) },
                    ]}
                    data={upNext}
                    keyField={(r) => r.id}
                    onRowClick={(r) => setSelectedRunId(r.id)}
                  />
                )}
                <MetaLine
                  size="xs"
                  items={[
                    <RouterLink key="bots" to="/admin/bots" className="text-primary hover:underline">Schedule work with a bot →</RouterLink>,
                    <RouterLink key="work" to="/iq/projects" className="text-primary hover:underline">Dispatch from an initiative's work →</RouterLink>,
                  ]}
                />
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
              <RunLog jobId={selectedRunId} />
            </DetailSection>
          )}
        </Stack>
      )}
      <PairMachineDialog open={pairOpen} onClose={() => setPairOpen(false)} />
    </PageSection>
  );
}

// ─── Log viewer ──────────────────────────────────────────────────────────────

function RunLog({ jobId }: { jobId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    // Poll for logs every 2s
    const poll = async () => {
      try {
        const res = await fetch(`/api/local-compute/jobs/${jobId}/log`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          entries: Array<{ seq: number; text: string }>;
          done: boolean;
        };
        if (!mounted) return;
        setLines(data.entries.map((e) => ({ id: String(e.seq), message: e.text })));
        setDone(data.done);
      } catch {
        // ignore
      }
    };

    void poll();
    const interval = setInterval(poll, 2000);

    return () => {
      mounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [jobId]);

  return (
    <LogStream
      lines={lines}
      follow={!done}
      maxHeight="400px"
      emptyMessage={done ? 'This run produced no output.' : 'Waiting for output…'}
    />
  );
}
