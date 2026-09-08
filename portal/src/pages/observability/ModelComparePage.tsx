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
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Card,
  CardHeader,
  FormField,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  Inline,
  PageSection,
  Select,
  StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { readDegraded } from '../../lib/degraded';
import { T } from './Text';

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

  const { data: calData, refresh: refreshCal } = useFetch<CalibrationRunsResp>(
    '/api/observability/calibration/runs?limit=14',
    60_000,
  );
  // Only feeds the "did this judge calibrate?" chip — but a missing chip is
  // read as "this judge has never been calibrated", which is a stronger claim
  // than the failed query supports.
  const calDegraded = readDegraded(calData);
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

  const headlineItems = summary ? [
    {
      label: 'Pass rate',
      value: fmtPct(summary.passRateB),
      hint: (
        <Inline gap="xs" align="center" wrap>
          <Chip tone="neutral" size="xs">A {fmtPct(summary.passRateA)}</Chip>
          <T className="text-text-tertiary">→</T>
          <Chip tone="neutral" size="xs">B {fmtPct(summary.passRateB)}</Chip>
          <Chip tone={passRateDeltaTone(summary.passRateDelta)} size="xs">
            {summary.passRateDelta >= 0 ? '▲' : '▼'} {fmtSignedPct(summary.passRateDelta)}
          </Chip>
        </Inline>
      ),
    },
    {
      label: 'Total cost',
      value: fmtUsd(summary.costBUsd, 3),
      hint: (
        <Inline gap="xs" align="center" wrap>
          <Chip tone="neutral" size="xs">A {fmtUsd(summary.costAUsd, 3)}</Chip>
          <T className="text-text-tertiary">→</T>
          <Chip tone="neutral" size="xs">B {fmtUsd(summary.costBUsd, 3)}</Chip>
          <Chip tone={costDeltaTone(summary.costDeltaUsd)} size="xs">
            {fmtSignedCost(summary.costDeltaUsd)}
          </Chip>
        </Inline>
      ),
    },
    {
      label: 'Cost per good response',
      value: fmtUsd(costPerGoodB, 4),
      hint: (
        <Inline gap="xs" align="center" wrap>
          <Chip tone="neutral" size="xs">A {fmtUsd(costPerGoodA, 4)}</Chip>
          <T className="text-text-tertiary">→</T>
          <Chip tone="neutral" size="xs">B {fmtUsd(costPerGoodB, 4)}</Chip>
          <Chip tone={costDeltaTone(costPerGoodDelta)} size="xs">
            {fmtSignedCost(costPerGoodDelta)}
          </Chip>
        </Inline>
      ),
    },
    {
      label: 'Avg latency',
      value: fmtSignedDuration(Math.round(summary.avgDurationMsB)),
      hint: (
        <Inline gap="xs" align="center" wrap>
          <Chip tone="neutral" size="xs">A {fmtSignedDuration(Math.round(summary.avgDurationMsA))}</Chip>
          <T className="text-text-tertiary">→</T>
          <Chip tone="neutral" size="xs">B {fmtSignedDuration(Math.round(summary.avgDurationMsB))}</Chip>
          <Chip tone={durationDeltaTone(summary.durationDeltaMs)} size="xs">
            {fmtSignedDuration(summary.durationDeltaMs)}
          </Chip>
        </Inline>
      ),
    },
    {
      label: 'Judge MAE (calibration)',
      value: maeB ? fmt(maeB.mae) : '—',
      hint: (maeA && maeB ? (
        <Inline gap="xs" align="center" wrap>
          <Chip tone="neutral" size="xs">A {fmt(maeA.mae)}</Chip>
          <T className="text-text-tertiary">→</T>
          <Chip tone="neutral" size="xs">B {fmt(maeB.mae)}</Chip>
          {maeDelta != null && (
            <Chip tone={maeDelta > 0.01 ? 'danger' : maeDelta < -0.01 ? 'success' : 'neutral'} size="xs">
              {maeDelta >= 0 ? '+' : ''}{maeDelta.toFixed(3)}
            </Chip>
          )}
        </Inline>
      ) : (
        <T className="text-[11px] text-text-tertiary">
          Run a calibration to anchor this judge.{' '}
          <Link to="/admin/observability/calibration" className="text-primary no-underline hover:underline">open →</Link>
        </T>
      )) as ReactNode,
    },
  ] : [];

  return (
    <PageSection
      title="Model Compare"
      description="Compare two harness runs side-by-side. Re-run the harness with --model amazon.nova-lite-v1:0 (sim mode) and amazon.nova-pro-v1:0 to populate runs."
    >
      {calDegraded && (
        <UnavailableNotice
          error={calDegraded}
          what="the judge calibration history"
          source="Calibration runs live in the Aurora observability tables"
          onRetry={refreshCal}
          className="mb-4"
        />
      )}

      {/* Pickers */}
      <Card padding="md">
        <Inline gap="md" align="end" wrap>
          <RunPicker
            label="Run A (baseline)"
            runs={runs}
            value={runIdA}
            onChange={setRunIdA}
            otherValue={runIdB}
          />
          <T className="text-base text-text-tertiary pb-1.5">vs</T>
          <RunPicker
            label="Run B (candidate)"
            runs={runs}
            value={runIdB}
            onChange={setRunIdB}
            otherValue={runIdA}
          />
        </Inline>
        {runA && runB && (
          <Inline gap="sm" wrap align="center" className="text-[12px] text-text-secondary mt-2">
            <Inline as="span" gap="xs" align="center" wrap title={`run A: ${runA.runId}`}>
              <T>A: <strong>{runA.label}</strong></T>
              <T className="font-mono text-[11.5px]">· judge {runA.judgeModelId}</T>
              {agentModelA && (
                <>
                  <T className="text-text-tertiary">·</T>
                  <Chip tone="neutral" size="xs">
                    <T className="font-mono text-[11.5px]">agent {agentModelA}</T>
                  </Chip>
                </>
              )}
            </Inline>
            <T className="text-text-tertiary">→</T>
            <Inline as="span" gap="xs" align="center" wrap title={`run B: ${runB.runId}`}>
              <T>B: <strong>{runB.label}</strong></T>
              <T className="font-mono text-[11.5px]">· judge {runB.judgeModelId}</T>
              {agentModelB && (
                <>
                  <T className="text-text-tertiary">·</T>
                  <Chip tone="neutral" size="xs">
                    <T className="font-mono text-[11.5px]">agent {agentModelB}</T>
                  </Chip>
                </>
              )}
            </Inline>
          </Inline>
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
            <CardHeader
              title="Headline metrics"
              subtitle="green = B is better · red = B is worse · neutral = within band"
            />
            <StatStrip frameless items={headlineItems} />
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
            <Inline gap="xs" align="center" wrap className="text-[12px] text-text-secondary">
              <T className="text-[11px] text-text-tertiary">
                Want a deeper view? Open the full Sprint 3 compare page:
              </T>
              <Link
                to={`/admin/observability/harness/compare/${encodeURIComponent(runIdA)}/${encodeURIComponent(runIdB)}`}
                className="text-[12px] text-primary no-underline hover:underline"
              >
                detailed compare →
              </Link>
            </Inline>
          </Card>
        </>
      ) : null}
    </PageSection>
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
    <FormField label={label} className="flex-1 min-w-[280px]">
      {({ labelId: _labelId, ...field }) => (
        <Select
          {...field}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="— pick a run —"
          options={runs.map((r) => {
            const sha = r.gitSha ? ` · ${r.gitSha.slice(0, 7)}` : '';
            const mode = r.mode ? ` · ${r.mode}` : '';
            const judge = r.judgeModelId ? ` · judge ${r.judgeModelId.replace('amazon.', '')}` : '';
            const isOther = r.runId === otherValue;
            return { value: r.runId, label: `${r.label}${mode}${judge}${sha}${isOther ? ' (other side)' : ''}` };
          })}
        />
      )}
    </FormField>
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
  const toneClass = tone === 'danger'
    ? 'border-t-2 border-danger'
    : tone === 'success'
      ? 'border-t-2 border-success'
      : undefined;
  return (
    <Card padding="md" className={toneClass}>
      <CardHeader title={title} subtitle={hintText} />
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
                  <TableTd className="text-[11px] text-text-tertiary font-mono whitespace-nowrap">{r.testId}</TableTd>
                  <TableTd className="text-[12px] font-medium whitespace-nowrap">{r.agentId || '—'}</TableTd>
                  <TableTd className="whitespace-nowrap">
                    <Chip tone={judgeTone(r.scoreA)} size="xs">{fmt(r.scoreA)}</Chip>
                    <T className="text-text-tertiary mx-1">→</T>
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
                  <TableTd className="text-[12px] text-text-secondary whitespace-nowrap">
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
    <T as="div" className="p-6 text-center text-[12px] text-text-tertiary">
      {text}
    </T>
  );
}

// Reference shortRunId to keep the export happy; the diagnostic chip used to
// surface it but the secondary chip rows show full label now.
void shortRunId;

export default ModelComparePage;
