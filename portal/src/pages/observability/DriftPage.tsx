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

// Distinct, accessible colors per agent — researchers need to track lines visually.
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
                  <TableTd style={agentCell}>{r.agentId}</TableTd>
                  <TableTd style={numCell}>{r.count}</TableTd>
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
        <div style={headerRow}>
          <h2 style={h2}>
            Drift Over Time{' '}
            <span style={hint}>
              P95 cosine distance to centroid · bucket {win.bucket}m · window {win.label}
            </span>
          </h2>
        </div>
        {chartData.length === 0 ? (
          <EmptyState text="Not enough samples in this window to plot a series yet." />
        ) : (
          <div style={{ width: '100%', height: 260 }}>
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
          </div>
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            By Template{' '}
            <span style={hint}>
              which prompt is drifting · {templates.length} group{templates.length === 1 ? '' : 's'} · sorted by drift
            </span>
          </h2>
        </div>
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
                    onClick={() => {
                      setSelectedAgent(t.agentId);
                      setExpanded(null);
                    }}
                    style={focused ? { background: 'var(--color-surface-hover)', cursor: 'pointer' } : { cursor: 'pointer' }}
                  >
                    <TableTd style={agentCell}>{t.agentId}</TableTd>
                    <TableTd style={monoCell}>{t.templateId}</TableTd>
                    <TableTd style={numCell}>{t.count}</TableTd>
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
        <div style={headerRow}>
          <h2 style={h2}>
            Outliers{' '}
            <span style={hint}>
              highest drift first · click a row to inspect + see nearest known-good neighbor
            </span>
          </h2>
          <select
            value={selectedAgent}
            onChange={(e) => { setSelectedAgent(e.target.value); setExpanded(null); }}
            style={selectStyle}
            disabled={rows.length === 0}
          >
            {rows.length === 0 && <option value="">(no agents)</option>}
            {rows.map((r) => (
              <option key={r.agentId} value={r.agentId}>{r.agentId}</option>
            ))}
          </select>
        </div>

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
                      <TableTd style={tsCell}>{new Date(o.ts).toLocaleTimeString()}</TableTd>
                      <TableTd style={monoCell}>{o.templateId ?? '(none)'}</TableTd>
                      <TableTd
                        style={{ ...snippetCell, cursor: 'pointer' }}
                        title={o.promptSnippet}
                        onClick={() => setExpanded(isOpen ? null : o.invocationId)}
                      >
                        {o.promptSnippet}
                      </TableTd>
                      <TableTd
                        style={{ ...snippetCell, cursor: 'pointer' }}
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
                      <TableTd style={{ whiteSpace: 'nowrap' }}>
                        <CostChip cost={o.totalCostUsd} />
                      </TableTd>
                      <TableTd style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {o.invocationId ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/admin/observability/invocations/${o.invocationId}`);
                            }}
                            title="Open invocation detail"
                            style={openLinkBtn}
                          >
                            →
                          </button>
                        ) : null}
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${o.invocationId}-detail`}>
                        <TableTd colSpan={8} style={{ padding: 12, background: 'var(--color-bg)' }}>
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
      <div style={detailGrid}>
        <div>
          <div style={detailLabel}>OUTLIER</div>
          <div style={outlierMetaRow}>
            <span>distance {fmt(outlier.distance)}</span>
            <span style={dotSep}>·</span>
            <span>judge {fmt(outlier.judgeScore)}</span>
            <span style={dotSep}>·</span>
            <CostChip cost={outlier.totalCostUsd} />
            <PromptVersionChip promptVersion={outlier.promptVersion} />
          </div>
          <pre style={detailPre}>{outlier.responseSnippet}</pre>
          {outlier.judgeRationale && (
            <div style={detailHint}>judge: {outlier.judgeRationale}</div>
          )}
        </div>
        <div>
          <div style={detailLabel}>
            NEAREST KNOWN-GOOD{' '}
            {nearest && (
              <span style={detailHintInline}>
                · distance {fmt(nearest.distance)} · judge {fmt(nearest.judgeScore)}
              </span>
            )}
          </div>
          {neighbors == null ? (
            <pre style={detailPre}>loading…</pre>
          ) : nearest ? (
            <pre style={detailPre}>{nearest.responseSnippet}</pre>
          ) : (
            <pre style={{ ...detailPre, color: 'var(--color-text-tertiary)' }}>
              no trusted neighbor in last 7d
            </pre>
          )}
        </div>
      </div>
      <div style={outlierActionRow}>
        <button
          type="button"
          onClick={() => onSave(outlier)}
          style={saveBtn}
          title="Lock this outlier in as a regression test case"
        >
          + Save as test case
        </button>
      </div>
    </div>
  );
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
    <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
      {text}
    </div>
  );
}

const headerRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 12, gap: 12, flexWrap: 'wrap',
};
const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const hint: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 };
const selectStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)', color: 'var(--color-text-primary)',
};
const agentCell: CSSProperties = { fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };
const numCell: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)' };
const tsCell: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' };
const monoCell: CSSProperties = {
  fontSize: 11, color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap',
};
const snippetCell: CSSProperties = {
  fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const detailGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const detailLabel: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'var(--color-text-tertiary)',
  marginBottom: 4, letterSpacing: 0.5,
};
const detailHintInline: CSSProperties = { fontWeight: 400, color: 'var(--color-text-tertiary)' };
const outlierMetaRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
  fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 6,
};
const dotSep: CSSProperties = { color: 'var(--color-text-tertiary)' };
const detailHint: CSSProperties = {
  fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 6, fontStyle: 'italic',
};
const openLinkBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  color: 'var(--color-primary, #6366f1)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 8px',
  fontFamily: 'inherit',
};
const detailPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  margin: 0, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  maxHeight: 300, overflowY: 'auto',
};
const outlierActionRow: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', marginTop: 10,
};
const saveBtn: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default DriftPage;
