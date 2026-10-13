// TrafficPage — Sprint 4 (M13): production traffic shape.
//
// Four sections:
//   1. Header strip with totals + window picker.
//   2. RPS-over-time stacked AreaChart (Recharts).
//   3. 7×24 hour-of-week heatmap (composed frame — see TrafficHeatmapFrame.tsx).
//   4. Top users table (link to invocation search filtered by user).
//   5. Per-agent operational summary (RPS / P50 / P99 / err / cost chips).
//
// Data sources (all under /api/observability/traffic, polled every 30s):
//   GET /rps?windowHours=&bucketMin=
//   GET /heatmap?days=7
//   GET /top-users?windowHours=&limit=10
//   GET /per-agent-summary?windowHours=

import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  Card, CardHeader, Chip, PageSection, Stack, StatStrip, Table, TableBody, TableHead, TableRow, TableTh, TableTd, T,
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
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded, readDegraded } from '../../lib/degraded';
import { TrafficHeatmapFrame } from './TrafficHeatmapFrame';
import { RowEmpty } from './ReadState';
import { normalizePgTimestamp, parsePgTimestamp } from '../../lib/pgTimestamp';
import { WindowPicker, useWindowUrlState } from './WindowPicker';

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
  // Fraction of answers the judge scored below 0.3 — weak answers, NOT request
  // failures. Optional so older payloads (pre-field) render gracefully.
  lowQualityRate?: number;
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

// Match drift / cost palettes — stable per-agent colors across pages. Same
// eight tokenized hues as DriftPage.tsx / CostPage.tsx's AGENT_COLORS; pink
// and lime are mixed from two tokens each since the tokenized palette only
// has 6 distinct hues.
const AGENT_COLORS = [
  'var(--color-brand)',
  'color-mix(in srgb, var(--color-danger) 55%, var(--color-brand) 45%)',
  'var(--color-success)',
  'var(--color-warning)',
  'color-mix(in srgb, var(--color-info) 60%, var(--color-success) 40%)',
  'var(--color-optimize)',
  'var(--color-danger)',
  'color-mix(in srgb, var(--color-success) 65%, var(--color-warning) 35%)',
];
const colorFor = (idx: number) => AGENT_COLORS[idx % AGENT_COLORS.length];

// Mon-first day-of-week labels. Postgres' dow uses Sun=0..Sat=6 — we re-order
// rows to Mon..Sun because that's how everyone reads a workweek heatmap.
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
  const norm = normalizePgTimestamp(iso);
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
// Answer-quality signal, not a failure rate — weak answers are naturally more
// common than hard failures, so the thresholds sit higher than errorTone's.
const lowQualityTone = (r: number): 'success' | 'warning' | 'danger' => {
  if (r >= 0.2) return 'danger';
  if (r >= 0.05) return 'warning';
  return 'success';
};
const costTone = (c: number): 'success' | 'warning' | 'danger' => {
  if (c >= 1)   return 'danger';
  if (c >= 0.1) return 'warning';
  return 'success';
};

// ── Page ────────────────────────────────────────────────────────────────────

function TrafficPage() {
  const [windowIdx, setWindowIdx] = useWindowUrlState(WINDOW_OPTIONS, 1); // 24h default, ?window=
  const win = WINDOW_OPTIONS[windowIdx];

  const { data: rpsData, error: rpsError, refresh: refreshRps } = useFetch<RpsResponse>(
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

  // All four panels read the same trace tables. When that read fails these
  // endpoints still answer 200 with empty collections, which draws as a
  // perfectly quiet system — so say it once, at the top, with the reason.
  const trafficDegraded = firstDegraded(rpsData, heatmapData, topUsersData, perAgentData);

  // The totals strip and the description line are rolled up from the
  // per-agent summary and the top-user list, so they answer to THOSE two
  // reads, not to the page-wide marker. Summing an empty array yields 0, and
  // "0 invocations · 0 RPS avg" next to "Spend $0.0000" is a report that the
  // fleet was idle — a claim this page cannot make when its query failed.
  const totalsBlind = readDegraded(perAgentData);
  // `peak 0` is the heatmap's own claim, from its own read.
  const heatmapBlind = readDegraded(heatmapData);
  const usersBlind = readDegraded(topUsersData);

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

  const headerSubline = totalsBlind
    ? `Traffic in last ${win.label} could not be read`
    : `${fmtInt(totals.inv)} invocation${totals.inv === 1 ? '' : 's'} in last ${win.label} · ` +
      `${fmtRps(totals.avgRps)} RPS avg · ` +
      (usersBlind
        ? 'unique users unavailable'
        : `${fmtInt(totals.uniqueUsers)} unique user${totals.uniqueUsers === 1 ? '' : 's'}`);

  return (
    <PageSection
      title="Traffic"
      description={headerSubline}
      actions={<WindowPicker options={WINDOW_OPTIONS} value={windowIdx} onChange={setWindowIdx} />}
    >
      {(rpsError || trafficDegraded) && (
        <UnavailableNotice
          error={rpsError ?? trafficDegraded ?? 'the traffic query failed'}
          what="traffic data"
          source="Requests are counted from the invocation traces in Aurora"
          onRetry={refreshRps}
          className="mb-4"
        />
      )}

      <StatStrip
        variant="line"
        aria-label="Traffic totals"
        items={[
          {
            label: 'invocations',
            value: totalsBlind ? '—' : fmtInt(totals.inv),
            title: totalsBlind
              ? 'could not be read — not a count of zero'
              : `across ${perAgent.length} agent${perAgent.length === 1 ? '' : 's'} in ${win.label}`,
          },
          {
            label: 'RPS average',
            value: totalsBlind ? '—' : fmtRps(totals.avgRps),
            title: totalsBlind
              ? 'rate unknown for this window'
              : `smoothed over the full ${win.label} window`,
          },
          {
            label: 'spend',
            value: totalsBlind ? '—' : fmtUsd(totals.cost),
            title: totalsBlind
              ? 'spend could not be read — this is not $0'
              : 'Bedrock + judge for this window',
          },
        ]}
      />

      {/* RPS-over-time stacked-area chart. */}
      <Card padding="md">
        <CardHeader
          title="RPS Over Time"
          subtitle={`stacked invocations per agent · bucket ${win.bucket}m · window ${win.label}`}
        />
        {chartData.length === 0 ? (
          <SmartEmptyState
            title="No traffic"
            detail="RPS, heatmap, and top-user panels populate once traces land. Backfill user_id columns afterward so the top-user table is non-empty."
            degraded={trafficDegraded}
            degradedWhat="the traffic chart"
            degradedSource="Requests are counted from the invocation traces in Aurora"
            onRetry={refreshRps}
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
          <Stack className="w-full h-[280px]">
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
          </Stack>
        )}
      </Card>

      {/* Heatmap. */}
      <Card padding="md">
        <CardHeader
          title="Hour-of-Week Heatmap"
          subtitle={
            heatmapBlind
              ? 'last 7 days · cell = invocations in that hour · peak unavailable'
              : `last 7 days · cell = invocations in that hour · peak ${fmtInt(heatmapGrid.max)}`
          }
        />
        {heatmapGrid.max === 0 ? (
          <RowEmpty text="No traffic recorded over the last 7 days." degraded={trafficDegraded} />
        ) : (
          <TrafficHeatmapFrame grid={heatmapGrid.grid} max={heatmapGrid.max} />
        )}
      </Card>

      {/* Top users. */}
      <Card padding="md">
        <CardHeader
          title="Top Users"
          // The server call is hard-capped at limit=10 (line 211) — say so
          // rather than let "Top Users" read as "every user seen".
          subtitle="top 10 by invocation count · click to drill into per-user search for the rest"
        />
        {topUsers.length === 0 ? (
          <RowEmpty
            text="No user_id stamped traffic in this window — backfill with infra/scripts/seed_user_ids_on_traces.py."
            degraded={trafficDegraded}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>User</TableTh>
                <TableTh numeric>Invocations</TableTh>
                <TableTh numeric>Unique agents</TableTh>
                <TableTh numeric>Total cost</TableTh>
                <TableTh>Last seen</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {topUsers.map((u) => (
                <TableRow key={u.userId}>
                  <TableTd className="whitespace-nowrap"><T className="font-mono">{u.userId}</T></TableTd>
                  <TableTd numeric>{fmtInt(u.invocations)}</TableTd>
                  <TableTd numeric>{fmtInt(u.uniqueAgents)}</TableTd>
                  <TableTd numeric>{fmtUsd(u.totalCostUsd, 4)}</TableTd>
                  <TableTd className="whitespace-nowrap">
                    {u.lastSeenAt
                      ? (parsePgTimestamp(u.lastSeenAt)?.toLocaleString() ?? u.lastSeenAt)
                      : '—'}
                  </TableTd>
                  <TableTd className="text-right whitespace-nowrap">
                    <Link
                      to={`/admin/observability/invocations/search?userId=${encodeURIComponent(u.userId)}`}
                      className="text-primary no-underline px-2 py-0.5"
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
        <CardHeader
          title="Per-Agent Summary"
          // Why this says what counts. Overview's ERRORS tile reads 14 of 335
          // and this table's error rate sums to 34 of the same 335 — both
          // correct, over one corpus, using the two predicates the platform
          // actually defines: Overview counts runs that THREW ("system
          // failures, not answer quality"), this counts those plus guardrail
          // interventions. Verified against the rows: 14 threw, 20 were
          // blocked, zero overlap, 34 union. Nothing on either screen said so,
          // so a reader clicking from one to the other saw the same fleet and
          // window disagree 2.4x with no way to reconcile it.
          subtitle={`RPS / latency / error rate (threw or guardrail-blocked — wider than Overview's system-failure count) / low-quality rate / cost · window ${win.label}`}
        />
        {perAgent.length === 0 ? (
          <RowEmpty text="No agents observed in this window." degraded={trafficDegraded} />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh numeric>Invocations</TableTh>
                <TableTh numeric>RPS</TableTh>
                <TableTh numeric>P50 latency</TableTh>
                <TableTh numeric>P99 latency</TableTh>
                <TableTh>
                  <T title="Guardrail interventions or schema-invalid outputs — real request failures.">
                    Error rate
                  </T>
                </TableTh>
                <TableTh>
                  <T title="Share of answers the judge scored below 0.3 — weak answers, not request failures.">
                    Low-quality rate
                  </T>
                </TableTh>
                <TableTh numeric>Cost</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {perAgent.map((a) => (
                <TableRow key={a.agentId}>
                  <TableTd className="whitespace-nowrap"><T className="font-mono">{a.agentId}</T></TableTd>
                  <TableTd numeric>{fmtInt(a.invocations)}</TableTd>
                  <TableTd>
                    <Chip tone={rpsTone(a.rps)} size="xs">{fmtRps(a.rps)}</Chip>
                  </TableTd>
                  <TableTd numeric>{fmtMs(a.p50DurationMs)}</TableTd>
                  <TableTd numeric>{fmtMs(a.p99DurationMs)}</TableTd>
                  <TableTd>
                    <Chip tone={errorTone(a.errorRate)} size="xs">
                      {fmtPct(a.errorRate)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    {a.lowQualityRate == null || !Number.isFinite(a.lowQualityRate) ? (
                      <T tone="secondary" tabular>—</T>
                    ) : (
                      <Chip tone={lowQualityTone(a.lowQualityRate)} size="xs">
                        {fmtPct(a.lowQualityRate)}
                      </Chip>
                    )}
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
    </PageSection>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────


export default TrafficPage;
