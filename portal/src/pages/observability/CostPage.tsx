// CostPage — executive surface for "what is eating my Bedrock bill?"
//
// Layout:
//   1. Headline cards row: total spend, A2A overhead, cost-per-good summary
//   2. Cost-over-time stacked bar chart with deploy-marker overlays
//   3. Per-agent cost rollup table (with cost-per-good chip)
//   4. Top expensive invocations table (linkable to invocation detail)
//   5. By-model cost breakdown
//
// Data sources (all under /api/observability/cost, polled every 30s):
//   GET /total?windowHours=
//   GET /a2a-overhead?windowHours=
//   GET /value-ratio?windowHours=
//   GET /per-agent?windowHours=
//   GET /timeseries?windowHours=&bucketMin=
//   GET /top?windowHours=&limit=
//   GET /by-model?windowHours=
//   GET /deploy-markers?windowHours=

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router';
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
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CostChip } from '../../components/observability/CostChip';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CostTotalResponse {
  /** Set by the server when its query failed — the zeros are unknown. */
  degraded?: boolean;
  error?: string;
  totalCostUsd: number;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  withCost: number;
  windowHours: number;
}

interface CostA2AOverheadResponse {
  totalCostUsd: number;
  a2aCostUsd: number;
  directCostUsd: number;
  a2aFraction: number;
  a2aInvocations: number;
  directInvocations: number;
  windowHours: number;
}

interface CostValueRatioRow {
  agentId: string;
  goodResponses: number;
  goodCostUsd: number;
  costPerGood: number | null;
  totalResponses: number;
  totalCostUsd: number;
  goodRate: number;
}

interface CostValueRatioResponse {
  byAgent: CostValueRatioRow[];
  windowHours: number;
}

interface CostPerAgentRow {
  agentId: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  judgeCostUsd: number;
  totalCostUsd: number;
}

interface CostPerAgentResponse {
  byAgent: CostPerAgentRow[];
  withCost: number;
  windowHours: number;
}

interface CostTimeseriesPoint {
  bucketStart: string;
  agentId: string;
  invocations: number;
  totalCostUsd: number;
}

interface CostTimeseriesResponse {
  points: CostTimeseriesPoint[];
  withCost: number;
  bucketMin: number;
  windowHours: number;
}

interface CostTopInvocation {
  invocationId: string;
  agentId: string;
  promptSnippet: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  ts: string;
  promptVersion: string | null;
}

interface CostTopResponse {
  invocations: CostTopInvocation[];
  withCost: number;
  windowHours: number;
}

interface CostByModelRow {
  modelId: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

interface CostByModelResponse {
  byModel: CostByModelRow[];
  withCost: number;
  windowHours: number;
}

interface CostDeployMarker {
  promptVersion: string;
  agentId: string;
  registeredAt: string;
  notes: string | null;
}

interface CostDeployMarkersResponse {
  markers: CostDeployMarker[];
  windowHours: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: Array<{ label: string; hours: number; bucket: number }> = [
  { label: '1h',  hours: 1,   bucket: 5  },
  { label: '24h', hours: 24,  bucket: 60 },
  { label: '7d',  hours: 168, bucket: 360 },
  { label: '30d', hours: 720, bucket: 1440 },
];

// Match drift palette so agent colors are stable across pages.
const AGENT_COLORS = [
  '#6366f1', // indigo
  '#ec4899', // pink
  '#10b981', // emerald
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ef4444', // red
  '#84cc16', // lime
];
const colorFor = (idx: number) => AGENT_COLORS[idx % AGENT_COLORS.length];

function fmtUsd(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const d = digits ?? (n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
  return `$${n.toFixed(d)}`;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

function shortTime(iso: string, hours: number): string {
  // Aurora returns 'YYYY-MM-DD HH:MM:SS+TZ' or ISO — normalise.
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T');
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return iso;
  if (hours <= 6)  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (hours <= 48) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit' })
  );
}

// Tone helpers for the per-agent cost-per-good chip. Lower is better.
function costPerGoodTone(cost: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (cost == null || !Number.isFinite(cost)) return 'neutral';
  if (cost < 0.005) return 'success';
  if (cost < 0.02)  return 'warning';
  return 'danger';
}

// ─── Page ───────────────────────────────────────────────────────────────────

function CostPage() {
  const navigate = useNavigate();
  const [windowIdx, setWindowIdx] = useState(1); // 24h default
  const win = WINDOW_OPTIONS[windowIdx];

  const { data: total, error: totalError, refresh: refreshTotal } = useFetch<CostTotalResponse>(
    `/api/observability/cost/total?windowHours=${win.hours}`,
    30_000,
  );
  const { data: a2a } = useFetch<CostA2AOverheadResponse>(
    `/api/observability/cost/a2a-overhead?windowHours=${win.hours}`,
    30_000,
  );
  const { data: valueRatio } = useFetch<CostValueRatioResponse>(
    `/api/observability/cost/value-ratio?windowHours=${win.hours}`,
    30_000,
  );
  const { data: perAgent } = useFetch<CostPerAgentResponse>(
    `/api/observability/cost/per-agent?windowHours=${win.hours}`,
    30_000,
  );
  const { data: timeseries } = useFetch<CostTimeseriesResponse>(
    `/api/observability/cost/timeseries?windowHours=${win.hours}&bucketMin=${win.bucket}`,
    30_000,
  );
  const { data: top } = useFetch<CostTopResponse>(
    `/api/observability/cost/top?windowHours=${win.hours}&limit=20`,
    30_000,
  );
  const { data: byModel } = useFetch<CostByModelResponse>(
    `/api/observability/cost/by-model?windowHours=${win.hours}`,
    30_000,
  );
  const { data: deployMarkers } = useFetch<CostDeployMarkersResponse>(
    // Always pull a generous 7-day window of markers — they're sparse and the
    // chart filters them client-side to the current view extent anyway.
    `/api/observability/cost/deploy-markers?windowHours=168`,
    60_000,
  );

  const totalCostUsd = total?.totalCostUsd ?? 0;
  const invocations = total?.invocations ?? 0;

  const valueRatioRows = useMemo(() => valueRatio?.byAgent ?? [], [valueRatio]);
  const perAgentRows = useMemo(() => perAgent?.byAgent ?? [], [perAgent]);
  const tsPoints = useMemo(() => timeseries?.points ?? [], [timeseries]);
  const topRows = useMemo(() => top?.invocations ?? [], [top]);
  const byModelRows = useMemo(() => byModel?.byModel ?? [], [byModel]);
  const markers = useMemo(() => deployMarkers?.markers ?? [], [deployMarkers]);

  // Best / worst by cost-per-good (filter agents that have at least one good).
  const valueRatioRanked = useMemo(() => {
    const eligible = valueRatioRows.filter(
      (r) => r.costPerGood != null && Number.isFinite(r.costPerGood),
    );
    const sorted = [...eligible].sort(
      (a, b) => (a.costPerGood ?? Infinity) - (b.costPerGood ?? Infinity),
    );
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }, [valueRatioRows]);

  // Cost-per-good lookup, keyed by agent_id — joins into the per-agent table.
  const costPerGoodByAgent = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const r of valueRatioRows) m.set(r.agentId, r.costPerGood);
    return m;
  }, [valueRatioRows]);

  // Reshape timeseries → one row per bucket with columns per agent for Recharts.
  const { chartData, agentList } = useMemo(() => {
    const byBucket = new Map<string, Record<string, number | string>>();
    const agentSet = new Set<string>();
    for (const p of tsPoints) {
      agentSet.add(p.agentId);
      let row = byBucket.get(p.bucketStart);
      if (!row) {
        row = {
          bucketStart: p.bucketStart,
          label: shortTime(p.bucketStart, win.hours),
        };
        byBucket.set(p.bucketStart, row);
      }
      row[p.agentId] = Number((p.totalCostUsd ?? 0).toFixed(6));
    }
    const ordered = Array.from(byBucket.values()).sort((a, b) =>
      String(a.bucketStart).localeCompare(String(b.bucketStart)),
    );
    return {
      chartData: ordered,
      agentList: Array.from(agentSet).sort(),
    };
  }, [tsPoints, win.hours]);

  // For each deploy marker, snap to the nearest bucket label (so the
  // ReferenceLine sits on the categorical X-axis). Skip markers outside the
  // current chart extent.
  const chartMarkers = useMemo(() => {
    if (chartData.length === 0 || markers.length === 0) return [];
    const buckets = chartData
      .map((r) => ({
        start: new Date(String(r.bucketStart).replace(' ', 'T')).getTime(),
        label: String(r.label),
      }))
      .filter((b) => Number.isFinite(b.start));
    if (buckets.length === 0) return [];
    const firstStart = buckets[0].start;
    const lastStart = buckets[buckets.length - 1].start;
    const out: Array<{ label: string; marker: CostDeployMarker; key: string }> = [];
    for (const m of markers) {
      const t = new Date(m.registeredAt.replace(' ', 'T')).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < firstStart || t > lastStart + 60 * 60 * 1000) continue;
      // Pick the bucket whose start is closest to (and not after) the marker.
      let chosen = buckets[0].label;
      for (const b of buckets) {
        if (b.start <= t) chosen = b.label;
        else break;
      }
      out.push({
        label: chosen,
        marker: m,
        key: `${m.promptVersion}::${m.agentId}::${m.registeredAt}`,
      });
    }
    return out;
  }, [chartData, markers]);

  const windowLabel = win.label;
  const headerSubline = `Bedrock + tool spend · ${windowLabel} · ${fmtUsd(totalCostUsd)} total across ${fmtInt(invocations)} invocation${invocations === 1 ? '' : 's'}`;

  return (
    <PageSection
      title="Cost"
      description={headerSubline}
      actions={<WindowPicker value={windowIdx} onChange={setWindowIdx} />}
    >
      {/* Every panel below reads from the same cost tables. Saying it once at
          the top beats seven cards each quietly showing $0.00. */}
      {/* These endpoints answer 200 with zeros when their query fails, so a
          transport error is not the only way to be blind here — `degraded`
          is the server saying it could not read the numbers. */}
      {(totalError || total?.degraded) && (
        <UnavailableNotice
          error={totalError ?? total?.error ?? 'the cost query failed'}
          what="cost data"
          source="Spend is aggregated from Aurora and CloudWatch"
          onRetry={refreshTotal}
          className="mb-4"
        />
      )}

      <Card padding="md">
        {/* Headline cards row. */}
        <div style={headlineRow}>
          <HeadlineCard
            label="Total spend"
            primary={fmtUsd(totalCostUsd)}
            secondary={`${fmtInt(invocations)} invocations · ${fmtInt(total?.inputTokens ?? 0)} in / ${fmtInt(total?.outputTokens ?? 0)} out tokens`}
          />
          <HeadlineCard
            label="A2A overhead"
            primary={fmtPct(a2a?.a2aFraction ?? 0)}
            secondary={
              a2a && a2a.totalCostUsd > 0
                ? `${fmtUsd(a2a.a2aCostUsd)} of ${fmtUsd(a2a.totalCostUsd)} on multi-agent routing · ${fmtInt(a2a.a2aInvocations)} sub-calls`
                : 'of total cost is multi-agent routing'
            }
            tone={a2a && a2a.a2aFraction > 0.4 ? 'warning' : undefined}
          />
          <HeadlineCard
            label="Cost per good response"
            primary={
              valueRatioRanked.best?.costPerGood != null
                ? fmtUsd(valueRatioRanked.best.costPerGood, 4)
                : '—'
            }
            secondary={
              valueRatioRanked.best && valueRatioRanked.worst &&
              valueRatioRanked.best.agentId !== valueRatioRanked.worst.agentId ? (
                <span style={chipRow}>
                  <Chip tone="success" size="xs">
                    ✓ {valueRatioRanked.best.agentId} {fmtUsd(valueRatioRanked.best.costPerGood, 4)}
                  </Chip>
                  <Chip tone="danger" size="xs">
                    ⚠ {valueRatioRanked.worst.agentId} {fmtUsd(valueRatioRanked.worst.costPerGood, 4)}
                  </Chip>
                </span>
              ) : valueRatioRanked.best ? (
                <Chip tone="success" size="xs">
                  ✓ {valueRatioRanked.best.agentId}
                </Chip>
              ) : (
                'judge_score ≥ 0.7'
              )
            }
          />
        </div>
      </Card>

      {/* Cost over time. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Cost Over Time{' '}
            <span style={hint}>
              stacked $ per agent · bucket {win.bucket}m · window {win.label}
              {chartMarkers.length > 0 ? ` · ${chartMarkers.length} deploy marker${chartMarkers.length === 1 ? '' : 's'}` : ''}
            </span>
          </h2>
        </div>
        {chartData.length === 0 ? (
          <SmartEmptyState
            title="No cost data"
            detail="Cost rows arrive on the trace bundle, alongside input/output token counts."
            actions={[
              {
                label: 'Run the test harness',
                detail: 'Generates ~10 sampled traces with token + cost data in ~30s.',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
            ]}
          />
        ) : (
          <div style={{ width: '100%', height: 300 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 20, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={56}
                  tickFormatter={(v: number) => fmtUsd(v)}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  formatter={(v: unknown) =>
                    fmtUsd(typeof v === 'number' ? v : Number(v), 4)
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="square" />
                {agentList.map((a, i) => (
                  <Bar
                    key={a}
                    dataKey={a}
                    stackId="cost"
                    fill={colorFor(i)}
                    isAnimationActive={false}
                  />
                ))}
                {chartMarkers.map(({ label, marker, key }) => (
                  <ReferenceLine
                    key={key}
                    x={label}
                    stroke="var(--color-text-primary, #0f172a)"
                    strokeDasharray="4 2"
                    strokeOpacity={0.55}
                    label={{
                      position: 'top',
                      value: `${marker.agentId}@${marker.promptVersion.slice(0, 6)}`,
                      fontSize: 9.5,
                      fill: 'var(--color-text-secondary)',
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {chartMarkers.length > 0 && (
          <div style={markerLegend}>
            <span style={markerLegendLabel}>deploys:</span>
            {chartMarkers.map(({ marker, key }) => (
              <Chip key={key} tone="neutral" size="xs">
                <span style={monoChip}>
                  {marker.agentId}@{marker.promptVersion.slice(0, 6)}
                </span>
                <span style={markerWhen}> · {shortTime(marker.registeredAt, win.hours)}</span>
              </Chip>
            ))}
          </div>
        )}
      </Card>

      {/* Per-agent breakdown table. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Per-Agent Breakdown{' '}
            <span style={hint}>
              sorted by total cost · {perAgentRows.length} agent{perAgentRows.length === 1 ? '' : 's'}
            </span>
          </h2>
        </div>
        {perAgentRows.length === 0 ? (
          <EmptyState text="No invocations with cost data in this window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Invocations</TableTh>
                <TableTh>Input tok</TableTh>
                <TableTh>Output tok</TableTh>
                <TableTh>Agent $</TableTh>
                <TableTh>Judge $</TableTh>
                <TableTh>Total $</TableTh>
                <TableTh>Cost / good</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {perAgentRows.map((r) => {
                const cpg = costPerGoodByAgent.get(r.agentId) ?? null;
                return (
                  <TableRow key={r.agentId}>
                    <TableTd style={agentCell}>{r.agentId}</TableTd>
                    <TableTd style={numCell}>{fmtInt(r.invocations)}</TableTd>
                    <TableTd style={numCell}>{fmtInt(r.inputTokens)}</TableTd>
                    <TableTd style={numCell}>{fmtInt(r.outputTokens)}</TableTd>
                    <TableTd style={numCell}>{fmtUsd(r.estCostUsd, 4)}</TableTd>
                    <TableTd style={numCell}>{fmtUsd(r.judgeCostUsd, 4)}</TableTd>
                    <TableTd style={{ ...numCell, fontWeight: 600 }}>
                      {fmtUsd(r.totalCostUsd)}
                    </TableTd>
                    <TableTd>
                      <Chip tone={costPerGoodTone(cpg)} size="xs">
                        {cpg == null ? '—' : fmtUsd(cpg, 4)}
                      </Chip>
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Top expensive invocations. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Top Expensive Invocations{' '}
            <span style={hint}>
              highest single-call cost first · click → open invocation detail
            </span>
          </h2>
        </div>
        {topRows.length === 0 ? (
          <EmptyState text="No expensive invocations recorded in this window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt ver</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Total $</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {topRows.map((r) => (
                <TableRow
                  key={r.invocationId}
                  onClick={() =>
                    navigate(`/admin/observability/invocations/${r.invocationId}`)
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <TableTd style={tsCell}>
                    {r.ts ? new Date(r.ts.replace(' ', 'T')).toLocaleString() : '—'}
                  </TableTd>
                  <TableTd style={agentCell}>{r.agentId || '—'}</TableTd>
                  <TableTd style={monoCell}>
                    {r.promptVersion ? `p:${r.promptVersion.slice(0, 8)}` : '—'}
                  </TableTd>
                  <TableTd
                    style={snippetCell}
                    title={r.promptSnippet}
                  >
                    {r.promptSnippet || '(empty)'}
                  </TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap' }}>
                    <CostChip cost={r.totalCostUsd} />
                  </TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <span style={openLinkBtn} aria-hidden="true">→</span>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* By-model breakdown. */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            By Model{' '}
            <span style={hint}>
              spend per foundation model · {byModelRows.length} model{byModelRows.length === 1 ? '' : 's'}
            </span>
          </h2>
        </div>
        {byModelRows.length === 0 ? (
          <EmptyState text="No model attribution yet — older rows may pre-date model_id capture." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Model</TableTh>
                <TableTh>Invocations</TableTh>
                <TableTh>Input tok</TableTh>
                <TableTh>Output tok</TableTh>
                <TableTh>Total $</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {byModelRows.map((r) => (
                <TableRow key={r.modelId}>
                  <TableTd style={monoCell}>{r.modelId}</TableTd>
                  <TableTd style={numCell}>{fmtInt(r.invocations)}</TableTd>
                  <TableTd style={numCell}>{fmtInt(r.inputTokens)}</TableTd>
                  <TableTd style={numCell}>{fmtInt(r.outputTokens)}</TableTd>
                  <TableTd style={{ ...numCell, fontWeight: 600 }}>
                    {fmtUsd(r.totalCostUsd)}
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

// ─── Sub-components ─────────────────────────────────────────────────────────

function HeadlineCard({
  label,
  primary,
  secondary,
  tone,
}: {
  label: string;
  primary: string;
  secondary: React.ReactNode;
  tone?: 'warning' | 'danger';
}) {
  const accent =
    tone === 'danger'
      ? 'var(--color-danger, #ef4444)'
      : tone === 'warning'
        ? 'var(--color-warning, #f59e0b)'
        : 'var(--color-text-primary)';
  return (
    <div style={headlineCard}>
      <div style={headlineLabel}>{label.toUpperCase()}</div>
      <div style={{ ...headlinePrimary, color: accent }}>{primary}</div>
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

// ─── Styles ─────────────────────────────────────────────────────────────────

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
  minHeight: 96,
};
const headlineLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
};
const headlinePrimary: CSSProperties = {
  fontSize: 24,
  fontWeight: 600,
  lineHeight: 1.1,
  fontVariantNumeric: 'tabular-nums',
};
const headlineSecondary: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.4,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};
const chipRow: CSSProperties = {
  display: 'inline-flex',
  gap: 6,
  flexWrap: 'wrap',
  alignItems: 'center',
};
const markerLegend: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginTop: 12,
  fontSize: 11,
  color: 'var(--color-text-secondary)',
};
const markerLegendLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
};
const monoChip: CSSProperties = { fontFamily: 'ui-monospace, monospace' };
const markerWhen: CSSProperties = {
  color: 'var(--color-text-tertiary)',
  fontSize: 10,
};
const agentCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
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
const monoCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
};
const snippetCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 360,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const openLinkBtn: CSSProperties = {
  color: 'var(--color-primary, #6366f1)',
  fontSize: 12,
};

export default CostPage;
