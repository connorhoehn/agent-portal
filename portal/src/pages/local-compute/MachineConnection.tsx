// Connection details and live performance for one machine.
//
// What was missing, in the words of the person who uses this page: nothing
// showed the connection status, the command that starts the worker polling,
// whether it was running, stopped or failed, or a way to refresh. The row in
// the table above carries a presence chip and nothing else — you could not
// tell a laptop that is working from one whose worker died three minutes ago,
// because "offline" is what both look like once the heartbeat lapses.
//
// The first build of this panel answered those questions but piled every
// answer into one column, so the numbers, the meters and the capability list
// ran together into a wall. This one separates them by KIND, because they get
// read at different moments: a header that says whether to worry, a grid of
// counters you scan, a grid of performance figures you scan the same way, and
// the standing facts (models, kinds, the command) folded away until you go
// looking. Everything is a ui-components composite — DetailHeader, KPIGrid,
// StatCard, CollapsibleSection — rather than rows of hand-spaced text.
import { useMemo } from 'react';
import {
  Banner,
  Card,
  Chip,
  CodeBlock,
  DetailHeader,
  Inline,
  MetaLine,
  PresenceDot,
  Stack,
  ThinkingDots,
} from '@connorhoehnslalom/ui-components/shared';
import { KeyValue } from '../../components/KeyValue';
import { absoluteTime } from '../../lib/relativeTime';
import { elapsedLabel, isLive, when, type JobStatus } from './localComputeFormat';
import { WORKER_COMMAND } from './PairMachineDialog';

export interface MachineMetrics {
  loadAvg1?: number;
  cpuCount?: number;
  memTotalMb?: number;
  memFreeMb?: number;
  uptimeS?: number;
  workerVersion?: string;
  activeJobs?: number;
  at?: string;
}

export interface ConnectionMachine {
  id: string;
  label: string;
  acceptJobs: boolean;
  jobKinds: string[];
  localModels: string[];
  maxConcurrency?: number;
  presence: { status: 'connected' | 'stale' | 'offline'; lastSeenAt: string | null; sessions?: unknown[] };
  metrics?: MachineMetrics | null;
}

export interface ConnectionJobs {
  running: number;
  queued: number;
  failedRecently: number;
  currentTitle?: string | null;
  currentStatus?: JobStatus | null;
  currentSince?: string | null;
}

/** Presence maps onto the library's three-state dot; `stale` is its "away". */
function presenceState(status: ConnectionMachine['presence']['status']): 'online' | 'away' | 'offline' {
  if (status === 'connected') return 'online';
  if (status === 'stale') return 'away';
  return 'offline';
}

/**
 * The sentence under the machine's name. Deliberately different for every
 * state — "offline" with no explanation was the thing that made a first-time
 * pairing look like a failed one.
 */
function connectionSentence(m: ConnectionMachine, live: boolean): string {
  if (m.presence.status === 'connected') {
    if (live) return 'Connected and working.';
    return m.acceptJobs ? 'Connected and idle, waiting for work.' : 'Connected, but not accepting work.';
  }
  if (m.presence.status === 'stale') return 'Last heartbeat is late — the worker may be busy, paused or gone.';
  if (m.jobKinds.length === 0) return 'Never connected: its worker has not run yet.';
  return 'Offline — the worker is not running, so nothing will be claimed.';
}

/** Whole gigabytes, one decimal — 44.4G reads; 45426MB does not. */
function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)}G`;
}

export function MachineConnection({
  machine,
  jobs,
  now,
  streamLive,
}: {
  machine: ConnectionMachine;
  jobs: ConnectionJobs;
  now: number;
  /** True while the live event stream is attached, so the pane can say whether what it shows is pushed or polled. */
  streamLive: boolean;
}) {
  const metrics = machine.metrics ?? null;
  const live = jobs.currentStatus != null && isLive(jobs.currentStatus);
  const sinceHeartbeat = elapsedLabel(machine.presence.lastSeenAt, now);
  const connected = machine.presence.status === 'connected';

  const memory = useMemo(() => {
    if (!metrics?.memTotalMb || metrics.memFreeMb == null) return null;
    const used = metrics.memTotalMb - metrics.memFreeMb;
    return { pct: Math.round((used / metrics.memTotalMb) * 100), used, total: metrics.memTotalMb };
  }, [metrics]);

  const loadPct = metrics?.loadAvg1 != null && metrics.cpuCount
    ? Math.round((metrics.loadAvg1 / metrics.cpuCount) * 100)
    : null;

  return (
    <Card padding="md" data-testid="machine-connection">
      <Stack gap="md">
        <DetailHeader
          as="h3"
          title={machine.label}
          badge={<PresenceDot state={presenceState(machine.presence.status)} label={machine.presence.status} />}
          description={connectionSentence(machine, live)}
          meta={live && jobs.currentTitle ? (
            <Inline gap="xs" align="center">
              <ThinkingDots size="sm" />
              <MetaLine
                size="xs"
                aria-live="polite"
                items={[`Now: ${jobs.currentTitle}`, elapsedLabel(jobs.currentSince, now) ?? null].filter(Boolean) as string[]}
              />
            </Inline>
          ) : undefined}
          aside={(
            // Inline, not a bare Chip: DetailHeader's aside is a block, and a
            // Chip handed to it stretches the full width of the slot — a
            // status pill the width of a paragraph reads as a banner.
            <Inline gap="xs" align="center" className="justify-end">
            <Chip tone={streamLive ? 'success' : 'neutral'} size="xs" dot={streamLive ? 'pulse' : undefined}>
              {/* Which of the two it is, because "live" is a claim the page
                  should be able to back up: the stream pushes state changes,
                  the poll is the floor underneath it. Refresh lives on the
                  machine row, not here — one button, where the machine is. */}
              {streamLive ? 'live' : 'polled'}
            </Chip>
            </Inline>
          )}
        />

        {/* No counters here. The machines table one block up already carries
            presence, the ticking heartbeat, load, memory and the running /
            queued / failed chips — repeating them in this pane was the page
            saying the same four numbers twice, in two different typographies,
            and it is what made the first version of this panel so tall. This
            pane is for what a ROW cannot hold: the facts you look up rather
            than scan, and the command you copy. */}
        {metrics ? (
          <Stack gap="sm">
            <KeyValue layout="row" labelWidth="w-36" label="Worker version" value={metrics.workerVersion ?? 'unknown'} mono />
            <KeyValue
              layout="row"
              labelWidth="w-36"
              label="Machine uptime"
              value={metrics.uptimeS != null
                ? (elapsedLabel(new Date(now - metrics.uptimeS * 1000).toISOString(), now) ?? '—')
                : 'not reported'}
            />
            <KeyValue
              layout="row"
              labelWidth="w-36"
              label="Concurrency"
              value={machine.maxConcurrency != null
                ? `${metrics.activeJobs ?? 0} in flight of ${machine.maxConcurrency} slots`
                : `${metrics.activeJobs ?? 0} in flight`}
            />
            <KeyValue layout="row" labelWidth="w-36" label="Metrics reported" value={when(metrics.at)} />
          </Stack>
        ) : (
          <MetaLine
            size="xs"
            tone="tertiary"
            items={['This worker reports no performance metrics — update it on the machine to see load, memory and uptime here.']}
          />
        )}

        <Stack gap="sm">
          <KeyValue layout="row" labelWidth="w-36" label="Models" mono value={machine.localModels.length > 0 ? machine.localModels.join(', ') : 'none announced'} />
          <KeyValue layout="row" labelWidth="w-36" label="Job kinds" mono value={machine.jobKinds.length > 0 ? machine.jobKinds.join(', ') : 'none announced'} />
          <KeyValue layout="row" labelWidth="w-36" label="Accepting work" value={machine.acceptJobs ? 'yes' : 'no — switch it on in the row above'} />
        </Stack>

        {/* Not connected is the one state where the command IS the point of
            the panel, so it sits open. Otherwise the standing facts fold away
            until someone goes looking, which is what stopped this card from
            being a wall of label-value pairs. */}
        {!connected ? (
          <Stack gap="xs">
            <Banner variant={machine.jobKinds.length === 0 ? 'warning' : 'info'}>
              {machine.jobKinds.length === 0
                ? 'Pairing registered this machine; the worker is what makes it claim work. On that machine, from the repo checkout:'
                : 'Start the worker again on that machine, from the repo checkout:'}
            </Banner>
            <CodeBlock code={WORKER_COMMAND} language="bash" copyButton ariaLabel="Worker command" />
          </Stack>
        ) : (
          <Stack gap="xs">
            <MetaLine size="xs" tone="tertiary" items={['Start this machine polling again after a restart. It reads the token pairing wrote; it never asks for one.']} />
            <CodeBlock code={WORKER_COMMAND} language="bash" copyButton ariaLabel="Worker command" />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
