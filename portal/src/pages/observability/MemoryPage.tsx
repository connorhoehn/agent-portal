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
import type { CSSProperties } from 'react';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';

// ── Types (mirrored from middleware/src/routes/memory.ts) ──────────────────

interface MemoryAgentStat {
  agentId: string;
  retrieves: number;
  writes: number;
  p50RetrieveMs: number;
  p99RetrieveMs: number;
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

const latencyTone = (n: number): Tone => {
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
  const [windowIdx, setWindowIdx] = useState(2); // 24h default
  const win = WINDOW_OPTIONS[windowIdx];

  const [agentFilter, setAgentFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<string>('');

  const { data: statsData } = useFetch<MemoryStatsResponse>(
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

  const { data: eventsData } = useFetch<MemoryEventsResponse>(
    `/api/observability/memory/events?${eventsParams}`,
    30_000,
  );
  const events = useMemo<MemoryEvent[]>(() => eventsData?.events ?? [], [eventsData]);

  const totalEvents = events.length;
  const totalColdSessions = useMemo(
    () => stats.reduce((acc, s) => acc + s.coldSessions, 0),
    [stats],
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <PageSection
      title="Memory"
      description={`${totalEvents} event${totalEvents === 1 ? '' : 's'} in last ${win.label} · ${totalColdSessions} cold session${totalColdSessions === 1 ? '' : 's'}`}
      actions={<WindowPicker value={windowIdx} onChange={setWindowIdx} />}
    >
      <Card padding="md">
        {stats.length === 0 ? (
          <SmartEmptyState
            title="No memory operations recorded"
            detail="Memory events surface once an agent emits retrieve/write spans inside its trace bundle."
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
                <TableTh>Retrieves</TableTh>
                <TableTh>Writes</TableTh>
                <TableTh>P50 latency</TableTh>
                <TableTh>P99 latency</TableTh>
                <TableTh>Error rate</TableTh>
                <TableTh>Cold sessions</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {stats.map((s) => (
                <TableRow key={s.agentId}>
                  <TableTd style={agentCell}>{s.agentId}</TableTd>
                  <TableTd style={numCell}>{s.retrieves}</TableTd>
                  <TableTd style={numCell}>{s.writes}</TableTd>
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
        <div style={headerRow}>
          <h2 style={h2}>
            Recent events{' '}
            <span style={hint}>
              click a row to inspect retrieved summary + error detail
            </span>
          </h2>
          <div style={filterRow}>
            <select
              value={agentFilter}
              onChange={(e) => { setAgentFilter(e.target.value); setExpanded(null); }}
              style={selectStyle}
            >
              <option value="">all agents</option>
              {stats.map((s) => (
                <option key={s.agentId} value={s.agentId}>{s.agentId}</option>
              ))}
            </select>
            <select
              value={kindFilter}
              onChange={(e) => { setKindFilter(e.target.value); setExpanded(null); }}
              style={selectStyle}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{k || 'all kinds'}</option>
              ))}
            </select>
          </div>
        </div>
        {events.length === 0 ? (
          <EmptyState text="No matching memory events in this window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Kind</TableTh>
                <TableTh>Query / memory</TableTh>
                <TableTh>Results</TableTh>
                <TableTh>Duration</TableTh>
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
                      style={{ cursor: 'pointer' }}
                    >
                      <TableTd style={tsCell}>
                        {new Date(e.ts).toLocaleTimeString()}
                      </TableTd>
                      <TableTd style={agentCell}>{e.agentId}</TableTd>
                      <TableTd>
                        <Chip tone={kindTone(e.kind)} size="xs">{e.kind}</Chip>
                      </TableTd>
                      <TableTd style={snippetCell} title={e.queryText ?? e.memoryId ?? ''}>
                        {e.queryText ?? e.memoryId ?? '—'}
                      </TableTd>
                      <TableTd style={numCell}>
                        {e.resultCount == null ? '—' : e.resultCount}
                      </TableTd>
                      <TableTd style={numCell}>{fmtMs(e.durationMs)}</TableTd>
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
                        <TableTd colSpan={7} style={detailCell}>
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
    </PageSection>
  );
}

function EventDetail({ event }: { event: MemoryEvent }) {
  return (
    <div style={detailGrid}>
      <div>
        <div style={detailLabel}>METADATA</div>
        <dl style={metaList}>
          <DT>session</DT><DD>{event.sessionId ?? '—'}</DD>
          <DT>memory id</DT><DD>{event.memoryId ?? '—'}</DD>
          <DT>invocation</DT><DD style={mono}>{event.invocationId ?? '—'}</DD>
          {event.queryText && (<><DT>query</DT><DD>{event.queryText}</DD></>)}
        </dl>
      </div>
      <div>
        <div style={detailLabel}>
          {event.errored ? 'ERROR' : 'RETRIEVED SUMMARY'}
        </div>
        {event.errored ? (
          <pre style={detailPre}>{event.errorMessage ?? '(no error message)'}</pre>
        ) : event.retrievedSummary ? (
          <pre style={detailPre}>{event.retrievedSummary}</pre>
        ) : (
          <pre style={{ ...detailPre, color: 'var(--color-text-tertiary)' }}>
            (no payload captured)
          </pre>
        )}
      </div>
    </div>
  );
}

function DT({ children }: { children: React.ReactNode }) {
  return <dt style={dtStyle}>{children}</dt>;
}
function DD({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return <dd style={{ ...ddStyle, ...style }}>{children}</dd>;
}

function WindowPicker({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {WINDOW_OPTIONS.map((w, i) => (
        <button
          key={w.label}
          onClick={() => onChange(i)}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: i === value ? 'var(--color-primary)' : 'var(--color-surface)',
            color: i === value ? 'white' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            fontWeight: i === value ? 500 : 400,
          }}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
      {text}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────

const headerRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 12, gap: 12, flexWrap: 'wrap',
};
const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const hint: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 };
const filterRow: CSSProperties = { display: 'flex', gap: 6 };
const selectStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)', color: 'var(--color-text-primary)',
};
const agentCell: CSSProperties = { fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };
const numCell: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)' };
const tsCell: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' };
const snippetCell: CSSProperties = {
  fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const detailCell: CSSProperties = { padding: 12, background: 'var(--color-bg)' };
const detailGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const detailLabel: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'var(--color-text-tertiary)',
  marginBottom: 4, letterSpacing: 0.5,
};
const detailPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  margin: 0, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  maxHeight: 220, overflowY: 'auto',
};
const metaList: CSSProperties = {
  margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px',
  fontSize: 11.5,
};
const dtStyle: CSSProperties = {
  fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase',
  fontSize: 10, letterSpacing: 0.5,
};
const ddStyle: CSSProperties = { margin: 0, color: 'var(--color-text-secondary)' };
const mono: CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 11 };

export default MemoryPage;
