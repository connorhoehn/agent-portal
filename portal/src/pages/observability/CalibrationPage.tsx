// Sprint 4 (M10) — Judge calibration page.
//
// A researcher curates a small (~20) set of (prompt, response, human_score)
// tuples. The Nova-Pro judge is periodically re-run over the active set; the
// gap between judge_score and human_score is "judge drift". When the MAE
// creeps past 0.15 the historical quality scores have lost their anchor.
//
// Layout:
//   1. Header — N active cases, judge modelId, last MAE
//   2. [Run calibration] CTA (opens a label modal, then POSTs /runs)
//   3. MAE trend (last 14 runs) — LineChart with a warning ref line at 0.15
//   4. Scatter — human_score vs judge_score for the most-recent run's results
//   5. Worst-disagreements table — top 10 by abs_error desc, expandable rows
//   6. Manage cases — list active, add/edit/archive
//
// Endpoints:
//   GET    /api/observability/calibration/cases
//   GET    /api/observability/calibration/runs?limit=14
//   GET    /api/observability/calibration/runs/:id
//   POST   /api/observability/calibration/runs
//   POST   /api/observability/calibration/cases
//   PATCH  /api/observability/calibration/cases/:id
//   DELETE /api/observability/calibration/cases/:id

import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  CardHeader,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  CodeBlock,
  Inline,
  InlineAlert,
  Modal as UIModal,
  CodeEditor,
  FormField,
  Input,
  NumberInput,
  Select,
  Textarea,
  Button,
  ConfirmDialog,
  PageSection,
  Stack,
  useToast,
} from '@connorhoehnslalom/ui-components/shared';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFetch } from '../../hooks/useFetch';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded } from '../../lib/degraded';
import { T } from './Text';
import { RowEmpty } from './ReadState';
import { parsePgTimestamp } from '../../lib/pgTimestamp';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CalibrationCase {
  calibrationId: string;
  agentId: string;
  prompt: string;
  response: string;
  humanScore: number;
  humanRationale: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

interface CalibrationRun {
  calibrationRunId: string;
  label: string;
  judgeModelId: string;
  totalCases: number;
  meanAbsError: number | null;
  maxAbsError: number | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
}

interface CalibrationResult {
  calibrationRunId: string;
  calibrationId: string;
  judgeScore: number | null;
  judgeRationale: string | null;
  absError: number | null;
  agentId?: string;
  prompt?: string;
  response?: string;
  humanScore?: number;
  humanRationale?: string | null;
}

interface CasesResp { cases: CalibrationCase[]; }
interface RunsResp { runs: CalibrationRun[]; }
interface RunDetailResp { run: CalibrationRun; results: CalibrationResult[]; }

// ─── Helpers ────────────────────────────────────────────────────────────────

const WARN_MAE = 0.15;
const DANGER_MAE = 0.20;

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}
function fmt2(n: number | null | undefined): string { return fmt(n, 2); }

function maeTone(n: number | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (n == null || !Number.isFinite(n)) return 'neutral';
  if (n >= DANGER_MAE) return 'danger';
  if (n >= WARN_MAE) return 'warning';
  return 'success';
}

function snip(s: string | null | undefined, max = 100): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function defaultLabel(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `manual@${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Page ───────────────────────────────────────────────────────────────────

function CalibrationPage() {
  const { toast } = useToast();
  const {
    data: casesData, error: casesError, refresh: refreshCases,
  } = useFetch<CasesResp>(
    '/api/observability/calibration/cases',
    30_000,
  );
  const { data: runsData, refresh: refreshRuns } = useFetch<RunsResp>(
    '/api/observability/calibration/runs?limit=14',
    30_000,
  );

  // "No calibration runs" is advice to go seed some. When the read failed, the
  // cases may well already be there — and "+ Run calibration" is disabled off
  // `cases.length`, so a broken read also silently removes the way out.
  const calibrationDegraded = firstDegraded(casesData, runsData);

  const cases = useMemo(() => casesData?.cases ?? [], [casesData]);
  const runs = useMemo(() => runsData?.runs ?? [], [runsData]);

  // The most recent run drives the scatter + worst-disagreement table.
  const latestRunId = runs[0]?.calibrationRunId ?? null;
  const latestRunUrl = latestRunId
    ? `/api/observability/calibration/runs/${encodeURIComponent(latestRunId)}`
    : '';
  const { data: latestRun } = useFetch<RunDetailResp>(latestRunUrl, 60_000);

  const [runDialog, setRunDialog] = useState<{ open: boolean; busy: boolean; err: string | null }>({
    open: false,
    busy: false,
    err: null,
  });
  const [runLabel, setRunLabel] = useState<string>(defaultLabel());

  const [caseDialog, setCaseDialog] = useState<{
    open: boolean;
    busy: boolean;
    err: string | null;
    editing: CalibrationCase | null;
  }>({ open: false, busy: false, err: null, editing: null });

  const [expandedResult, setExpandedResult] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<CalibrationCase | null>(null);
  const [archiving, setArchiving] = useState(false);

  const judgeModelId = runs[0]?.judgeModelId
    ?? latestRun?.run.judgeModelId
    ?? 'amazon.nova-pro-v1:0';
  const lastMae = runs[0]?.meanAbsError ?? null;

  // MAE trend — last 14 runs, oldest first.
  const maeTrend = useMemo(() => {
    return [...runs]
      .reverse()
      .map((r) => ({
        label: r.label.length > 18 ? `${r.label.slice(0, 18)}…` : r.label,
        mae: r.meanAbsError == null ? null : Number(r.meanAbsError),
        maxAbs: r.maxAbsError == null ? null : Number(r.maxAbsError),
      }));
  }, [runs]);
  const anyDangerRun = maeTrend.some((p) => p.mae != null && p.mae > DANGER_MAE);
  const lineColor = anyDangerRun ? 'var(--color-danger)' : 'var(--color-primary)';

  // Scatter data — human vs judge for the most recent run.
  const scatterPoints = useMemo(() => {
    const rows = latestRun?.results ?? [];
    return rows
      .filter((r) => r.judgeScore != null && r.humanScore != null)
      .map((r) => ({
        x: Number(r.humanScore),
        y: Number(r.judgeScore),
        agentId: r.agentId ?? '',
        absError: r.absError ?? 0,
        calibrationId: r.calibrationId,
      }));
  }, [latestRun]);

  // Worst disagreements — top 10 by abs_error desc.
  const worstResults = useMemo(() => {
    const rows = latestRun?.results ?? [];
    return [...rows]
      .filter((r) => r.absError != null)
      .sort((a, b) => (b.absError ?? 0) - (a.absError ?? 0))
      .slice(0, 10);
  }, [latestRun]);

  async function handleRunCalibration() {
    setRunDialog({ open: true, busy: true, err: null });
    try {
      const resp = await fetch('/api/observability/calibration/runs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: runLabel || defaultLabel() }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(String(j.error ?? `${resp.status} ${resp.statusText}`));
      }
      setRunDialog({ open: false, busy: false, err: null });
      setRunLabel(defaultLabel());
      refreshRuns();
    } catch (e) {
      setRunDialog({ open: true, busy: false, err: e instanceof Error ? e.message : 'Run failed' });
    }
  }

  async function archiveCase(c: CalibrationCase) {
    setArchiving(true);
    try {
      const resp = await fetch(`/api/observability/calibration/cases/${encodeURIComponent(c.calibrationId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(String(j.error ?? `${resp.status} ${resp.statusText}`));
      }
      refreshCases();
    } catch (e) {
      toast(`Archive failed: ${e instanceof Error ? e.message : 'unknown error'}`, { type: 'error' });
    } finally {
      setArchiving(false);
      setArchiveTarget(null);
    }
  }

  return (
    <PageSection
      title="Judge Calibration"
      description={`Judge drift means our historical quality scores have lost their anchor. Target MAE < ${WARN_MAE.toFixed(2)}; investigate above ${DANGER_MAE.toFixed(2)}.`}
      actions={
        <Button
          variant="primary"
          onClick={() => { setRunLabel(defaultLabel()); setRunDialog({ open: true, busy: false, err: null }); }}
          disabled={cases.length === 0}
          title={cases.length === 0 ? 'Add calibration cases first' : 'Run the judge over all active cases'}
        >
          + Run calibration
        </Button>
      }
    >
      {(casesError || calibrationDegraded) && (
        <UnavailableNotice
          error={casesError ?? calibrationDegraded ?? 'the calibration query failed'}
          what="calibration cases and runs"
          source="Cases and runs live in the Aurora observability tables"
          onRetry={() => { refreshCases(); refreshRuns(); }}
          className="mb-4"
        />
      )}

      {/* Header */}
      <Card padding="md">
        <Inline gap="sm" align="center" className="text-[12px] text-text-secondary">
          <T><strong>{cases.length}</strong>&nbsp;active case{cases.length === 1 ? '' : 's'}</T>
          <T className="text-text-tertiary">·</T>
          <T>judge <T className="font-mono text-[11.5px]">{judgeModelId}</T></T>
          <T className="text-text-tertiary">·</T>
          <T>last MAE</T>
          <Chip tone={maeTone(lastMae)} size="xs">{fmt(lastMae)}</Chip>
          {runs[0]?.startedAt ? (
            <>
              <T className="text-text-tertiary">·</T>
              <T className="text-[11px] text-text-tertiary">
                {parsePgTimestamp(runs[0].startedAt)?.toLocaleString() ?? runs[0].startedAt}
              </T>
            </>
          ) : null}
        </Inline>
      </Card>

      {/* MAE trend */}
      <Card padding="md">
        <CardHeader
          title="MAE Trend"
          subtitle={`mean absolute error vs human score · last ${maeTrend.length} run${maeTrend.length === 1 ? '' : 's'} · oldest left`}
        />
        {maeTrend.length === 0 ? (
          <SmartEmptyState
            title="No calibration runs"
            detail="A calibration run scores the active test cases with the LLM-as-judge and compares them against human-labelled ground truth."
            degraded={calibrationDegraded}
            degradedWhat="the calibration run history"
            degradedSource="Cases and runs live in the Aurora observability tables"
            onRetry={() => { refreshCases(); refreshRuns(); }}
            actions={[
              {
                label: 'Seed cases + kick off a calibration run',
                detail: 'Loads ~10 ground-truth cases and triggers a first run end-to-end.',
                code: 'python3 infra/scripts/seed_calibration_cases.py && curl -X POST localhost:3001/api/observability/calibration/runs -d \'{"label":"first"}\'',
              },
            ]}
          />
        ) : (
          <Stack className="w-full h-[220px]">
            <ResponsiveContainer>
              <LineChart data={maeTrend} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} />
                <YAxis
                  domain={[0, 'auto']}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={42}
                  tickFormatter={(v: number) => v.toFixed(2)}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  formatter={(v: unknown) =>
                    v == null ? '—' : (typeof v === 'number' ? v.toFixed(3) : String(v))
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" />
                <ReferenceLine
                  y={WARN_MAE}
                  stroke="var(--color-warning)"
                  strokeDasharray="4 2"
                  label={{
                    value: `warn ${WARN_MAE.toFixed(2)}`,
                    fontSize: 10,
                    fill: 'var(--color-warning)',
                    position: 'right',
                  }}
                />
                <ReferenceLine
                  y={DANGER_MAE}
                  stroke="var(--color-danger)"
                  strokeDasharray="4 2"
                  label={{
                    value: `danger ${DANGER_MAE.toFixed(2)}`,
                    fontSize: 10,
                    fill: 'var(--color-danger)',
                    position: 'right',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="mae"
                  name="MAE"
                  stroke={lineColor}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="maxAbs"
                  name="max |Δ|"
                  stroke="var(--color-text-tertiary)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </Stack>
        )}
      </Card>

      {/* Scatter */}
      <Card padding="md">
        <CardHeader
          title="Judge vs Human Score"
          subtitle={`latest run · diagonal = perfect agreement · above = judge over-rates · below = judge under-rates${latestRun?.run.label ? ` · ${latestRun.run.label}` : ''}`}
        />
        {scatterPoints.length === 0 ? (
          <RowEmpty text="No paired scores in the latest run." degraded={calibrationDegraded} />
        ) : (
          <Stack className="w-full h-[320px]">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 8 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="human"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  label={{ value: 'human_score', position: 'insideBottom', offset: -8, fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="judge"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  width={42}
                  label={{ value: 'judge_score', angle: -90, position: 'insideLeft', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(v: unknown, name: unknown): [string, string] => [
                    typeof v === 'number' ? v.toFixed(3) : String(v ?? ''),
                    String(name ?? ''),
                  ]}
                />
                {/* Perfect-agreement diagonal */}
                <ReferenceLine
                  segment={[
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ]}
                  stroke="var(--color-text-tertiary)"
                  strokeDasharray="4 2"
                />
                <Scatter
                  data={scatterPoints}
                  fill="var(--color-primary)"
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </Stack>
        )}
      </Card>

      {/* Worst disagreements */}
      <Card padding="md">
        <CardHeader
          title="Worst Disagreements"
          subtitle={`top ${worstResults.length} cases by |judge − human| · click to expand response`}
        />
        {worstResults.length === 0 ? (
          <RowEmpty text="No disagreements yet — run a calibration first." degraded={calibrationDegraded} />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Human</TableTh>
                <TableTh>Judge</TableTh>
                <TableTh>|Δ|</TableTh>
                <TableTh>Rationale</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {worstResults.map((r) => {
                const isOpen = expandedResult === r.calibrationId;
                return (
                  <>
                    <TableRow
                      key={r.calibrationId}
                      onClick={() =>
                        setExpandedResult((cur) => (cur === r.calibrationId ? null : r.calibrationId))
                      }
                      className="cursor-pointer"
                    >
                      <TableTd className="text-[12px] font-medium whitespace-nowrap">{r.agentId ?? '—'}</TableTd>
                      <TableTd className="text-[12px] max-w-[320px] truncate" title={r.prompt}>
                        {snip(r.prompt, 80) || '(empty)'}
                      </TableTd>
                      <TableTd className="text-[12px] text-text-secondary tabular-nums">{fmt2(r.humanScore)}</TableTd>
                      <TableTd className="text-[12px] text-text-secondary tabular-nums">{fmt2(r.judgeScore)}</TableTd>
                      <TableTd>
                        <Chip tone={maeTone(r.absError)} size="xs">{fmt(r.absError)}</Chip>
                      </TableTd>
                      <TableTd className="text-[12px] max-w-[320px] truncate" title={r.judgeRationale ?? ''}>
                        {snip(r.judgeRationale, 60) || '—'}
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${r.calibrationId}-detail`}>
                        <TableTd colSpan={6} className="p-3 bg-bg">
                          <Inline gap="md" align="start">
                            <Stack gap="xs" className="flex-1 min-w-0">
                              <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">
                                PROMPT · agent={r.agentId ?? '—'}
                              </T>
                              <CodeBlock code={r.prompt ?? '(no prompt)'} language="text" />
                              <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide mt-3">RESPONSE</T>
                              <CodeBlock code={r.response ?? '(no response)'} language="text" />
                            </Stack>
                            <Stack gap="xs" className="flex-1 min-w-0">
                              <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">
                                HUMAN <T className="font-mono text-[11.5px]">{fmt2(r.humanScore)}</T>
                              </T>
                              <CodeBlock code={r.humanRationale ?? '(no rationale recorded)'} language="text" />
                              <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide mt-3">
                                JUDGE <T className="font-mono text-[11.5px]">{fmt2(r.judgeScore)}</T>
                              </T>
                              <CodeBlock code={r.judgeRationale ?? '(no rationale returned)'} language="text" />
                            </Stack>
                          </Inline>
                        </TableTd>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Manage cases */}
      <Card padding="md">
        <CardHeader
          title="Manage Cases"
          subtitle={`${cases.length} active · curate the corpus the judge gets tested against`}
          action={
            <Button
              variant="secondary"
              onClick={() => setCaseDialog({ open: true, busy: false, err: null, editing: null })}
            >
              + Add case
            </Button>
          }
        />
        {cases.length === 0 ? (
          <RowEmpty
            text="No active calibration cases. Add one above or run infra/scripts/seed_calibration_cases.py."
            degraded={calibrationDegraded}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Human</TableTh>
                <TableTh>Updated</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.calibrationId}>
                  <TableTd className="text-[12px] font-medium whitespace-nowrap">{c.agentId}</TableTd>
                  <TableTd className="text-[12px] max-w-[320px] truncate" title={c.prompt}>{snip(c.prompt, 100)}</TableTd>
                  <TableTd className="text-[12px] text-text-secondary tabular-nums">{fmt2(c.humanScore)}</TableTd>
                  <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                    {c.updatedAt
                      ? (parsePgTimestamp(c.updatedAt)?.toLocaleDateString() ?? c.updatedAt)
                      : '—'}
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setCaseDialog({ open: true, busy: false, err: null, editing: c })
                      }
                    >
                      Edit
                    </Button>
                    <T className="text-text-tertiary mx-1.5">·</T>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setArchiveTarget(c)}
                    >
                      Archive
                    </Button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Run calibration dialog */}
      <UIModal
        open={runDialog.open}
        onClose={() => { if (!runDialog.busy) setRunDialog({ open: false, busy: false, err: null }); }}
        title="Run calibration"
      >
        <Stack gap="md">
          <FormField label="Label">
            {({ labelId: _labelId, ...field }) => (
              <Input
                {...field}
                type="text"
                value={runLabel}
                onChange={(e) => setRunLabel(e.target.value)}
                disabled={runDialog.busy}
              />
            )}
          </FormField>
          <T as="div" className="text-[11px] text-text-tertiary">
            The judge will be re-run over all {cases.length} active case
            {cases.length === 1 ? '' : 's'}. ~1 second per case. Cost is one
            Nova-Pro call per case (≈ $0.001 / 20 cases).
          </T>
          {runDialog.err && (
            <InlineAlert tone="error">Error: {runDialog.err}</InlineAlert>
          )}
          <Inline justify="end" gap="sm">
            <Button
              variant="secondary"
              onClick={() => setRunDialog({ open: false, busy: false, err: null })}
              disabled={runDialog.busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleRunCalibration}
              disabled={runDialog.busy}
            >
              {runDialog.busy ? 'Running…' : 'Run'}
            </Button>
          </Inline>
        </Stack>
      </UIModal>

      {/* Add / edit case dialog */}
      {caseDialog.open && (
        <CaseEditor
          editing={caseDialog.editing}
          busy={caseDialog.busy}
          err={caseDialog.err}
          onClose={() =>
            !caseDialog.busy && setCaseDialog({ open: false, busy: false, err: null, editing: null })
          }
          onSubmit={async (form) => {
            setCaseDialog((cur) => ({ ...cur, busy: true, err: null }));
            try {
              const url = caseDialog.editing
                ? `/api/observability/calibration/cases/${encodeURIComponent(caseDialog.editing.calibrationId)}`
                : '/api/observability/calibration/cases';
              const method = caseDialog.editing ? 'PATCH' : 'POST';
              const resp = await fetch(url, {
                method,
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
              });
              if (!resp.ok) {
                const j = await resp.json().catch(() => ({}));
                throw new Error(String(j.error ?? `${resp.status} ${resp.statusText}`));
              }
              setCaseDialog({ open: false, busy: false, err: null, editing: null });
              refreshCases();
              toast('Case saved', { type: 'success' });
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Save failed';
              setCaseDialog({
                open: true,
                busy: false,
                err: msg,
                editing: caseDialog.editing,
              });
              toast(`Save failed: ${msg}`, { type: 'error' });
            }
          }}
        />
      )}

      <ConfirmDialog
        open={archiveTarget != null}
        tone="destructive"
        title="Archive this case?"
        body={archiveTarget ? `The calibration case for ${archiveTarget.agentId} stops appearing in future runs.` : ''}
        confirmLabel={archiving ? 'Archiving…' : 'Archive case'}
        confirmDisabled={archiving}
        onConfirm={() => { if (archiveTarget) void archiveCase(archiveTarget); }}
        onCancel={() => setArchiveTarget(null)}
      />
    </PageSection>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface CaseForm {
  agentId: string;
  prompt: string;
  response: string;
  humanScore: number;
  humanRationale: string | null;
  notes: string | null;
}

function CaseEditor({
  editing,
  busy,
  err,
  onClose,
  onSubmit,
}: {
  editing: CalibrationCase | null;
  busy: boolean;
  err: string | null;
  onClose: () => void;
  onSubmit: (form: CaseForm) => void;
}) {
  const [agentId, setAgentId] = useState<string>(editing?.agentId ?? 'orgiq-search');
  const [prompt, setPrompt] = useState<string>(editing?.prompt ?? '');
  const [response, setResponse] = useState<string>(editing?.response ?? '');
  const [humanScore, setHumanScore] = useState<number>(editing?.humanScore ?? 0.7);
  const [humanRationale, setHumanRationale] = useState<string>(editing?.humanRationale ?? '');
  const [notes, setNotes] = useState<string>(editing?.notes ?? '');

  // Reset when 'editing' changes
  useEffect(() => {
    setAgentId(editing?.agentId ?? 'orgiq-search');
    setPrompt(editing?.prompt ?? '');
    setResponse(editing?.response ?? '');
    setHumanScore(editing?.humanScore ?? 0.7);
    setHumanRationale(editing?.humanRationale ?? '');
    setNotes(editing?.notes ?? '');
  }, [editing]);

  function submit() {
    onSubmit({
      agentId: agentId.trim(),
      prompt,
      response,
      humanScore,
      humanRationale: humanRationale.trim() || null,
      notes: notes.trim() || null,
    });
  }

  const canSubmit = !!agentId.trim() && !!prompt.trim() && Number.isFinite(humanScore);

  const footer = (
    <Inline justify="end" gap="sm" data-testid="case-editor-footer">
      <Button
        variant="secondary"
        onClick={onClose}
        disabled={busy}
        data-testid="case-editor-cancel"
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={submit}
        disabled={busy || !canSubmit}
        data-testid="case-editor-save"
      >
        {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
      </Button>
    </Inline>
  );

  return (
    <UIModal
      open
      onClose={() => { if (!busy) onClose(); }}
      title={editing ? 'Edit calibration case' : 'Add calibration case'}
      maxWidth={720}
      footer={footer}
    >
      <Stack gap="md" data-testid="case-editor">
        <FormField label="Agent">
          {({ labelId: _labelId, ...field }) => (
            <Select
              {...field}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={busy}
              data-testid="case-editor-agent"
              options={AGENT_OPTIONS.map((a) => ({ value: a, label: a }))}
            />
          )}
        </FormField>
        <Stack gap="xs" data-testid="case-editor-prompt-wrap">
          <T as="div" className="text-[11px] font-semibold text-text-secondary tracking-[0.3px]">Prompt</T>
          <CodeEditor
            language="template"
            value={prompt}
            onChange={setPrompt}
            placeholder="What the user asked the agent…"
            minLines={3}
            maxLines={10}
            readOnly={busy}
            aria-label="Prompt"
          />
        </Stack>
        <Stack gap="xs" data-testid="case-editor-response-wrap">
          <T as="div" className="text-[11px] font-semibold text-text-secondary tracking-[0.3px]">Response</T>
          <CodeEditor
            language="plain"
            value={response}
            onChange={setResponse}
            placeholder="What the agent answered (or might answer)…"
            minLines={5}
            maxLines={15}
            readOnly={busy}
            aria-label="Response"
          />
        </Stack>
        <FormField label="Human score" hint="0.0 - 1.0">
          {({ labelId: _labelId, ...field }) => (
            <NumberInput
              {...field}
              value={humanScore}
              onChange={(v) => setHumanScore(Math.max(0, Math.min(1, v)))}
              min={0}
              max={1}
              step={0.01}
              disabled={busy}
              data-testid="case-editor-score"
            />
          )}
        </FormField>
        <FormField label="Human rationale (optional)">
          {({ labelId: _labelId, ...field }) => (
            <Textarea
              {...field}
              value={humanRationale}
              onChange={(e) => setHumanRationale(e.target.value)}
              rows={2}
              disabled={busy}
              placeholder="Why this score? Helps the next researcher recalibrate."
            />
          )}
        </FormField>
        <FormField label="Notes (optional)">
          {({ labelId: _labelId, ...field }) => (
            <Input
              {...field}
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        {err && <InlineAlert tone="error">Error: {err}</InlineAlert>}
      </Stack>
    </UIModal>
  );
}

// Agent ids known to OrgIQ. Kept in sync with infra/scripts/agent_prompts.yaml.
const AGENT_OPTIONS = [
  'orgiq-supervisor',
  'orgiq-search',
  'orgiq-scoring',
  'orgiq-advisor',
  'orgiq-ingestion',
  'orgiq-graph-builder',
];

export default CalibrationPage;
