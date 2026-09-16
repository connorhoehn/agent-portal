// Local machines, in Computer Lab — the paired-laptop half of the fleet.
//
// THE GAP THIS CLOSES. "I registered my computer as a local machine before I
// left, and it was pulling work — I should be able to see the logs of the
// machine, not just assign it work." Local compute (/iq/local-compute) already
// answers "what is this machine doing and how do I hand it work"; Computer
// Lab answers "what are my computers, and can I get into one" for the microVM
// fleet, and until now had nothing at all for a paired laptop — someone
// elsewhere with a machine that had been pulling work for hours had no way to
// check on it short of driving back to Local compute and remembering it was
// there. This section puts an entry per paired machine beside the microVM
// boxes, with presence, what it's running, and a log — deliberately NOT a
// second dispatch composer; that stays owned by Local compute.
//
// ⚠️ WHY THIS IS NOT FOLDED INTO <ComputerLab>. That composite
// (@connorhoehnslalom/ui-components/compute) is the microVM fleet's own
// primitive, and its `Computer` type carries no discriminator for "this is
// someone's laptop, not an AgentCore box" — folding local machines into it
// today would silently offer shell/terminal affordances a laptop cannot
// serve (docs/local-compute-presence.md's rule 3: never offer an affordance
// the machine can't back). The cross-repo primitive that fixes this
// (`Computer.kind?: 'microvm' | 'local'`) is still queued in
// docs/ui-components-queue.md. Until it ships, this section is composed
// locally from existing shared primitives (DataTable, PresenceDot, LogStream,
// EntityCell) — the honest "not yet unified" reading, not a hand-rolled
// substitute for the eventual primitive.

import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataTable,
  EntityCell,
  Inline,
  LogStream,
  MetaLine,
  PresenceDot,
  SectionLabel,
  Stack,
  T,
  type DataTableColumn,
  type LogLine,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { when, truncate } from './localComputeFormat';
import { nodeLogLines, type NodeLogEntry, type NodeLogLine } from './nodeLogLines';

// ─── Wire shapes ─────────────────────────────────────────────────────────────

interface NodePresenceWire {
  status: 'connected' | 'stale' | 'offline';
  lastSeenAt: string | null;
}

interface ComputeNodeWire {
  id: string;
  label: string;
  platform: string | null;
  acceptJobs: boolean;
  presence: NodePresenceWire;
}

interface RunRowWire {
  id: string;
  title: string;
  status: string;
  nodeId: string | null;
}

/** Presence maps onto the library's three-state dot; `stale` is its "away" —
 *  same mapping LocalComputePage.tsx uses. */
function presenceState(status: NodePresenceWire['status']): 'online' | 'away' | 'offline' {
  if (status === 'connected') return 'online';
  if (status === 'stale') return 'away';
  return 'offline';
}

// ─── The panel ───────────────────────────────────────────────────────────────

export function LocalMachinesLab({ className }: { className?: string } = {}) {
  const { data: nodesData, error: nodesError, degraded: nodesDegraded, refresh: refreshNodes } =
    useFetch<{ nodes: ComputeNodeWire[] }>('/api/local-compute/nodes', 15_000);
  const { data: runsData } = useFetch<{ runs: RunRowWire[] }>('/api/local-compute/runs', 15_000);
  const nodes = nodesData?.nodes ?? [];
  const runs = runsData?.runs ?? [];
  const failure = nodesError ?? nodesDegraded;

  const [openLogFor, setOpenLogFor] = useState<string | null>(null);
  const openNode = nodes.find((n) => n.id === openLogFor) ?? null;

  // Nothing paired, no failure: this is a genuinely empty state, and Computer
  // Lab already has its own "no computers" story for the microVM fleet below
  // — a second empty panel saying the same nothing would just be noise above
  // a page that otherwise works. Only render once there is something to show,
  // or a real failure to report.
  if (!failure && nodes.length === 0) return null;

  const columns: DataTableColumn<ComputeNodeWire>[] = [
    {
      key: 'label',
      header: 'Machine',
      render: (n) => <EntityCell label={n.label} id={n.platform ?? undefined} />,
    },
    {
      key: 'presence',
      header: 'Presence',
      render: (n) => (
        <Stack gap="none">
          <Inline gap="xs" align="center">
            <PresenceDot state={presenceState(n.presence.status)} label={n.presence.status} />
            {!n.acceptJobs && <Chip tone="neutral" size="xs">paused</Chip>}
          </Inline>
          <MetaLine
            size="xs"
            tone="tertiary"
            items={[n.presence.lastSeenAt ? `seen ${when(n.presence.lastSeenAt)}` : 'never seen']}
          />
        </Stack>
      ),
    },
    {
      key: 'running',
      header: 'Running',
      render: (n) => {
        const mine = runs.filter((r) => r.nodeId === n.id);
        const running = mine.find((r) => r.status === 'running');
        const queued = mine.filter((r) => r.status === 'queued' || r.status === 'claimed').length;
        if (running) return <Chip tone="accent" size="xs" dot="pulse">{truncate(running.title, 40)}</Chip>;
        if (queued > 0) return <MetaLine size="xs" items={[`${queued} queued`]} />;
        return <MetaLine size="xs" tone="tertiary" items={['idle']} />;
      },
    },
    {
      key: 'actions',
      header: '',
      render: (n) => (
        <Inline gap="xs" align="center" className="justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setOpenLogFor(n.id); }}
            aria-label={`View ${n.label}'s log`}
          >
            {openLogFor === n.id ? 'Viewing log' : 'View log'}
          </Button>
        </Inline>
      ),
    },
  ];

  return (
    <Card padding="md" className={className}>
      <Stack gap="sm">
        <Inline gap="sm" align="center">
          <SectionLabel>Your local machines</SectionLabel>
          <MetaLine
            size="xs"
            tone="tertiary"
            items={['A paired laptop or workstation — not a managed box. Hand it work from Local compute.']}
          />
        </Inline>

        {failure ? (
          <UnavailableNotice
            error={failure}
            what="your paired machines"
            source="Nodes are read from Aurora"
            onRetry={refreshNodes}
          />
        ) : (
          <DataTable
            data={nodes}
            keyField={(n) => n.id}
            columns={columns}
            onRowClick={(n) => setOpenLogFor(n.id === openLogFor ? null : n.id)}
            striped
            emptyMessage="No paired machines."
          />
        )}

        {openNode && (
          <Stack gap="xs">
            <Inline gap="sm" align="center">
              <SectionLabel>{`${openNode.label} — operational log`}</SectionLabel>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpenLogFor(null)}>Close</Button>
            </Inline>
            {/* Keyed on the node id: NodeLog's poll cursor must not survive a
                switch to a different machine's log. */}
            <NodeLog key={openNode.id} nodeId={openNode.id} />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

// ─── The log panel ───────────────────────────────────────────────────────────

interface NodeLogPayload {
  entries: NodeLogEntry[];
}

// The browser never needs to hold more lines than the server's own per-node
// ring ever carries — lib/local-compute-node-logs.ts's MAX_LINES_PER_NODE.
// Kept as a second, independent cap anyway: LogStream is not a windowed
// list, and a future server-side bump must not silently grow this panel's
// DOM node count along with it.
const NODE_LOG_LINE_CAP = 500;

const NODE_LOG_LEVEL: Record<NodeLogLine['level'], LogLine['level']> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function NodeLog({ nodeId }: { nodeId: string }) {
  // 3s poll while open — no SSE tail yet (the server route exists; this panel
  // opens rarely enough that the simpler poll is not worth a second live
  // connection type on this page). Stops when the panel closes: the caller
  // unmounts NodeLog rather than hiding it.
  const { data, error, degraded } = useFetch<NodeLogPayload>(`/api/local-compute/nodes/${nodeId}/log`, 3_000);
  const failure = error ?? degraded;

  const { lines, totalLines } = useMemo(() => {
    const parsed = nodeLogLines(data?.entries);
    const capped = parsed.length > NODE_LOG_LINE_CAP ? parsed.slice(parsed.length - NODE_LOG_LINE_CAP) : parsed;
    return {
      lines: capped.map((l) => ({ id: l.id, message: l.text, level: NODE_LOG_LEVEL[l.level] }) as LogLine),
      totalLines: parsed.length,
    };
  }, [data]);
  const truncated = totalLines > NODE_LOG_LINE_CAP;

  // A failed read is UnavailableNotice, never LogStream's own empty state —
  // "could not check on this machine" and "this machine has nothing to
  // report" are different facts, and rendering the first as a quiet empty
  // box is exactly the hang this feature exists to avoid.
  if (failure) {
    return (
      <UnavailableNotice
        error={failure}
        what="this machine's operational log"
        source="Shipped by the worker between jobs — see tools/local-compute-worker.mjs"
      />
    );
  }

  return (
    <LogStream
      lines={lines}
      follow
      maxHeight="320px"
      tone="surface"
      emptyMessage="No operational log yet — either this worker predates the feature (older workers only ship per-job output), or it hasn't shipped a line since the middleware last restarted."
      headerSlot={truncated ? (
        <T className="text-text-tertiary">{`Showing the most recent ${lines.length.toLocaleString('en-US')} of ${totalLines.toLocaleString('en-US')} lines`}</T>
      ) : undefined}
    />
  );
}
