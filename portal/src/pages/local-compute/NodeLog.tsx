// A paired machine's operational log, rendered as a Computer Lab pane.
//
// This is all that survives of LocalMachinesLab, the band that used to render
// ABOVE <ComputerLab> while the lab itself reported "0 computers · nothing
// here" and told you to provision one. The machines are IN the lab now —
// components/compute/localMachines.tsx puts them in the fleet the
// ComputeProvider serves — so the table, the presence column and the
// open/close plumbing went with it. A machine is a rail entry, and this is
// what its pane renders.

import { useMemo } from 'react';
import { LogStream, type LogLine } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { nodeLogLines, type NodeLogEntry, type NodeLogLine } from './nodeLogLines';

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

export function NodeLog({ nodeId }: { nodeId: string }) {
  // 3s poll while the pane is open — no SSE tail yet (the server route exists;
  // a pane opens rarely enough that the simpler poll is not worth a second
  // live connection type here). Stops when the pane closes: the lab unmounts
  // this rather than hiding it.
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
        <span className="text-text-tertiary">{`Showing the most recent ${lines.length.toLocaleString('en-US')} of ${totalLines.toLocaleString('en-US')} lines`}</span>
      ) : undefined}
    />
  );
}
