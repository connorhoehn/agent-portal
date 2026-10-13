// AgentCore Memory observability dashboard.
//
// Surfaces the M11 telemetry that today is invisible to middleware: which
// memories an agent retrieved, retrieval latency, write volume, and "cold
// sessions" — sessions where every retrieve returned 0 results (a strong
// signal that memory isn't warming up yet).
//
// Data sources (all under /api/observability/memory):
//   GET /stats?windowHours=        — per-agent rollup
//   GET /events?agentId=&kind=&limit= — recent event feed
//
// Polling: 30s, matches DriftPage.

import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Card,
  CardHeader,
  Chip,
  CodeBlock,
  Inline,
  PageSection,
  SearchInput,
  SectionLabel,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded, readDegraded } from '../../lib/degraded';
import { KeyValue } from '../../components/KeyValue';
import { WindowPicker, useWindowUrlState } from './WindowPicker';
import { relativeTime } from '../../lib/relativeTime';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { ObservabilityCommandSection } from './ObservabilityCommandSection';
import { OBSERVABILITY_GRAMMARS, matchesAny, memoryEventTarget } from './observabilityCommands';

// ── Types (mirrored from middleware/src/routes/memory.ts) ──────────────────

interface MemoryAgentStat {
  agentId: string;
  retrieves: number;
  writes: number;
  p50RetrieveMs: number | null;
  p99RetrieveMs: number | null;
  errorRate: number;
  coldSessions: number;
}

interface MemoryStatsResponse {
  byAgent: MemoryAgentStat[];
  windowHours: number;
}

interface MemoryEvent {
  memoryEventId: string;
  invocationId: string | null;
  agentId: string;
  sessionId: string | null;
  kind: string;
  memoryId: string | null;
  queryText: string | null;
  resultCount: number | null;
  durationMs: number | null;
  retrievedSummary: string | null;
  errored: boolean;
  errorMessage: string | null;
  ts: string;
}

interface MemoryEventsResponse {
  events: MemoryEvent[];
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

// Window options match DriftPage so cross-page mental model stays consistent.
const WINDOW_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: '1h',  hours: 1 },
  { label: '6h',  hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d',  hours: 168 },
];

const fmtMs = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1) return '<1ms';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
};

const fmtPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const coldTone = (n: number): Tone => {
  if (n === 0) return 'success';
  if (n <= 5) return 'warning';
  return 'danger';
};

const errorRateTone = (n: number): Tone => {
  if (n === 0) return 'success';
  if (n < 0.05) return 'warning';
  return 'danger';
};

const latencyTone = (n: number | null | undefined): Tone => {
  // No retrieve in the window is not a fast one. `success` on a null read as a
  // green "<1ms" chip for an agent that had never touched memory at all.
  if (n == null || !Number.isFinite(n)) return 'neutral';
  if (n <= 200) return 'success';
  if (n <= 1000) return 'warning';
  return 'danger';
};

const kindTone = (kind: string): Tone => {
  if (kind === 'retrieve') return 'neutral';
  if (kind === 'write') return 'success';
  if (kind === 'summarize') return 'warning';
  if (kind === 'expire') return 'danger';
  return 'neutral';
};

const KIND_OPTIONS = ['', 'retrieve', 'write', 'summarize', 'expire'];

function MemoryPage() {
  const [windowIdx, setWindowIdx] = useWindowUrlState(WINDOW_OPTIONS, 2); // 24h default, ?window=
  const win = WINDOW_OPTIONS[windowIdx];

  const [agentFilter, setAgentFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<string>('');

  const {
    data: statsData, error: statsError, refresh: refreshStats,
  } = useFetch<MemoryStatsResponse>(
    `/api/observability/memory/stats?windowHours=${win.hours}`,
    30_000,
  );
  const stats = useMemo<MemoryAgentStat[]>(
    () => statsData?.byAgent ?? [],
    [statsData],
  );

  const eventsParams = useMemo(() => {
    const u = new URLSearchParams();
    u.set('limit', '100');
    if (agentFilter) u.set('agentId', agentFilter);
    if (kindFilter) u.set('kind', kindFilter);
    return u.toString();
  }, [agentFilter, kindFilter]);

  const { data: eventsData, refresh: refreshEvents } = useFetch<MemoryEventsResponse>(
    `/api/observability/memory/events?${eventsParams}`,
    30_000,
  );
  const loadedEvents = useMemo<MemoryEvent[]>(() => eventsData?.events ?? [], [eventsData]);
  // Search is local over the loaded feed; the agent and kind filters are
  // query parameters on the read itself.
  const [query, setQuery] = useState('');
  const events = useMemo<MemoryEvent[]>(
    () => loadedEvents.filter((e) => matchesAny(query, e.memoryEventId, e.agentId, e.sessionId, e.memoryId, e.queryText, e.invocationId)),
    [loadedEvents, query],
  );

  const totalEvents = loadedEvents.length;
  const totalColdSessions = useMemo(
    () => stats.reduce((acc, s) => acc + s.coldSessions, 0),
    [stats],
  );

  // Both reads hit the same observability tables; when the read fails they
  // answer 200 with `{ byAgent: [] }` / `{ events: [] }`, which draws as an
  // agent fleet that has simply never touched memory.
  const memoryDegraded = firstDegraded(statsData, eventsData);
  // Both counts in the description come from `statsData`. A failed stats read
  // counted "0 events · 0 cold sessions", which reads as a fleet that never
  // touched memory — the body below already says the read failed, so the
  // header was contradicting it.
  const statsBlind = readDegraded(statsData);

  const [expanded, setExpanded] = useState<string | null>(null);

  const adapter = collectionCommandAdapter(OBSERVABILITY_GRAMMARS.memory, {
    setQuery,
    // The kind filter is the one the grammar names; clearing it also returns
    // the agent selector to all agents.
    setFilter: (value) => {
      setExpanded(null);
      if (KIND_OPTIONS.includes(value) && value) { setKindFilter(value); return; }
      setKindFilter(''); setAgentFilter('');
    },
    refresh: () => { refreshStats(); refreshEvents(); },
    scopeNote: 'Search matches the loaded recent events; the filter is the event kind. Open expands one exact event ID, as clicking its row does. The window stays as selected, and nothing here writes to or expires memory.',
    open(target) {
      if (!eventsData) throw new Error('Wait for the recent events to load before opening one.');
      const { id } = resolveCollectionTarget(target, events.map(memoryEventTarget));
      setExpanded(id);
      return `Showing event ${id}.`;
    },
  });

  return (
    <PageSection
      title="Memory"
      description={
        statsBlind
          ? `Memory activity in last ${win.label} could not be read`
          : `${totalEvents} event${totalEvents === 1 ? '' : 's'} in last ${win.label} · ${totalColdSessions} cold session${totalColdSessions === 1 ? '' : 's'}`
      }
      actions={<WindowPicker options={WINDOW_OPTIONS} value={windowIdx} onChange={setWindowIdx} />}
    >
      <ObservabilityCommandSection adapter={adapter}>
      {(statsError || memoryDegraded) && (
        <UnavailableNotice
          error={statsError ?? memoryDegraded ?? 'the memory query failed'}
          what="memory activity"
          source="Memory events are projected into the Aurora observability tables"
          onRetry={refreshStats}
          className="mb-4"
        />
      )}

      <Card padding="md">
        {stats.length === 0 ? (
          <SmartEmptyState
            title="No memory operations recorded"
            detail="Memory events surface once an agent emits retrieve/write spans inside its trace bundle."
            degraded={memoryDegraded}
            degradedWhat="the per-agent memory rollup"
            degradedSource="Memory events are projected into the Aurora observability tables"
            onRetry={refreshStats}
            actions={[
              {
                label: 'Seed synthetic memory events',
                detail: 'Inserts ~50 retrieve/write rows so charts populate immediately.',
                code: 'python3 infra/scripts/seed_memory_guardrail_events.py',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh numeric>Retrieves</TableTh>
                <TableTh numeric>Writes</TableTh>
                <TableTh>P50 latency</TableTh>
                <TableTh>P99 latency</TableTh>
                <TableTh>Error rate</TableTh>
                <TableTh>Cold sessions</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {stats.map((s) => (
                <TableRow key={s.agentId}>
                  <TableTd className="whitespace-nowrap">{s.agentId}</TableTd>
                  <TableTd numeric>{s.retrieves}</TableTd>
                  <TableTd numeric>{s.writes}</TableTd>
                  <TableTd>
                    <Chip tone={latencyTone(s.p50RetrieveMs)} size="xs">
                      {fmtMs(s.p50RetrieveMs)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={latencyTone(s.p99RetrieveMs)} size="xs">
                      {fmtMs(s.p99RetrieveMs)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={errorRateTone(s.errorRate)} size="xs">
                      {fmtPct(s.errorRate)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={coldTone(s.coldSessions)} size="xs">
                      {s.coldSessions}
                    </Chip>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <CardHeader
          title="Recent events"
          subtitle="click a row to inspect retrieved summary + error detail"
          action={
            <Inline gap="xs">
              <SearchInput
                value={query}
                onChange={(v) => { setQuery(v); setExpanded(null); }}
                placeholder="Search events"
                aria-label="Search memory events"
                className="w-[180px]"
              />
              <Select
                aria-label="Filter by agent"
                size="sm"
                value={agentFilter}
                onChange={(e) => { setAgentFilter(e.target.value); setExpanded(null); }}
                options={[
                  { value: '', label: 'all agents' },
                  ...stats.map((s) => ({ value: s.agentId, label: s.agentId })),
                ]}
              />
              <Select
                aria-label="Filter by kind"
                size="sm"
                value={kindFilter}
                onChange={(e) => { setKindFilter(e.target.value); setExpanded(null); }}
                options={KIND_OPTIONS.map((k) => ({ value: k, label: k || 'all kinds' }))}
              />
            </Inline>
          }
        />
        {events.length === 0 ? (
          <EmptyState text="No matching memory events in this window." degraded={memoryDegraded} />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>When</TableTh>
                <TableTh>Kind</TableTh>
                <TableTh>Query / memory</TableTh>
                <TableTh numeric>Results</TableTh>
                <TableTh numeric>Duration</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((e) => {
                const isOpen = expanded === e.memoryEventId;
                return (
                  <Fragment key={e.memoryEventId}>
                    <TableRow
                      onClick={() => setExpanded(isOpen ? null : e.memoryEventId)}
                      className="cursor-pointer"
                    >
                      <TableTd className="whitespace-nowrap">{e.agentId}</TableTd>
                      <TableTd className="whitespace-nowrap" title={new Date(e.ts).toLocaleString()}>
                        {relativeTime(e.ts)}
                      </TableTd>
                      <TableTd>
                        <Chip tone={kindTone(e.kind)} size="xs">{e.kind}</Chip>
                      </TableTd>
                      <TableTd className="max-w-[320px] truncate" title={e.queryText ?? e.memoryId ?? ''}>
                        {e.queryText ?? e.memoryId ?? '—'}
                      </TableTd>
                      <TableTd numeric>
                        {e.resultCount == null ? '—' : e.resultCount}
                      </TableTd>
                      <TableTd numeric>{fmtMs(e.durationMs)}</TableTd>
                      <TableTd>
                        {e.errored ? (
                          <Chip tone="danger" size="xs">error</Chip>
                        ) : e.kind === 'retrieve' && e.resultCount === 0 ? (
                          <Chip tone="warning" size="xs">cold</Chip>
                        ) : (
                          <Chip tone="success" size="xs">ok</Chip>
                        )}
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${e.memoryEventId}-detail`}>
                        <TableTd colSpan={7} className="p-3 bg-bg">
                          <EventDetail event={e} />
                        </TableTd>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      </ObservabilityCommandSection>
    </PageSection>
  );
}

function EventDetail({ event }: { event: MemoryEvent }) {
  return (
    <Inline gap="md" align="start">
      <Stack gap="xs" className="flex-1 min-w-0">
        <SectionLabel as="div">Metadata</SectionLabel>
        <Stack gap="xs">
          <KeyValue layout="row" label="session" value={event.sessionId ?? '—'} />
          <KeyValue layout="row" label="memory id" value={event.memoryId ?? '—'} />
          <KeyValue layout="row" label="invocation" value={event.invocationId ?? '—'} mono />
          {event.queryText && <KeyValue layout="row" label="query" value={event.queryText} />}
        </Stack>
      </Stack>
      <Stack gap="xs" className="flex-1 min-w-0">
        <T as="div" size="xs" weight="semibold" tone="tertiary">
          {event.errored ? 'ERROR' : 'RETRIEVED SUMMARY'}
        </T>
        {event.errored ? (
          <CodeBlock code={event.errorMessage ?? '(no error message)'} language="text" />
        ) : event.retrievedSummary ? (
          <CodeBlock code={event.retrievedSummary} language="text" />
        ) : (
          <T size="xs" tone="tertiary" className="italic">(no payload captured)</T>
        )}
      </Stack>
    </Inline>
  );
}


// Row-level "nothing here" that will not say so when it does not know.
function EmptyState({ text, degraded }: { text: string; degraded?: string | null }) {
  if (degraded) {
    return (
      <T as="div" size="xs" className="p-6 text-center text-danger">
        Unknown — this read failed ({degraded}).
      </T>
    );
  }
  return (
    <T as="div" size="xs" tone="tertiary" className="p-6 text-center">
      {text}
    </T>
  );
}

export default MemoryPage;
