// TrafficPage — Sprint 4 (M13): production traffic shape.
//
// Four sections:
//   1. Header strip with totals + window picker.
//   2. RPS-over-time stacked AreaChart (Recharts).
//   3. 7×24 hour-of-week heatmap (plain CSS grid, no recharts — denser).
//   4. Top users table (link to invocation search filtered by user).
//   5. Per-agent operational summary (RPS / P50 / P99 / err / cost chips).
//
// Data sources (all under /api/observability/traffic, polled every 30s):
//   GET /rps?windowHours=&bucketMin=
//   GET /heatmap?days=7
//   GET /top-users?windowHours=&limit=10
//   GET /per-agent-summary?windowHours=

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useFetch } from '../../hooks/useFetch';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';

// ── Types ───────────────────────────────────────────────────────────────────

interface RpsPoint {
  bucketStart: string;
  agentId: string;
  invocations: number;
  uniqueUsers: number;
  uniqueSessions: number;
}
interface RpsResponse {
  points: RpsPoint[];
  bucketMin: number;
  windowHours: number;
}

interface HeatmapCell {
  dayOfWeek: number; // 0..6 (Sun..Sat)
  hourOfDay: number; // 0..23
  count: number;
}
interface HeatmapResponse {
  cells: HeatmapCell[];
  days: number;
}

interface TopUserRow {
  userId: string;
  invocations: number;
  uniqueAgents: number;
  totalCostUsd: number;
  lastSeenAt: string;
}
interface TopUsersResponse {
  users: TopUserRow[];
  windowHours: number;
}

interface PerAgentSummaryRow {
  agentId: string;
  invocations: number;
  rps: number;
  p50DurationMs: number | null;
  p99DurationMs: number | null;
  errorRate: number;
  totalCostUsd: number;
}
interface PerAgentSummaryResponse {
  byAgent: PerAgentSummaryRow[];
  windowHours: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: Array<{ label: string; hours: number; bucket: number }> = [
  { label: '1h',  hours: 1,   bucket: 5  },
  { label: '24h', hours: 24,  bucket: 30 },
  { label: '7d',  hours: 168, bucket: 360 },
  { label: '30d', hours: 720, bucket: 1440 },
];

// Match drift / cost palettes — stable per-agent colors across pages.
const AGENT_COLORS = [
  '#6366f1', '#ec4899', '#10b981', '#f59e0b',
  '#06b6d4', '#a855f7', '#ef4444', '#84cc16',
];
const colorFor = (idx: number) => AGENT_COLORS[idx % AGENT_COLORS.length];

// Mon-first day-of-week labels. Postgres' dow uses Sun=0..Sat=6 — we re-order
// rows to Mon..Sun because that's how everyone reads a workweek heatmap.
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const POSTGRES_TO_MON_FIRST = [6, 0, 1, 2, 3, 4, 5]; // dow=0(Sun)→row 6, dow=1(Mon)→row 0, ...

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toLocaleString();
}

function fmtUsd(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const d = digits ?? (n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
  return `$${n.toFixed(d)}`;
}

function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

function fmtRps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 0.001) return n.toExponential(1);
  if (n < 1) return n.toFixed(3);
  return n.toFixed(2);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function shortTime(iso: string, hours: number): string {
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T');
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return iso;
  if (hours <= 6 || hours <= 48) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit' })
  );
}

// Threshold-chip tone helpers — same pattern as Drift Rollup.
const rpsTone = (rps: number): 'success' | 'warning' | 'danger' | 'neutral' => {
  if (rps === 0) return 'neutral';
  if (rps >= 1) return 'danger';     // sustained 1+ RPS = serious traffic
  if (rps >= 0.1) return 'warning';
  return 'success';
};
const errorTone = (r: number): 'success' | 'warning' | 'danger' => {
  if (r >= 0.05) return 'danger';
  if (r >= 0.01) return 'warning';
  return 'success';
};
const costTone = (c: number): 'success' | 'warning' | 'danger' => {
  if (c >= 1)   return 'danger';
  if (c >= 0.1) return 'warning';
  return 'success';
};

// ── Page ────────────────────────────────────────────────────────────────────

function TrafficPage() {
  const [windowIdx, setWindowIdx] = useState(1); // 24h default
  const win = WINDOW_OPTIONS[windowIdx];

  const { data: rpsData } = useFetch<RpsResponse>(
    `/api/observability/traffic/rps?windowHours=${win.hours}&bucketMin=${win.bucket}`,
    30_000,
  );
  const { data: heatmapData } = useFetch<HeatmapResponse>(
    `/api/observability/traffic/heatmap?days=7`,
    60_000,
  );
  const { data: topUsersData } = useFetch<TopUsersResponse>(
    `/api/observability/traffic/top-users?windowHours=${win.hours}&limit=10`,
    30_000,
  );
  const { data: perAgentData } = useFetch<PerAgentSummaryResponse>(
    `/api/observability/traffic/per-agent-summary?windowHours=${win.hours}`,
    30_000,
  );

  const rpsPoints = useMemo(() => rpsData?.points ?? [], [rpsData]);
  const heatmapCells = useMemo(() => heatmapData?.cells ?? [], [heatmapData]);
  const topUsers = useMemo(() => topUsersData?.users ?? [], [topUsersData]);
  const perAgent = useMemo(() => perAgentData?.byAgent ?? [], [perAgentData]);

  // Roll up totals from per-agent summary (which is computed over the same
  // window). This avoids a second /total round-trip.
  const totals = useMemo(() => {
    let inv = 0;
    let cost = 0;
    for (const a of perAgent) {
      inv += a.invocations;
      cost += a.totalCostUsd ?? 0;
    }
    const avgRps = win.hours > 0 ? inv / (win.hours * 3600) : 0;
    const uniqueUsers = topUsers.length;
    return { inv, cost, avgRps, uniqueUsers };
  }, [perAgent, win.hours, topUsers]);

  // Reshape time-series → one row per bucket with per-agent stacked columns.
  const { chartData, agentList } = useMemo(() => {
    const byBucket = new Map<string, Record<string, number | string>>();
    const agentSet = new Set<string>();
    for (const p of rpsPoints) {
      agentSet.add(p.agentId);
      let row = byBucket.get(p.bucketStart);
      if (!row) {
        row = {
          bucketStart: p.bucketStart,
          label: shortTime(p.bucketStart, win.hours),
        };
        byBucket.set(p.bucketStart, row);
      }
      row[p.agentId] = p.invocations;
    }
    const ordered = Array.from(byBucket.values()).sort((a, b) =>
      String(a.bucketStart).localeCompare(String(b.bucketStart)),
    );
    return { chartData: ordered, agentList: Array.from(agentSet).sort() };
  }, [rpsPoints, win.hours]);

  // Heatmap grid: 7 rows (Mon..Sun) × 24 columns (0..23). Index by mon-first
  // row so the visual layout reads naturally.
  const heatmapGrid = useMemo(() => {
    const grid: number[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => 0),
    );
    for (const c of heatmapCells) {
      const row = POSTGRES_TO_MON_FIRST[c.dayOfWeek] ?? 0;
      const col = Math.max(0, Math.min(23, c.hourOfDay));
      grid[row][col] = c.count;
    }
    let max = 0;
    for (const row of grid) for (const v of row) if (v > max) max = v;
    return { grid, max };
  }, [heatmapCells]);

  function heatmapTone(count: number, max: number): string {
    if (count === 0 || max <= 0) return 'var(--color-surface)';
    const t = Math.min(1, count / max);
    // 5-bucket palette of indigo intensities (--color-primary is indigo).
    if (t < 0.2) return 'rgba(99,102,241,0.10)';
    if (t < 0.4) return 'rgba(99,102,241,0.25)';
    if (t < 0.6) return 'rgba(99,102,241,0.45)';
    if (t < 0.8) return 'rgba(99,102,241,0.70)';
    return 'rgba(99,102,241,0.95)';
  }

  const headerSubline =
    `${fmtInt(totals.inv)} invocation${totals.inv === 1 ? '' : 's'} in last ${win.label} · ` +
    `${fmtRps(totals.avgRps)} RPS avg · ` +
    `${fmtInt(totals.uniqueUsers)} unique user${totals.uniqueUsers === 1 ? '' : 's'}`;

  return (
    <div style={pageStyle}>
      <Card padding="md">
        <div style={headerRow}>
          <div>
            <h2 style={h2}>Traffic</h2>
            <div style={subline}>{headerSubline}</div>
          </div>
          <WindowPicker value={windowIdx} onChange={setWindowIdx} />
        </div>

        <div style={headlineRow}>
          <HeadlineCard
            label="Total invocations"
            primary={fmtInt(totals.inv)}
            secondary={`across ${perAgent.length} agent${perAgent.length === 1 ? '' : 's'} in ${win.label}`}
          />
          <HeadlineCard
            label="Average RPS"
            primary={fmtRps(totals.avgRps)}
            secondary={`smoothed over the full ${win.label} window`}
          />
          <HeadlineCard
            label="Spend"
            primary={fmtUsd(totals.cost)}
            secondary={`Bedrock + judge for this window`}
          />
        </div>
      </Card>

      {/* RPS-over-time stacked-area chart. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            RPS Over Time{' '}
            <span style={hint}>
              stacked invocations per agent · bucket {win.bucket}m · window {win.label}
            </span>
          </h2>
        </div>
        {chartData.length === 0 ? (
          <SmartEmptyState
            title="No traffic"
            detail="RPS, heatmap, and top-user panels populate once traces land. Backfill user_id columns afterward so the top-user table is non-empty."
            actions={[
              {
                label: 'Run the test harness',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
              {
                label: 'Backfill user_id on traces',
                code: 'python3 infra/scripts/seed_user_ids_on_traces.py',
              },
            ]}
          />
        ) : (
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <AreaChart data={chartData} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={50}
                  tickFormatter={(v: number) => fmtInt(v)}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  formatter={(v: unknown) =>
                    fmtInt(typeof v === 'number' ? v : Number(v))
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="square" />
                {agentList.map((a, i) => (
                  <Area
                    key={a}
                    type="monotone"
                    dataKey={a}
                    stackId="rps"
                    stroke={colorFor(i)}
                    fill={colorFor(i)}
                    fillOpacity={0.5}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Heatmap. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Hour-of-Week Heatmap{' '}
            <span style={hint}>
              last 7 days · cell = invocations in that hour · peak {fmtInt(heatmapGrid.max)}
            </span>
          </h2>
        </div>
        {heatmapGrid.max === 0 ? (
          <EmptyState text="No traffic recorded over the last 7 days." />
        ) : (
          <div style={heatmapContainer}>
            <div style={heatmapHourHeader}>
              <div style={heatmapCornerCell}></div>
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} style={heatmapHourLabel}>
                  {h % 3 === 0 ? h : ''}
                </div>
              ))}
            </div>
            {heatmapGrid.grid.map((row, rIdx) => (
              <div key={rIdx} style={heatmapRow}>
                <div style={heatmapDowLabel}>{DOW_LABELS[rIdx]}</div>
                {row.map((count, h) => (
                  <div
                    key={h}
                    style={{
                      ...heatmapCell,
                      background: heatmapTone(count, heatmapGrid.max),
                    }}
                    title={`${DOW_LABELS[rIdx]} ${String(h).padStart(2, '0')}:00 — ${count} invocations`}
                    aria-label={`${DOW_LABELS[rIdx]} ${h}:00, ${count} invocations`}
                  />
                ))}
              </div>
            ))}
            <div style={heatmapLegendRow}>
              <span style={heatmapLegendLabel}>0</span>
              {[0.1, 0.3, 0.5, 0.75, 0.95].map((t) => (
                <div
                  key={t}
                  style={{
                    ...heatmapCell,
                    background: heatmapTone(Math.ceil(t * heatmapGrid.max), heatmapGrid.max),
                  }}
                />
              ))}
              <span style={heatmapLegendLabel}>{fmtInt(heatmapGrid.max)}</span>
            </div>
          </div>
        )}
      </Card>

      {/* Top users. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Top Users{' '}
            <span style={hint}>
              by invocation count · click to drill into per-user search
            </span>
          </h2>
        </div>
        {topUsers.length === 0 ? (
          <EmptyState text="No user_id stamped traffic in this window — backfill with infra/scripts/seed_user_ids_on_traces.py." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>User</TableTh>
                <TableTh>Invocations</TableTh>
                <TableTh>Unique agents</TableTh>
                <TableTh>Total cost</TableTh>
                <TableTh>Last seen</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {topUsers.map((u) => (
                <TableRow key={u.userId}>
                  <TableTd style={userCell}>{u.userId}</TableTd>
                  <TableTd style={numCell}>{fmtInt(u.invocations)}</TableTd>
                  <TableTd style={numCell}>{fmtInt(u.uniqueAgents)}</TableTd>
                  <TableTd style={numCell}>{fmtUsd(u.totalCostUsd, 4)}</TableTd>
                  <TableTd style={tsCell}>
                    {u.lastSeenAt
                      ? new Date(u.lastSeenAt.replace(' ', 'T')).toLocaleString()
                      : '—'}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link
                      to={`/observability/invocations/search?userId=${encodeURIComponent(u.userId)}`}
                      style={openLinkBtn}
                    >
                      →
                    </Link>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Per-agent operational summary. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Per-Agent Summary{' '}
            <span style={hint}>
              RPS / latency / error rate / cost · window {win.label}
            </span>
          </h2>
        </div>
        {perAgent.length === 0 ? (
          <EmptyState text="No agents observed in this window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Invocations</TableTh>
                <TableTh>RPS</TableTh>
                <TableTh>P50 latency</TableTh>
                <TableTh>P99 latency</TableTh>
                <TableTh>Error rate</TableTh>
                <TableTh>Cost</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {perAgent.map((a) => (
                <TableRow key={a.agentId}>
                  <TableTd style={userCell}>{a.agentId}</TableTd>
                  <TableTd style={numCell}>{fmtInt(a.invocations)}</TableTd>
                  <TableTd>
                    <Chip tone={rpsTone(a.rps)} size="xs">{fmtRps(a.rps)}</Chip>
                  </TableTd>
                  <TableTd style={numCell}>{fmtMs(a.p50DurationMs)}</TableTd>
                  <TableTd style={numCell}>{fmtMs(a.p99DurationMs)}</TableTd>
                  <TableTd>
                    <Chip tone={errorTone(a.errorRate)} size="xs">
                      {fmtPct(a.errorRate)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={costTone(a.totalCostUsd)} size="xs">
                      {fmtUsd(a.totalCostUsd, a.totalCostUsd >= 0.01 ? 2 : 4)}
                    </Chip>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function HeadlineCard({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: React.ReactNode;
}) {
  return (
    <div style={headlineCard}>
      <div style={headlineLabel}>{label.toUpperCase()}</div>
      <div style={headlinePrimary}>{primary}</div>
      <div style={headlineSecondary}>{secondary}</div>
    </div>
  );
}

function WindowPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (i: number) => void;
}) {
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
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--color-text-tertiary)',
      }}
    >
      {text}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap',
};

const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const subline: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  marginTop: 4,
};
const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};

const headlineRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};
const headlineCard: CSSProperties = {
  padding: '12px 16px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minHeight: 88,
};
const headlineLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
};
const headlinePrimary: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.1,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-primary)',
};
const headlineSecondary: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.4,
};

const userCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, monospace',
};
const numCell: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  fontVariantNumeric: 'tabular-nums',
};
const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};
const openLinkBtn: CSSProperties = {
  color: 'var(--color-primary, #6366f1)',
  fontSize: 14,
  textDecoration: 'none',
  padding: '2px 8px',
};

// Heatmap.
const heatmapContainer: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  overflowX: 'auto',
};
const heatmapHourHeader: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px repeat(24, minmax(20px, 1fr))',
  gap: 2,
  alignItems: 'center',
};
const heatmapCornerCell: CSSProperties = { width: 40 };
const heatmapHourLabel: CSSProperties = {
  textAlign: 'center',
  fontSize: 9,
  color: 'var(--color-text-tertiary)',
};
const heatmapRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px repeat(24, minmax(20px, 1fr))',
  gap: 2,
  alignItems: 'center',
};
const heatmapDowLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  width: 40,
};
const heatmapCell: CSSProperties = {
  height: 22,
  borderRadius: 2,
  border: '1px solid var(--color-border)',
  cursor: 'default',
};
const heatmapLegendRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  marginTop: 8,
  marginLeft: 42,
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
};
const heatmapLegendLabel: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

export default TrafficPage;
