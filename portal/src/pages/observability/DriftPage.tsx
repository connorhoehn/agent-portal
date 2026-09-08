// Drift detection dashboard. Researcher-oriented surface:
//   - Per-agent rollup (current window snapshot)
//   - Time-series chart (when did drift start?)
//   - By-template breakdown (which prompt is drifting?)
//   - Outliers with closest known-good neighbor for diff (what changed?)
//
// Data sources (all under /api/observability/drift, polled every 30s):
//   GET /summary?windowHours=
//   GET /timeseries?windowHours=&bucketMin=
//   GET /templates?windowHours=
//   GET /outliers?agentId=&limit=
//   GET /neighbors/:invocationId?limit=

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  IconButton,
  Inline,
  PageSection,
  Select,
  Stack,
  useToast,
} from '@connorhoehnslalom/ui-components/shared';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';
import { SaveAsTestCaseModal } from '../../components/observability/SaveAsTestCaseModal';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { T } from './Text';

interface DriftSummary {
  agentId: string;
  count: number;
  schemaConformance: number;
  judgeP50: number;
  judgeP05: number;
  embeddingDriftP95: number;
}

interface DriftOutlier {
  invocationId: string;
  agentId: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  distance: number;
  ts: string;
  judgeRationale?: string | null;
  // Sprint 1 cost + provenance (nullable until Agent A's migration lands).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
  judgeCostUsd?: number | null;
  totalCostUsd?: number | null;
  promptVersion?: string | null;
  modelId?: string | null;
}

interface DriftTimePoint {
  bucketStart: string;
  agentId: string;
  count: number;
  driftP95: number;
  judgeP50: number | null;
}

interface DriftTemplate {
  agentId: string;
  templateId: string;
  count: number;
  judgeP50: number | null;
  judgeP05: number | null;
  schemaConformance: number;
  driftP95: number;
}

interface DriftNeighbor {
  invocationId: string;
  ts: string;
  responseSnippet: string;
  judgeScore: number | null;
  distance: number;
}

type Tone = 'success' | 'warning' | 'danger';

const schemaTone = (v: number): Tone => v >= 0.98 ? 'success' : v >= 0.9 ? 'warning' : 'danger';
const judgeP05Tone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.7 ? 'success' : v >= 0.5 ? 'warning' : 'danger';
const driftP95Tone = (v: number): Tone => v <= 0.3 ? 'success' : v <= 0.5 ? 'warning' : 'danger';
const judgeP50Tone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmt = (n: number | null, digits = 2): string =>
  n != null && Number.isFinite(n) ? n.toFixed(digits) : '—';

// Distinct, accessible colors per agent — researchers need to track lines
// visually. Same eight tokenized hues as CostPage.tsx's AGENT_COLORS (kept
// in sync so an agent's line color matches across pages); the tokenized
// palette only has 6 distinct hues, so pink and lime are mixed from two
// tokens each with color-mix rather than reused verbatim from another slot.
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

const WINDOW_OPTIONS: Array<{ label: string; hours: number; bucket: number }> = [
  { label: '1h',  hours: 1,   bucket: 5  },
  { label: '6h',  hours: 6,   bucket: 30 },
  { label: '24h', hours: 24,  bucket: 60 },
  { label: '7d',  hours: 168, bucket: 360 },
];

function DriftPage() {
  const navigate = useNavigate();
  const [windowIdx, setWindowIdx] = useState(2); // 24h default
  const win = WINDOW_OPTIONS[windowIdx];

  const { data: summary } = useFetch<DriftSummary[]>(
    `/api/observability/drift/summary?windowHours=${win.hours}`,
    30_000,
  );
  const rows = useMemo(() => (Array.isArray(summary) ? summary : []), [summary]);

  const { data: tsData } = useFetch<{ points?: DriftTimePoint[] }>(
    `/api/observability/drift/timeseries?windowHours=${win.hours}&bucketMin=${win.bucket}`,
    30_000,
  );
  const timeseries = useMemo(() => tsData?.points ?? [], [tsData]);

  const { data: tplData } = useFetch<{ templates?: DriftTemplate[] }>(
    `/api/observability/drift/templates?windowHours=${win.hours}`,
    30_000,
  );
  const templates = useMemo(() => tplData?.templates ?? [], [tplData]);

  const [selectedAgent, setSelectedAgent] = useState<string>('');
  useEffect(() => {
    if (!selectedAgent && rows.length > 0) setSelectedAgent(rows[0].agentId);
  }, [rows, selectedAgent]);

  const outlierUrl = selectedAgent
    ? `/api/observability/drift/outliers?agentId=${encodeURIComponent(selectedAgent)}&limit=20`
    : '';
  const { data: outliersData } = useFetch<{ outliers?: DriftOutlier[] } | DriftOutlier[]>(
    outlierUrl, 30_000,
  );
  const outlierRows = useMemo<DriftOutlier[]>(
    () => Array.isArray(outliersData) ? outliersData : (outliersData?.outliers ?? []),
    [outliersData],
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  // Modal state for "+ Save as test case" launched from the outlier panel.
  const [saveSource, setSaveSource] = useState<DriftOutlier | null>(null);
  const { toast } = useToast();

  // Reshape timeseries for Recharts: one row per bucket, columns per agent.
  const chartData = useMemo(() => {
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const p of timeseries) {
      let row = byBucket.get(p.bucketStart);
      if (!row) {
        row = { bucketStart: p.bucketStart, label: shortTime(p.bucketStart, win.hours) };
        byBucket.set(p.bucketStart, row);
      }
      row[p.agentId] = Number(p.driftP95.toFixed(3));
    }
    return Array.from(byBucket.values()).sort(
      (a, b) => String(a.bucketStart).localeCompare(String(b.bucketStart)),
    );
  }, [timeseries, win.hours]);

  const agentList = useMemo(() => rows.map((r) => r.agentId), [rows]);

  return (
    <PageSection
      title="Drift"
      description={`Per-agent · ${rows.length} agent${rows.length === 1 ? '' : 's'} · 30s refresh`}
      actions={<WindowPicker value={windowIdx} onChange={setWindowIdx} />}
    >
      <Card padding="md">
        {rows.length === 0 ? (
          <SmartEmptyState
            title="No invocations sampled yet"
            detail="Drift detection activates after the first sampled invocation. Live-mode harness produces ~10 sampled traces with embeddings."
            actions={[
              {
                label: 'Run the test harness',
                detail: 'Generates ~10 traces in ~30s.',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Count</TableTh>
                <TableTh>Schema OK %</TableTh>
                <TableTh>Judge P50</TableTh>
                <TableTh>Judge P05</TableTh>
                <TableTh>Drift P95</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.agentId}>
                  <TableTd className="text-[12px] font-medium whitespace-nowrap">{r.agentId}</TableTd>
                  <TableTd className="text-[12px] text-[var(--color-text-secondary)]">{r.count}</TableTd>
                  <TableTd>
                    <Chip tone={schemaTone(r.schemaConformance)} size="xs">
                      {(r.schemaConformance * 100).toFixed(1)}%
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={judgeP50Tone(r.judgeP50)} size="xs">{fmt(r.judgeP50)}</Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={judgeP05Tone(r.judgeP05)} size="xs">{fmt(r.judgeP05)}</Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={driftP95Tone(r.embeddingDriftP95)} size="xs">
                      {fmt(r.embeddingDriftP95)}
                    </Chip>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            Drift Over Time{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              P95 cosine distance to centroid · bucket {win.bucket}m · window {win.label}
            </T>
          </Inline>
        </Inline>
        {chartData.length === 0 ? (
          <EmptyState text="Not enough samples in this window to plot a series yet." />
        ) : (
          <Stack className="w-full h-[260px]">
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} />
                <YAxis
                  domain={[0, 'auto']}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={36}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  formatter={(v: any) => typeof v === 'number' ? v.toFixed(3) : `${v ?? ''}`}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" />
                {agentList.map((a, i) => (
                  <Line
                    key={a}
                    type="monotone"
                    dataKey={a}
                    stroke={colorFor(i)}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Stack>
        )}
      </Card>

      <Card padding="md">
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            By Template{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              which prompt is drifting · {templates.length} group{templates.length === 1 ? '' : 's'} · sorted by drift
            </T>
          </Inline>
        </Inline>
        {templates.length === 0 ? (
          <EmptyState text="No template groups have enough samples to compare yet." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Template</TableTh>
                <TableTh>Count</TableTh>
                <TableTh>Judge P50</TableTh>
                <TableTh>Judge P05</TableTh>
                <TableTh>Schema OK %</TableTh>
                <TableTh>Drift P95</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {templates.map((t) => {
                const focused = t.agentId === selectedAgent;
                return (
                  <TableRow
                    key={`${t.agentId}::${t.templateId}`}
                    clickable
                    onClick={() => {
                      setSelectedAgent(t.agentId);
                      setExpanded(null);
                    }}
                    className={focused ? 'bg-[var(--color-surface-hover)]' : ''}
                  >
                    <TableTd className="text-[12px] font-medium whitespace-nowrap">{t.agentId}</TableTd>
                    <TableTd className="text-[11px] text-[var(--color-text-tertiary)] font-[ui-monospace,monospace] whitespace-nowrap">
                      {t.templateId}
                    </TableTd>
                    <TableTd className="text-[12px] text-[var(--color-text-secondary)]">{t.count}</TableTd>
                    <TableTd>
                      <Chip tone={judgeP50Tone(t.judgeP50)} size="xs">{fmt(t.judgeP50)}</Chip>
                    </TableTd>
                    <TableTd>
                      <Chip tone={judgeP05Tone(t.judgeP05)} size="xs">{fmt(t.judgeP05)}</Chip>
                    </TableTd>
                    <TableTd>
                      <Chip tone={schemaTone(t.schemaConformance)} size="xs">
                        {(t.schemaConformance * 100).toFixed(1)}%
                      </Chip>
                    </TableTd>
                    <TableTd>
                      <Chip tone={driftP95Tone(t.driftP95)} size="xs">{fmt(t.driftP95)}</Chip>
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            Outliers{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              highest drift first · click a row to inspect + see nearest known-good neighbor
            </T>
          </Inline>
          <Select
            value={selectedAgent}
            onChange={(e) => { setSelectedAgent(e.target.value); setExpanded(null); }}
            disabled={rows.length === 0}
            options={
              rows.length === 0
                ? [{ value: '', label: '(no agents)' }]
                : rows.map((r) => ({ value: r.agentId, label: r.agentId }))
            }
          />
        </Inline>

        {!selectedAgent ? (
          <EmptyState text="Pick an agent above to see outliers." />
        ) : outlierRows.length === 0 ? (
          <EmptyState text="No outliers for this agent in the current window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Template</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Response</TableTh>
                <TableTh>Judge</TableTh>
                <TableTh>Distance</TableTh>
                <TableTh>Cost</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {outlierRows.map((o) => {
                const isOpen = expanded === o.invocationId;
                return (
                  <Fragment key={o.invocationId}>
                    <TableRow>
                      <TableTd className="text-[11px] text-[var(--color-text-tertiary)] whitespace-nowrap">
                        {new Date(o.ts).toLocaleTimeString()}
                      </TableTd>
                      <TableTd className="text-[11px] text-[var(--color-text-tertiary)] font-[ui-monospace,monospace] whitespace-nowrap">
                        {o.templateId ?? '(none)'}
                      </TableTd>
                      <TableTd
                        className="text-[12px] max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer"
                        title={o.promptSnippet}
                        onClick={() => setExpanded(isOpen ? null : o.invocationId)}
                      >
                        {o.promptSnippet}
                      </TableTd>
                      <TableTd
                        className="text-[12px] max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer"
                        title={o.responseSnippet}
                        onClick={() => setExpanded(isOpen ? null : o.invocationId)}
                      >
                        {o.responseSnippet}
                      </TableTd>
                      <TableTd>
                        <Chip tone={judgeP05Tone(o.judgeScore)} size="xs">{fmt(o.judgeScore)}</Chip>
                      </TableTd>
                      <TableTd>
                        <Chip tone={driftP95Tone(o.distance)} size="xs">{fmt(o.distance)}</Chip>
                      </TableTd>
                      <TableTd className="whitespace-nowrap">
                        <CostChip cost={o.totalCostUsd} />
                      </TableTd>
                      <TableTd className="whitespace-nowrap text-right">
                        {o.invocationId ? (
                          <IconButton
                            aria-label="Open invocation detail"
                            title="Open invocation detail"
                            icon="→"
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/admin/observability/invocations/${o.invocationId}`);
                            }}
                          />
                        ) : null}
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${o.invocationId}-detail`}>
                        <TableTd colSpan={8} className="p-3 bg-[var(--color-bg)]">
                          <OutlierDetail outlier={o} onSave={setSaveSource} />
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

      <SaveAsTestCaseModal
        invocation={{
          invocationId: saveSource?.invocationId ?? '',
          agentId: saveSource?.agentId ?? '',
          templateId: saveSource?.templateId ?? null,
          prompt: saveSource?.promptSnippet ?? '',
          response: saveSource?.responseSnippet ?? '',
        }}
        isOpen={!!saveSource}
        onClose={() => setSaveSource(null)}
        onSuccess={(testId) =>
          toast(`Test case ${testId} saved. View in harness: /admin/observability/harness`, { type: 'success' })
        }
      />
    </PageSection>
  );
}

// Fetched on demand when a row is expanded. Shows the drifted output side-by-side
// with the closest known-good neighbor — the researcher can diff them visually.
function OutlierDetail({
  outlier,
  onSave,
}: {
  outlier: DriftOutlier;
  onSave: (o: DriftOutlier) => void;
}) {
  const [neighbors, setNeighbors] = useState<DriftNeighbor[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNeighbors(null);
    fetch(`/api/observability/drift/neighbors/${outlier.invocationId}?limit=3`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : { neighbors: [] }))
      .then((j: { neighbors?: DriftNeighbor[] }) => {
        if (!cancelled) setNeighbors(j.neighbors ?? []);
      })
      .catch(() => { if (!cancelled) setNeighbors([]); });
    return () => { cancelled = true; };
  }, [outlier.invocationId]);

  const nearest = neighbors?.[0];
  return (
    <div>
      <Inline as="div" align="start" gap="md">
        <Stack gap="none" className="flex-1">
          <T as="div" className="text-[10px] font-bold text-[var(--color-text-tertiary)] mb-1 tracking-[0.5px]">
            OUTLIER
          </T>
          <Inline as="div" align="center" wrap gap="xs" className="text-[11px] text-[var(--color-text-secondary)] mb-1.5">
            <span>distance {fmt(outlier.distance)}</span>
            <T className="text-[var(--color-text-tertiary)]">·</T>
            <span>judge {fmt(outlier.judgeScore)}</span>
            <T className="text-[var(--color-text-tertiary)]">·</T>
            <CostChip cost={outlier.totalCostUsd} />
            <PromptVersionChip promptVersion={outlier.promptVersion} />
          </Inline>
          <Stack
            as="pre"
            gap="none"
            className="font-['Fira_Code','Cascadia_Code',monospace] text-[11.5px] leading-[1.55] whitespace-pre-wrap [word-break:break-word] m-0 py-2.5 px-3 rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] max-h-[300px] overflow-y-auto"
          >
            {outlier.responseSnippet}
          </Stack>
          {outlier.judgeRationale && (
            <T as="div" className="text-[10.5px] text-[var(--color-text-tertiary)] mt-1.5 italic">
              judge: {outlier.judgeRationale}
            </T>
          )}
        </Stack>
        <Stack gap="none" className="flex-1">
          <T as="div" className="text-[10px] font-bold text-[var(--color-text-tertiary)] mb-1 tracking-[0.5px]">
            NEAREST KNOWN-GOOD{' '}
            {nearest && (
              <T className="font-normal text-[var(--color-text-tertiary)]">
                · distance {fmt(nearest.distance)} · judge {fmt(nearest.judgeScore)}
              </T>
            )}
          </T>
          {neighbors == null ? (
            <Stack
              as="pre"
              gap="none"
              className="font-['Fira_Code','Cascadia_Code',monospace] text-[11.5px] leading-[1.55] whitespace-pre-wrap [word-break:break-word] m-0 py-2.5 px-3 rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] max-h-[300px] overflow-y-auto"
            >
              loading…
            </Stack>
          ) : nearest ? (
            <Stack
              as="pre"
              gap="none"
              className="font-['Fira_Code','Cascadia_Code',monospace] text-[11.5px] leading-[1.55] whitespace-pre-wrap [word-break:break-word] m-0 py-2.5 px-3 rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] max-h-[300px] overflow-y-auto"
            >
              {nearest.responseSnippet}
            </Stack>
          ) : (
            <Stack
              as="pre"
              gap="none"
              className="font-['Fira_Code','Cascadia_Code',monospace] text-[11.5px] leading-[1.55] whitespace-pre-wrap [word-break:break-word] m-0 py-2.5 px-3 rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] max-h-[300px] overflow-y-auto text-[var(--color-text-tertiary)]"
            >
              no trusted neighbor in last 7d
            </Stack>
          )}
        </Stack>
      </Inline>
      <Inline as="div" justify="end" className="mt-2.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onSave(outlier)}
          title="Lock this outlier in as a regression test case"
        >
          + Save as test case
        </Button>
      </Inline>
    </div>
  );
}

function WindowPicker({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <Inline as="div" gap="xs">
      {WINDOW_OPTIONS.map((w, i) => (
        <Button
          key={w.label}
          variant={i === value ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onChange(i)}
        >
          {w.label}
        </Button>
      ))}
    </Inline>
  );
}

function shortTime(iso: string, hours: number): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  if (hours <= 6) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (hours <= 48) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit' });
}

function EmptyState({ text }: { text: string }) {
  return (
    <Inline as="div" justify="center" className="p-6 text-[12px] text-[var(--color-text-tertiary)]">
      {text}
    </Inline>
  );
}

export default DriftPage;
