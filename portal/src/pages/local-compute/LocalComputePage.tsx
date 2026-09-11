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
  DataTable,
  EmptyState,
  Inline,
  MetaLine,
  PageSection,
  Select,
  Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { TaskComposer, LogStream, type LogLine } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { writeJson } from './writeJson';
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
  const [dispatching, setDispatching] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const nodes = nodesData?.nodes ?? [];
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

  const handleDispatch = async (submission: { title?: string; prompt: string }) => {
    if (!selectedNode) return;
    setDispatching(true);
    const res = await writeJson<{ id: string }>(
      `/api/local-compute/nodes/${selectedNode.id}/work`,
      'POST',
      { title: submission.title, prompt: submission.prompt, kind: 'local:task' },
    );
    setDispatching(false);
    if (res.ok) {
      refreshRuns();
    } else {
      alert(res.error ?? 'Failed to dispatch work');
    }
  };

  const nodeColumns: DataTableColumn<ComputeNode>[] = [
    {
      key: 'label',
      header: 'Machine',
      render: (n) => (
        <Inline gap="xs" align="center">
          <span className="text-sm font-semibold text-text-primary">{n.label}</span>
          <Chip
            tone={n.presence.status === 'connected' ? 'success' : n.presence.status === 'stale' ? 'warning' : 'tertiary'}
            size="xs"
            dot={n.presence.status === 'connected' ? 'pulse' : 'static'}
          >
            {n.presence.status}
          </Chip>
          {!n.acceptJobs && <Chip tone="tertiary" size="xs">paused</Chip>}
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
  ];

  const runColumns: DataTableColumn<RunRow>[] = [
    {
      key: 'title',
      header: 'Run',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => setSelectedRunId(r.id)}
          className="text-left text-sm font-medium text-primary hover:underline"
        >
          {r.title}
        </button>
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
        if (r.result?.provider === 'local') return <MetaLine size="xs" tone="success" items={['$0']} />;
        if (r.result?.costUsd != null) return <MetaLine size="xs" items={[`$${r.result.costUsd.toFixed(2)}`]} />;
        return <MetaLine size="xs" tone="tertiary" items={['—']} />;
      },
    },
  ];

  return (
    <PageSection
      title="Local compute"
      description="Hand work to your paired machines — they run it with their own models and credentials, reporting back here."
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
          description="Pair a machine from its terminal or IDE with the pairing flow — then it will appear here, ready to accept work."
        />
      ) : (
        <Stack gap="lg">
          <div>
            <h3 className="text-base font-semibold text-text-primary mb-2">Your machines</h3>
            <DataTable
              data={nodes}
              keyField={(n) => n.id}
              columns={nodeColumns}
              onRowClick={(n) => setSelectedNodeId(n.id)}
              striped
              emptyMessage="No machines."
            />
          </div>

          {canDispatch && selectedNode && (
            <div>
              <h3 className="text-base font-semibold text-text-primary mb-2">
                Hand work to {selectedNode.label}
              </h3>
              {!selectedNode.acceptJobs ? (
                <Banner tone="warning" className="mb-3">
                  This machine is paused — switch it on before handing it work.
                </Banner>
              ) : selectedNode.presence.status === 'offline' ? (
                <Banner tone="warning" className="mb-3">
                  This machine is offline — work queued here will wait until it reconnects.
                </Banner>
              ) : null}
              <TaskComposer
                title="Dispatch work"
                promptPlaceholder="What should this machine do?"
                onSubmit={handleDispatch}
                submitLabel="Dispatch"
                hint={selectedNode.localModels.length > 0 ? `Using ${selectedNode.localModels[0]}` : undefined}
                busy={dispatching}
              />
            </div>
          )}

          <div>
            <h3 className="text-base font-semibold text-text-primary mb-2">Your runs</h3>
            {runsFailure && (
              <UnavailableNotice
                error={runsFailure}
                what="run history"
                source="Runs are read from Aurora"
                onRetry={refreshRuns}
                className="mb-3"
              />
            )}
            {!runsFailure && (
              <DataTable
                data={runs}
                keyField={(r) => r.id}
                columns={runColumns}
                striped
                emptyMessage="No runs yet."
              />
            )}
          </div>

          {selectedRunId && (
            <div>
              <Inline align="center" gap="sm" className="mb-2">
                <h3 className="text-base font-semibold text-text-primary">Log</h3>
                <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(null)}>Close</Button>
              </Inline>
              <RunLog jobId={selectedRunId} />
            </div>
          )}
        </Stack>
      )}
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
