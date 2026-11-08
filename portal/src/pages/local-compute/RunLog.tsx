// The run console: a job's `claude -p` transcript, decoded.
//
// Extracted from LocalComputePage so the Computer Lab can render it too.
// The Lab pane used to show ONLY `NodeLog` — the worker's own lifecycle
// lines — because that is the channel `components/compute/localMachines.tsx`
// wired to it. The transcript rides a different channel
// (`POST /api/local-compute/jobs/:id/log`, shipped by `shipLog` in
// tools/local-compute-worker.mjs), so a reader watching a machine work saw
// "claimed job-c369… · running" and then the PATH to a transcript whose
// contents never appeared. Piping those bytes into the node log instead
// would evict the lifecycle lines within seconds: that ring is capped at 500
// lines / 256KB (middleware/src/lib/local-compute-node-logs.ts) and
// stream-json emits a JSON object per line. Two channels, two readers, one
// decoder — this module.

import { useEffect, useMemo, useState } from 'react';
import { LogStream, T, type LogLine } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { runLogLines, type RunLogLine } from './runLogLines';

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

/** How each parsed line is toned in the stream. A tool result that failed and
 *  a run that failed are the only two things worth colouring as trouble. */
const LOG_LEVEL: Record<RunLogLine['kind'], LogLine['level']> = {
  meta: 'debug',
  text: 'info',
  tool: 'info',
  result: 'info',
  raw: 'debug',
  error: 'error',
};

export function RunLog({ jobId }: { jobId: string }) {
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
  //
  // The transform is the fix for "the console doesn't update": it always did,
  // but the worker ships `claude -p --output-format stream-json` verbatim, so
  // each poll appended another `{"type":"assistant","message":{"id":"msg_01…`
  // and nothing a reader could follow ever changed. runLogLines turns those
  // frames into the same vocabulary the devbox timeline uses.
  const { lines, totalLines } = useMemo(() => {
    const parsed = runLogLines(data?.entries);
    const capped = parsed.length > RUN_LOG_LINE_CAP ? parsed.slice(parsed.length - RUN_LOG_LINE_CAP) : parsed;
    return {
      lines: capped.map((l) => ({ id: l.id, message: l.text, level: LOG_LEVEL[l.kind] }) as LogLine),
      totalLines: parsed.length,
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
