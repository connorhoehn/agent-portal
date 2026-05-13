// Sprint 4 (M10) — Model comparison page.
//
// A researcher picks two harness runs that used different models (today: judge
// models or, via harness.py --model, agent inference models in sim runs) and
// sees the side-by-side: pass-rate, cost-per-good, latency, MAE-against-
// calibration if both runs have a recent calibration.
//
// Layout:
//   1. Header — picker A + picker B (label, mode, judge_model_id chips)
//   2. Headline metrics — pass-rate Δ, cost Δ, latency Δ, MAE Δ (delta chips)
//   3. Regressions + fixes tables (re-using the existing compare endpoint)
//
// Endpoints reused:
//   GET /api/observability/harness/runs?limit=30          (pickers)
//   GET /api/observability/harness/runs/:a/compare/:b     (existing Sprint 3)
//   GET /api/observability/calibration/runs?limit=14      (recent MAE)

import { useEffect, useMemo, useState } from 'react';
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
import { useFetch } from '../../hooks/useFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

type Mode = 'live' | 'sim';

interface TestRunLite {
  runId: string;
  label: string;
  gitSha: string | null;
  judgeModelId: string;
  status: string;
  passRate: number | null;
  passed: number;
  failed: number;
  totalCases: number;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  mode?: Mode | string | null;
  agentVersions?: Record<string, string>;
}

interface RunsResp { runs: TestRunLite[]; }

interface ComparedResult {
  testId: string;
  agentId: string;
  scoreA: number | null;
  scoreB: number | null;
  scoreDelta: number | null;
  passedA: boolean | null;
  passedB: boolean | null;
  costDeltaUsd: number | null;
  durationDeltaMs: number | null;
}

interface CompareSummary {
  passRateA: number;
  passRateB: number;
  passRateDelta: number;
  costAUsd: number | null;
  costBUsd: number | null;
  costDeltaUsd: number | null;
  avgDurationMsA: number;
  avgDurationMsB: number;
  durationDeltaMs: number;
  modeA: Mode;
  modeB: Mode;
  judgeModelA: string;
  judgeModelB: string;
}

interface CompareResp {
  runA: TestRunLite;
  runB: TestRunLite;
  regressions: ComparedResult[];
  fixes: ComparedResult[];
  neutral: ComparedResult[];
  summary: CompareSummary;
}

interface CalibrationRun {
  calibrationRunId: string;
  label: string;
  judgeModelId: string;
  meanAbsError: number | null;
  startedAt: string;
}

interface CalibrationRunsResp { runs: CalibrationRun[]; }

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, digits = 2): string =>
  v != null && Number.isFinite(v) ? v.toFixed(digits) : '—';
const fmtPct = (v: number | null | undefined, digits = 1): string =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';
const fmtSignedCost = (v: number | null): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  const body = abs >= 0.01 ? abs.toFixed(2) : abs.toFixed(4);
  return `${sign}$${body}`;
};
const fmtSignedDuration = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  return `${sign}${(abs / 60_000).toFixed(1)}m`;
};
const fmtSignedPct = (v: number, digits = 1): string => {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(v) * 100).toFixed(digits)}%`;
};
const fmtUsd = (v: number | null | undefined, digits = 3): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${v.toFixed(digits)}`;
};
const passRateDeltaTone = (v: number): Tone =>
  v > 0.01 ? 'success' : v < -0.01 ? 'danger' : 'neutral';
const costDeltaTone = (v: number | null): Tone => {
  if (v == null) return 'neutral';
  if (v > 0.001) return 'danger';
  if (v < -0.001) return 'success';
  return 'neutral';
};
const durationDeltaTone = (v: number): Tone =>
  v > 100 ? 'danger' : v < -100 ? 'success' : 'neutral';
const judgeTone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

function shortRunId(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// Heuristic: extract agentModel=<id> from the run.notes field. The harness CLI
// writes that token when --model is passed, so we surface it as the "agent
// model" chip in addition to the judge model chip.
function extractAgentModel(run: TestRunLite | undefined | null): string | null {
  if (!run?.notes) return null;
  const m = /agentModel=([^\s]+)/.exec(run.notes);
  return m ? m[1]! : null;
}

// ─── Page ───────────────────────────────────────────────────────────────────

function ModelComparePage() {
  const { data: runsData } = useFetch<RunsResp>('/api/observability/harness/runs?limit=30', 30_000);
  const runs = useMemo(() => runsData?.runs ?? [], [runsData]);

  // Default to the two most-recent runs so the page is interesting on first load.
  const [runIdA, setRunIdA] = useState<string>('');
  const [runIdB, setRunIdB] = useState<string>('');

  // Auto-pick on first runs arrival. Later changes from the user stick.
  useEffect(() => {
    if (!runIdA && runs[1]) setRunIdA(runs[1].runId);
    if (!runIdB && runs[0]) setRunIdB(runs[0].runId);
  }, [runs, runIdA, runIdB]);

  const compareUrl = (runIdA && runIdB && runIdA !== runIdB)
    ? `/api/observability/harness/runs/${encodeURIComponent(runIdA)}/compare/${encodeURIComponent(runIdB)}`
    : '';
  const { data: compare, isLoading, error } = useFetch<CompareResp>(compareUrl);

  const { data: calData } = useFetch<CalibrationRunsResp>(
    '/api/observability/calibration/runs?limit=14',
    60_000,
  );
  const calibrationRuns = useMemo(() => calData?.runs ?? [], [calData]);

  // For each judge model present in calibration runs, take the most-recent MAE.
  // Then map the compare's judgeModelA / judgeModelB to that MAE for the
  // headline chip ("did this judge calibrate?").
  const maeByJudge = useMemo(() => {
    const m = new Map<string, { mae: number; label: string }>();
    // calibrationRuns is sorted desc by startedAt server-side.
    for (const r of calibrationRuns) {
      if (m.has(r.judgeModelId)) continue;
      if (r.meanAbsError != null && Number.isFinite(r.meanAbsError)) {
        m.set(r.judgeModelId, { mae: Number(r.meanAbsError), label: r.label });
      }
    }
    return m;
  }, [calibrationRuns]);

  const runA = compare?.runA;
  const runB = compare?.runB;
  const summary = compare?.summary;
  const regressions = compare?.regressions ?? [];
  const fixes = compare?.fixes ?? [];

  const agentModelA = extractAgentModel(runA) ?? null;
  const agentModelB = extractAgentModel(runB) ?? null;

  const maeA = summary ? maeByJudge.get(summary.judgeModelA) ?? null : null;
  const maeB = summary ? maeByJudge.get(summary.judgeModelB) ?? null : null;
  const maeDelta = (maeA && maeB) ? (maeB.mae - maeA.mae) : null;

  // Cost-per-good = sum(cost) / count(passed) on each side.
  const costPerGoodA = useMemo(() => {
    if (!summary || summary.costAUsd == null || !runA) return null;
    if (!runA.passed) return null;
    return summary.costAUsd / runA.passed;
  }, [summary, runA]);
  const costPerGoodB = useMemo(() => {
    if (!summary || summary.costBUsd == null || !runB) return null;
    if (!runB.passed) return null;
    return summary.costBUsd / runB.passed;
  }, [summary, runB]);
  const costPerGoodDelta = (costPerGoodA != null && costPerGoodB != null)
    ? (costPerGoodB - costPerGoodA)
    : null;

  return (
    <div style={pageStyle}>
      {/* Pickers */}
      <Card padding="md">
        <div style={headerRow}>
          <div>
            <h2 style={h2title}>Model Compare</h2>
            <div style={subline}>
              <span style={hint}>
                Compare two harness runs side-by-side. To compare two agent
                models, run the harness with{' '}
                <span style={monoInline}>--model amazon.nova-lite-v1:0</span> (sim
                mode) once, then with{' '}
                <span style={monoInline}>--model amazon.nova-pro-v1:0</span>, and
                pick both here.
              </span>
            </div>
          </div>
        </div>
        <div style={pickerRow}>
          <RunPicker
            label="Run A (baseline)"
            runs={runs}
            value={runIdA}
            onChange={setRunIdA}
            otherValue={runIdB}
          />
          <span style={arrowBetween}>vs</span>
          <RunPicker
            label="Run B (candidate)"
            runs={runs}
            value={runIdB}
            onChange={setRunIdB}
            otherValue={runIdA}
          />
        </div>
        {runA && runB && (
          <div style={{ ...subline, marginTop: 8 }}>
            <span style={runLabelChip} title={`run A: ${runA.runId}`}>
              A: <strong>{runA.label}</strong>{' '}
              <span style={monoInline}>· judge {runA.judgeModelId}</span>
              {agentModelA && (
                <>
                  <span style={dot}>·</span>
                  <Chip tone="neutral" size="xs">
                    <span style={monoInline}>agent {agentModelA}</span>
                  </Chip>
                </>
              )}
            </span>
            <span style={dot}>→</span>
            <span style={runLabelChip} title={`run B: ${runB.runId}`}>
              B: <strong>{runB.label}</strong>{' '}
              <span style={monoInline}>· judge {runB.judgeModelId}</span>
              {agentModelB && (
                <>
                  <span style={dot}>·</span>
                  <Chip tone="neutral" size="xs">
                    <span style={monoInline}>agent {agentModelB}</span>
                  </Chip>
                </>
              )}
            </span>
          </div>
        )}
      </Card>

      {/* Body */}
      {!runIdA || !runIdB ? (
        <Card padding="md">
          <EmptyState text="Pick two runs above to compare." />
        </Card>
      ) : runIdA === runIdB ? (
        <Card padding="md">
          <EmptyState text="Pick two different runs." />
        </Card>
      ) : error ? (
        <Card padding="md">
          <EmptyState text={`Could not load comparison: ${error}`} />
        </Card>
      ) : isLoading && !compare ? (
        <Card padding="md">
          <EmptyState text="Loading comparison…" />
        </Card>
      ) : compare && summary ? (
        <>
          {/* Headline metrics */}
          <Card padding="md">
            <div style={headerRow}>
              <h2 style={h2}>
                Headline metrics{' '}
                <span style={hint}>
                  green = B is better · red = B is worse · neutral = within band
                </span>
              </h2>
            </div>
            <div style={headlineRow}>
              <HeadlineCard
                label="Pass rate"
                primary={fmtPct(summary.passRateB)}
                secondary={
                  <span style={chipRow}>
                    <Chip tone="neutral" size="xs">A {fmtPct(summary.passRateA)}</Chip>
                    <span style={dot}>→</span>
                    <Chip tone="neutral" size="xs">B {fmtPct(summary.passRateB)}</Chip>
                    <Chip tone={passRateDeltaTone(summary.passRateDelta)} size="xs">
                      {summary.passRateDelta >= 0 ? '▲' : '▼'} {fmtSignedPct(summary.passRateDelta)}
                    </Chip>
                  </span>
                }
              />
              <HeadlineCard
                label="Total cost"
                primary={fmtUsd(summary.costBUsd, 3)}
                secondary={
                  <span style={chipRow}>
                    <Chip tone="neutral" size="xs">A {fmtUsd(summary.costAUsd, 3)}</Chip>
                    <span style={dot}>→</span>
                    <Chip tone="neutral" size="xs">B {fmtUsd(summary.costBUsd, 3)}</Chip>
                    <Chip tone={costDeltaTone(summary.costDeltaUsd)} size="xs">
                      {fmtSignedCost(summary.costDeltaUsd)}
                    </Chip>
                  </span>
                }
              />
              <HeadlineCard
                label="Cost per good response"
                primary={fmtUsd(costPerGoodB, 4)}
                secondary={
                  <span style={chipRow}>
                    <Chip tone="neutral" size="xs">A {fmtUsd(costPerGoodA, 4)}</Chip>
                    <span style={dot}>→</span>
                    <Chip tone="neutral" size="xs">B {fmtUsd(costPerGoodB, 4)}</Chip>
                    <Chip tone={costDeltaTone(costPerGoodDelta)} size="xs">
                      {fmtSignedCost(costPerGoodDelta)}
                    </Chip>
                  </span>
                }
              />
              <HeadlineCard
                label="Avg latency"
                primary={fmtSignedDuration(Math.round(summary.avgDurationMsB))}
                secondary={
                  <span style={chipRow}>
                    <Chip tone="neutral" size="xs">
                      A {fmtSignedDuration(Math.round(summary.avgDurationMsA))}
                    </Chip>
                    <span style={dot}>→</span>
                    <Chip tone="neutral" size="xs">
                      B {fmtSignedDuration(Math.round(summary.avgDurationMsB))}
                    </Chip>
                    <Chip tone={durationDeltaTone(summary.durationDeltaMs)} size="xs">
                      {fmtSignedDuration(summary.durationDeltaMs)}
                    </Chip>
                  </span>
                }
              />
              <HeadlineCard
                label="Judge MAE (calibration)"
                primary={maeB ? fmt(maeB.mae) : '—'}
                secondary={
                  maeA && maeB ? (
                    <span style={chipRow}>
                      <Chip tone="neutral" size="xs">A {fmt(maeA.mae)}</Chip>
                      <span style={dot}>→</span>
                      <Chip tone="neutral" size="xs">B {fmt(maeB.mae)}</Chip>
                      {maeDelta != null && (
                        <Chip
                          tone={maeDelta > 0.01 ? 'danger' : maeDelta < -0.01 ? 'success' : 'neutral'}
                          size="xs"
                        >
                          {maeDelta >= 0 ? '+' : ''}{maeDelta.toFixed(3)}
                        </Chip>
                      )}
                    </span>
                  ) : (
                    <span style={hint}>
                      Run a calibration to anchor this judge.{' '}
                      <Link to="/observability/calibration" style={inlineLink}>open →</Link>
                    </span>
                  )
                }
              />
            </div>
          </Card>

          {/* Regressions / Fixes */}
          <DeltaTable
            title="Regressions"
            tone="danger"
            hint={`${regressions.length} test${regressions.length === 1 ? '' : 's'} scored lower under B · sorted by |Δ| desc`}
            results={regressions}
            emptyText="No regressions — every common test held its score within ±0.05."
          />
          <DeltaTable
            title="Fixes"
            tone="success"
            hint={`${fixes.length} test${fixes.length === 1 ? '' : 's'} improved under B · sorted by |Δ| desc`}
            results={fixes}
            emptyText="No fixes — no common test improved by more than 0.05."
          />

          <Card padding="md">
            <div style={subline}>
              <span style={hint}>
                Want a deeper view? Open the full Sprint 3 compare page:{' '}
              </span>
              <Link
                to={`/observability/harness/compare/${encodeURIComponent(runIdA)}/${encodeURIComponent(runIdB)}`}
                style={inlineLink}
              >
                detailed compare →
              </Link>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function RunPicker({
  label,
  runs,
  value,
  onChange,
  otherValue,
}: {
  label: string;
  runs: TestRunLite[];
  value: string;
  onChange: (s: string) => void;
  otherValue: string;
}) {
  return (
    <label style={pickerLabel}>
      <span style={pickerLabelText}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={pickerSelect}
      >
        <option value="">— pick a run —</option>
        {runs.map((r) => {
          const sha = r.gitSha ? ` · ${r.gitSha.slice(0, 7)}` : '';
          const mode = r.mode ? ` · ${r.mode}` : '';
          const judge = r.judgeModelId ? ` · judge ${r.judgeModelId.replace('amazon.', '')}` : '';
          const isOther = r.runId === otherValue;
          return (
            <option key={r.runId} value={r.runId}>
              {r.label}{mode}{judge}{sha}{isOther ? ' (other side)' : ''}
            </option>
          );
        })}
      </select>
    </label>
  );
}

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

function DeltaTable({
  title,
  tone,
  hint: hintText,
  results,
  emptyText,
}: {
  title: string;
  tone: Tone;
  hint: string;
  results: ComparedResult[];
  emptyText: string;
}) {
  const cardTint: CSSProperties =
    tone === 'danger'
      ? { borderTop: '2px solid var(--color-danger, #ef4444)' }
      : tone === 'success'
        ? { borderTop: '2px solid var(--color-success, #22c55e)' }
        : {};
  return (
    <Card padding="md" style={cardTint}>
      <div style={headerRow}>
        <h2 style={h2}>
          {title} <span style={hint}>{hintText}</span>
        </h2>
      </div>
      {results.length === 0 ? (
        <EmptyState text={emptyText} />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Test</TableTh>
              <TableTh>Agent</TableTh>
              <TableTh>A → B</TableTh>
              <TableTh>Δ score</TableTh>
              <TableTh>Cost Δ</TableTh>
              <TableTh>Dur Δ</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {results.map((r) => {
              const arrow = r.scoreDelta == null
                ? '—'
                : (r.scoreDelta < 0 ? '↓' : r.scoreDelta > 0 ? '↑' : '·');
              const deltaTone: Tone = r.scoreDelta == null
                ? 'neutral'
                : tone;
              return (
                <TableRow key={r.testId}>
                  <TableTd style={monoCell}>{r.testId}</TableTd>
                  <TableTd style={agentCell}>{r.agentId || '—'}</TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap' }}>
                    <Chip tone={judgeTone(r.scoreA)} size="xs">{fmt(r.scoreA)}</Chip>
                    <span style={{ ...dot, margin: '0 4px' }}>→</span>
                    <Chip tone={judgeTone(r.scoreB)} size="xs">{fmt(r.scoreB)}</Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={deltaTone} size="xs">
                      {arrow} {r.scoreDelta == null ? '—' : fmt(Math.abs(r.scoreDelta))}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={costDeltaTone(r.costDeltaUsd)} size="xs">
                      {fmtSignedCost(r.costDeltaUsd)}
                    </Chip>
                  </TableTd>
                  <TableTd style={numCell}>
                    {fmtSignedDuration(r.durationDeltaMs)}
                  </TableTd>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
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

// Reference shortRunId to keep the export happy; the diagnostic chip used to
// surface it but the secondary chip rows show full label now.
void shortRunId;

// ─── Styles ─────────────────────────────────────────────────────────────────

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
const h2title: CSSProperties = { fontSize: 16, fontWeight: 600, margin: 0 };
const subline: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginTop: 4,
};
const dot: CSSProperties = { color: 'var(--color-text-tertiary)' };
const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};
const monoInline: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11.5,
};
const inlineLink: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
};
const pickerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 12,
  flexWrap: 'wrap',
};
const pickerLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: '1 1 320px',
  minWidth: 280,
};
const pickerLabelText: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
};
const pickerSelect: CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};
const arrowBetween: CSSProperties = {
  fontSize: 16,
  color: 'var(--color-text-tertiary)',
  paddingBottom: 6,
};
const runLabelChip: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flexWrap: 'wrap',
};
const headlineRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
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
  color: 'var(--color-text-primary)',
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
const monoCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
};
const agentCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};
const numCell: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  whiteSpace: 'nowrap',
};

export default ModelComparePage;
