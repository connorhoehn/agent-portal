// CostPage — executive surface for "what is eating my Bedrock bill?"
//
// Layout:
//   1. Cost-over-time stacked bar chart with deploy-marker overlays
//   2. Per-agent cost rollup table (with cost-per-good chip)
//   3. Headline cards row: total spend, A2A overhead, cost-per-good summary —
//      kept below the table it mostly restates (table-density audit); see the
//      comment at that card for which figure earns its keep
//   4. Top expensive invocations table (linkable to invocation detail)
//   5. By-model cost breakdown
//
// Data source: one envelope, polled every 30s —
//   GET /api/observability/cost/summary?windowHours=&bucketMin=&limit=
// carrying all eight sections that used to be eight independently-polled
// reads (total, a2aOverhead, valueRatio, perAgent, timeseries, top, byModel,
// deployMarkers — the last pinned server-side to its own 168h lookback,
// same as before). One section's query failing lands only that section's
// name in the envelope's `degraded` array, not the whole page.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Card, Chip, Inline, InlinePlaceholder, KPIGrid, PageSection, SectionLabel, Stack, StatCard, Table, TableHead, TableBody, TableRow, TableTh, TableTd,
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
import { firstDegraded } from '../../lib/degraded';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CostChip } from '../../components/observability/CostChip';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { T } from './Text';
import { normalizePgTimestamp, parsePgTimestamp, pgTimestampMs } from '../../lib/pgTimestamp';
import { WindowPicker, useWindowUrlState } from './WindowPicker';

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

interface CostSummaryResponse {
  windowHours: number;
  sections: {
    total: CostTotalResponse;
    perAgent: CostPerAgentResponse;
    timeseries: CostTimeseriesResponse;
    top: CostTopResponse;
    byModel: CostByModelResponse;
    a2aOverhead: CostA2AOverheadResponse;
    valueRatio: CostValueRatioResponse;
    deployMarkers: CostDeployMarkersResponse;
  };
  /** Names of sections whose query failed this poll — see routes/cost.ts. */
  degraded: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: Array<{ label: string; hours: number; bucket: number }> = [
  { label: '1h',  hours: 1,   bucket: 5  },
  { label: '24h', hours: 24,  bucket: 60 },
  { label: '7d',  hours: 168, bucket: 360 },
  { label: '30d', hours: 720, bucket: 1440 },
];

// Match drift palette so agent colors are stable across pages. Eight
// tokenized hues so up to 8 agents each keep a stable identity color; the
// tokenized palette only has 6 distinct hues (brand/success/warning/
// info/optimize/danger), so pink and lime are mixed from two tokens each
// with color-mix rather than reused verbatim from another slot.
const AGENT_COLORS = [
  'var(--color-brand)', // indigo
  'color-mix(in srgb, var(--color-danger) 55%, var(--color-brand) 45%)', // pink
  'var(--color-success)', // emerald
  'var(--color-warning)', // amber
  'color-mix(in srgb, var(--color-info) 60%, var(--color-success) 40%)', // cyan
  'var(--color-optimize)', // purple
  'var(--color-danger)', // red
  'color-mix(in srgb, var(--color-success) 65%, var(--color-warning) 35%)', // lime
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
  const norm = normalizePgTimestamp(iso);
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

// ─── Reusable cell classes (Tailwind, not inline style objects) ─────────────

const agentCellCls = 'whitespace-nowrap text-[12px] font-medium';
const numCellCls = 'text-[12px] text-[var(--color-text-secondary)] [font-variant-numeric:tabular-nums]';
const tsCellCls = 'whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]';
const monoCellCls = 'whitespace-nowrap font-mono text-[11px] text-[var(--color-text-tertiary)]';
const snippetCellCls = 'max-w-[360px] truncate text-[12px]';

// ─── Page ───────────────────────────────────────────────────────────────────

function CostPage() {
  const navigate = useNavigate();
  const [windowIdx, setWindowIdx] = useWindowUrlState(WINDOW_OPTIONS, 1); // 24h default, ?window=
  const win = WINDOW_OPTIONS[windowIdx];

  const {
    data: summary, error: summaryError, refresh: refreshSummary,
  } = useFetch<CostSummaryResponse>(
    `/api/observability/cost/summary?windowHours=${win.hours}&bucketMin=${win.bucket}&limit=20`,
    30_000,
  );

  // Deploy markers keep their own 168h server-side default independent of
  // the window picker — they're sparse and the chart filters them
  // client-side to the current view extent anyway. See routes/cost.ts.
  const total = summary?.sections.total;
  const a2a = summary?.sections.a2aOverhead;
  const valueRatio = summary?.sections.valueRatio;
  const perAgent = summary?.sections.perAgent;
  const timeseries = summary?.sections.timeseries;
  const top = summary?.sections.top;
  const byModel = summary?.sections.byModel;
  const deployMarkers = summary?.sections.deployMarkers;

  // All eight panels read the same cost tables, so when that read breaks they
  // break together — one sentence at the top, not eight stacked banners.
  const costDegraded = firstDegraded(
    total, a2a, valueRatio, perAgent, timeseries, top, byModel, deployMarkers,
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
        start: pgTimestampMs(String(r.bucketStart)),
        label: String(r.label),
      }))
      .filter((b) => Number.isFinite(b.start));
    if (buckets.length === 0) return [];
    const firstStart = buckets[0].start;
    const lastStart = buckets[buckets.length - 1].start;
    const out: Array<{ label: string; marker: CostDeployMarker; key: string }> = [];
    for (const m of markers) {
      const t = pgTimestampMs(m.registeredAt);
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
      actions={<WindowPicker options={WINDOW_OPTIONS} value={windowIdx} onChange={setWindowIdx} />}
    >
      {/* Every panel below reads from the same cost tables. Saying it once at
          the top beats seven cards each quietly showing $0.00. */}
      {/* All eight endpoints answer 200 with zeros when their query fails, so a
          transport error is not the only way to be blind here — `degraded`
          is the server saying it could not read the numbers, and it can come
          from any of the eight, not just /total. */}
      {(summaryError || costDegraded) && (
        <UnavailableNotice
          error={summaryError ?? costDegraded ?? 'the cost query failed'}
          what="cost data"
          source="Spend is aggregated from Aurora and CloudWatch"
          onRetry={refreshSummary}
          className="mb-4"
        />
      )}

      {/* Cost over time. */}
      <Card padding="md">
        <SectionLabel as="div" className="mb-3">
          Cost Over Time{' '}
          <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
            stacked $ per agent · bucket {win.bucket}m · window {win.label}
            {chartMarkers.length > 0 ? ` · ${chartMarkers.length} deploy marker${chartMarkers.length === 1 ? '' : 's'}` : ''}
          </T>
        </SectionLabel>
        {chartData.length === 0 ? (
          <SmartEmptyState
            title="No cost data"
            detail="Cost rows arrive on the trace bundle, alongside input/output token counts."
            degraded={costDegraded}
            degradedWhat="the cost chart"
            degradedSource="Spend is aggregated from Aurora and CloudWatch"
            onRetry={refreshSummary}
            actions={[
              {
                label: 'Run the test harness',
                detail: 'Generates ~10 sampled traces with token + cost data in ~30s.',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
            ]}
          />
        ) : (
          <Stack className="h-[300px] w-full">
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
                    stroke="var(--color-text-primary)"
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
          </Stack>
        )}
        {chartMarkers.length > 0 && (
          <Inline gap="xs" wrap align="center" className="mt-3 text-[11px] text-[var(--color-text-secondary)]">
            <T className="text-[10px] font-bold tracking-[0.5px] text-[var(--color-text-tertiary)]">
              deploys:
            </T>
            {chartMarkers.map(({ marker, key }) => (
              <Chip key={key} tone="neutral" size="xs">
                <T className="font-mono">
                  {marker.agentId}@{marker.promptVersion.slice(0, 6)}
                </T>
                <T className="text-[10px] text-[var(--color-text-tertiary)]">
                  {' '}· {shortTime(marker.registeredAt, win.hours)}
                </T>
              </Chip>
            ))}
          </Inline>
        )}
      </Card>

      {/* Per-agent breakdown table. */}
      <Card padding="md">
        <SectionLabel as="div" className="mb-3">
          Per-Agent Breakdown{' '}
          <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
            sorted by total cost · {perAgentRows.length} agent{perAgentRows.length === 1 ? '' : 's'}
          </T>
        </SectionLabel>
        {perAgentRows.length === 0 ? (
          <InlinePlaceholder align="center" size="sm">
            No invocations with cost data in this window.
          </InlinePlaceholder>
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
                    <TableTd className={agentCellCls}>{r.agentId}</TableTd>
                    <TableTd className={numCellCls}>{fmtInt(r.invocations)}</TableTd>
                    <TableTd className={numCellCls}>{fmtInt(r.inputTokens)}</TableTd>
                    <TableTd className={numCellCls}>{fmtInt(r.outputTokens)}</TableTd>
                    <TableTd className={numCellCls}>{fmtUsd(r.estCostUsd, 4)}</TableTd>
                    <TableTd className={numCellCls}>{fmtUsd(r.judgeCostUsd, 4)}</TableTd>
                    <TableTd className={`${numCellCls} font-semibold`}>
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

      {/* Headline cards row — kept below the table it summarizes (matches
          KnowledgeHomePage's "right now" strip): Total spend and Cost per
          good response are both derivable from the Per-Agent Breakdown table
          above, but A2A overhead is not shown anywhere else on this page, so
          it stays here rather than being dropped. */}
      <Card padding="md">
        <KPIGrid columns={3}>
          <StatCard
            label="Total spend"
            value={fmtUsd(totalCostUsd)}
            hint={`${fmtInt(invocations)} invocations · ${fmtInt(total?.inputTokens ?? 0)} in / ${fmtInt(total?.outputTokens ?? 0)} out tokens`}
          />
          <StatCard
            label="A2A overhead"
            value={fmtPct(a2a?.a2aFraction ?? 0)}
            danger={!!(a2a && a2a.a2aFraction > 0.4)}
            hint={
              a2a && a2a.totalCostUsd > 0
                ? `${fmtUsd(a2a.a2aCostUsd)} of ${fmtUsd(a2a.totalCostUsd)} on multi-agent routing · ${fmtInt(a2a.a2aInvocations)} sub-calls`
                : 'of total cost is multi-agent routing'
            }
          />
          <StatCard
            label="Cost per good response"
            value={
              valueRatioRanked.best?.costPerGood != null
                ? fmtUsd(valueRatioRanked.best.costPerGood, 4)
                : '—'
            }
            hint={
              valueRatioRanked.best && valueRatioRanked.worst &&
              valueRatioRanked.best.agentId !== valueRatioRanked.worst.agentId ? (
                <Inline as="span" gap="xs" wrap align="center">
                  <Chip tone="success" size="xs">
                    ✓ {valueRatioRanked.best.agentId} {fmtUsd(valueRatioRanked.best.costPerGood, 4)}
                  </Chip>
                  <Chip tone="danger" size="xs">
                    ⚠ {valueRatioRanked.worst.agentId} {fmtUsd(valueRatioRanked.worst.costPerGood, 4)}
                  </Chip>
                </Inline>
              ) : valueRatioRanked.best ? (
                <Chip tone="success" size="xs">
                  ✓ {valueRatioRanked.best.agentId}
                </Chip>
              ) : (
                'judge_score ≥ 0.7'
              )
            }
          />
        </KPIGrid>
      </Card>

      {/* Top expensive invocations. */}
      <Card padding="md">
        <SectionLabel as="div" className="mb-3">
          Top Expensive Invocations{' '}
          <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
            highest single-call cost first · click → open invocation detail
          </T>
        </SectionLabel>
        {topRows.length === 0 ? (
          <InlinePlaceholder align="center" size="sm">
            No expensive invocations recorded in this window.
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>When</TableTh>
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
                  clickable
                  onClick={() =>
                    navigate(`/admin/observability/invocations/${r.invocationId}`)
                  }
                >
                  <TableTd className={agentCellCls}>{r.agentId || '—'}</TableTd>
                  <TableTd className={tsCellCls}>
                    {r.ts ? (parsePgTimestamp(r.ts)?.toLocaleString() ?? r.ts) : '—'}
                  </TableTd>
                  <TableTd className={monoCellCls}>
                    {r.promptVersion ? `p:${r.promptVersion.slice(0, 8)}` : '—'}
                  </TableTd>
                  <TableTd
                    className={snippetCellCls}
                    title={r.promptSnippet}
                  >
                    {r.promptSnippet || '(empty)'}
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <CostChip cost={r.totalCostUsd} />
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-right">
                    <Inline as="span" gap="none" className="text-[12px] text-[var(--color-primary)]">
                      Open
                    </Inline>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* By-model breakdown. */}
      <Card padding="md">
        <SectionLabel as="div" className="mb-3">
          By Model{' '}
          <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
            spend per foundation model · {byModelRows.length} model{byModelRows.length === 1 ? '' : 's'}
          </T>
        </SectionLabel>
        {byModelRows.length === 0 ? (
          <InlinePlaceholder align="center" size="sm">
            No model attribution yet — older rows may pre-date model_id capture.
          </InlinePlaceholder>
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
                  <TableTd className={monoCellCls}>{r.modelId}</TableTd>
                  <TableTd className={numCellCls}>{fmtInt(r.invocations)}</TableTd>
                  <TableTd className={numCellCls}>{fmtInt(r.inputTokens)}</TableTd>
                  <TableTd className={numCellCls}>{fmtInt(r.outputTokens)}</TableTd>
                  <TableTd className={`${numCellCls} font-semibold`}>
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


export default CostPage;
