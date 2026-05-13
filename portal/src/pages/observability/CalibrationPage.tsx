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
  const { data: casesData, refresh: refreshCases } = useFetch<CasesResp>(
    '/api/observability/calibration/cases',
    30_000,
  );
  const { data: runsData, refresh: refreshRuns } = useFetch<RunsResp>(
    '/api/observability/calibration/runs?limit=14',
    30_000,
  );

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
  const lineColor = anyDangerRun ? 'var(--color-danger, #ef4444)' : 'var(--color-primary, #6366f1)';

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
    if (!confirm(`Archive case for ${c.agentId}? It will stop appearing in future runs.`)) return;
    const resp = await fetch(`/api/observability/calibration/cases/${encodeURIComponent(c.calibrationId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) refreshCases();
  }

  return (
    <div style={pageStyle}>
      {/* Header */}
      <Card padding="md">
        <div style={headerRow}>
          <div>
            <h2 style={h2title}>Judge Calibration</h2>
            <div style={subline}>
              <strong>{cases.length}</strong> active case{cases.length === 1 ? '' : 's'}
              <span style={dot}>·</span>
              judge <span style={monoInline}>{judgeModelId}</span>
              <span style={dot}>·</span>
              last MAE&nbsp;
              <Chip tone={maeTone(lastMae)} size="xs">{fmt(lastMae)}</Chip>
              {runs[0]?.startedAt ? (
                <>
                  <span style={dot}>·</span>
                  <span style={hint}>
                    {new Date(runs[0].startedAt.replace(' ', 'T')).toLocaleString()}
                  </span>
                </>
              ) : null}
            </div>
            <div style={{ ...subline, marginTop: 4 }}>
              <span style={hint}>
                Judge drift means our historical quality scores have lost their anchor.
                Target MAE &lt; {WARN_MAE.toFixed(2)}; investigate above {DANGER_MAE.toFixed(2)}.
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => { setRunLabel(defaultLabel()); setRunDialog({ open: true, busy: false, err: null }); }}
              style={primaryBtn}
              disabled={cases.length === 0}
              title={cases.length === 0 ? 'Add calibration cases first' : 'Run the judge over all active cases'}
            >
              + Run calibration
            </button>
          </div>
        </div>
      </Card>

      {/* MAE trend */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            MAE Trend{' '}
            <span style={hint}>
              mean absolute error vs human score · last {maeTrend.length} run
              {maeTrend.length === 1 ? '' : 's'} · oldest left
            </span>
          </h2>
        </div>
        {maeTrend.length === 0 ? (
          <EmptyState text="No calibration runs yet. Run one with the button above." />
        ) : (
          <div style={{ width: '100%', height: 220 }}>
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
                  stroke="var(--color-warning, #f59e0b)"
                  strokeDasharray="4 2"
                  label={{
                    value: `warn ${WARN_MAE.toFixed(2)}`,
                    fontSize: 10,
                    fill: 'var(--color-warning, #f59e0b)',
                    position: 'right',
                  }}
                />
                <ReferenceLine
                  y={DANGER_MAE}
                  stroke="var(--color-danger, #ef4444)"
                  strokeDasharray="4 2"
                  label={{
                    value: `danger ${DANGER_MAE.toFixed(2)}`,
                    fontSize: 10,
                    fill: 'var(--color-danger, #ef4444)',
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
                  stroke="var(--color-text-tertiary, #94a3b8)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Scatter */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Judge vs Human Score{' '}
            <span style={hint}>
              latest run · diagonal = perfect agreement · above = judge over-rates ·
              below = judge under-rates
              {latestRun?.run.label ? ` · ${latestRun.run.label}` : ''}
            </span>
          </h2>
        </div>
        {scatterPoints.length === 0 ? (
          <EmptyState text="No paired scores in the latest run." />
        ) : (
          <div style={{ width: '100%', height: 320 }}>
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
                  stroke="var(--color-text-tertiary, #94a3b8)"
                  strokeDasharray="4 2"
                />
                <Scatter
                  data={scatterPoints}
                  fill="var(--color-primary, #6366f1)"
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Worst disagreements */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Worst Disagreements{' '}
            <span style={hint}>
              top {worstResults.length} cases by |judge − human| · click to expand response
            </span>
          </h2>
        </div>
        {worstResults.length === 0 ? (
          <EmptyState text="No disagreements yet — run a calibration first." />
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
                      style={{ cursor: 'pointer' }}
                    >
                      <TableTd style={agentCell}>{r.agentId ?? '—'}</TableTd>
                      <TableTd style={snippetCell} title={r.prompt}>
                        {snip(r.prompt, 80) || '(empty)'}
                      </TableTd>
                      <TableTd style={numCell}>{fmt2(r.humanScore)}</TableTd>
                      <TableTd style={numCell}>{fmt2(r.judgeScore)}</TableTd>
                      <TableTd>
                        <Chip tone={maeTone(r.absError)} size="xs">{fmt(r.absError)}</Chip>
                      </TableTd>
                      <TableTd style={snippetCell} title={r.judgeRationale ?? ''}>
                        {snip(r.judgeRationale, 60) || '—'}
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${r.calibrationId}-detail`}>
                        <TableTd colSpan={6} style={detailRowCell}>
                          <div style={diffGrid}>
                            <div>
                              <div style={detailLabel}>
                                PROMPT · agent={r.agentId ?? '—'}
                              </div>
                              <pre style={detailPre}>{r.prompt ?? '(no prompt)'}</pre>
                              <div style={{ ...detailLabel, marginTop: 12 }}>RESPONSE</div>
                              <pre style={detailPre}>{r.response ?? '(no response)'}</pre>
                            </div>
                            <div>
                              <div style={detailLabel}>
                                HUMAN <span style={monoInline}>{fmt2(r.humanScore)}</span>
                              </div>
                              <pre style={detailPre}>
                                {r.humanRationale ?? '(no rationale recorded)'}
                              </pre>
                              <div style={{ ...detailLabel, marginTop: 12 }}>
                                JUDGE <span style={monoInline}>{fmt2(r.judgeScore)}</span>
                              </div>
                              <pre style={detailPre}>
                                {r.judgeRationale ?? '(no rationale returned)'}
                              </pre>
                            </div>
                          </div>
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
        <div style={headerRow}>
          <h2 style={h2}>
            Manage Cases{' '}
            <span style={hint}>
              {cases.length} active · curate the corpus the judge gets tested against
            </span>
          </h2>
          <button
            type="button"
            onClick={() => setCaseDialog({ open: true, busy: false, err: null, editing: null })}
            style={secondaryBtn}
          >
            + Add case
          </button>
        </div>
        {cases.length === 0 ? (
          <EmptyState text="No active calibration cases. Add one above or run infra/scripts/seed_calibration_cases.py." />
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
                  <TableTd style={agentCell}>{c.agentId}</TableTd>
                  <TableTd style={snippetCell} title={c.prompt}>{snip(c.prompt, 100)}</TableTd>
                  <TableTd style={numCell}>{fmt2(c.humanScore)}</TableTd>
                  <TableTd style={tsCell}>
                    {c.updatedAt
                      ? new Date(c.updatedAt.replace(' ', 'T')).toLocaleDateString()
                      : '—'}
                  </TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button
                      type="button"
                      onClick={() =>
                        setCaseDialog({ open: true, busy: false, err: null, editing: c })
                      }
                      style={inlineBtn}
                    >
                      Edit
                    </button>
                    <span style={{ ...dot, margin: '0 6px' }}>·</span>
                    <button
                      type="button"
                      onClick={() => archiveCase(c)}
                      style={inlineBtnDanger}
                    >
                      Archive
                    </button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Run calibration dialog */}
      {runDialog.open && (
        <Modal
          title="Run calibration"
          onClose={() => !runDialog.busy && setRunDialog({ open: false, busy: false, err: null })}
        >
          <div style={modalForm}>
            <label style={formLabel}>
              Label
              <input
                type="text"
                value={runLabel}
                onChange={(e) => setRunLabel(e.target.value)}
                disabled={runDialog.busy}
                style={textInput}
              />
            </label>
            <div style={hint}>
              The judge will be re-run over all {cases.length} active case
              {cases.length === 1 ? '' : 's'}. ~1 second per case. Cost is one
              Nova-Pro call per case (≈ $0.001 / 20 cases).
            </div>
            {runDialog.err && (
              <div style={errBlock}>Error: {runDialog.err}</div>
            )}
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setRunDialog({ open: false, busy: false, err: null })}
                style={secondaryBtn}
                disabled={runDialog.busy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRunCalibration}
                style={primaryBtn}
                disabled={runDialog.busy}
              >
                {runDialog.busy ? 'Running…' : 'Run'}
              </button>
            </div>
          </div>
        </Modal>
      )}

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
            } catch (e) {
              setCaseDialog({
                open: true,
                busy: false,
                err: e instanceof Error ? e.message : 'Save failed',
                editing: caseDialog.editing,
              });
            }
          }}
        />
      )}
    </div>
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
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

  return (
    <Modal title={editing ? 'Edit calibration case' : 'Add calibration case'} onClose={onClose}>
      <form onSubmit={submit} style={modalForm}>
        <label style={formLabel}>
          Agent
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={busy}
            style={textInput}
          >
            {AGENT_OPTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label style={formLabel}>
          Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
            style={textArea}
            placeholder="What the user asked the agent…"
          />
        </label>
        <label style={formLabel}>
          Response
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            rows={5}
            disabled={busy}
            style={textArea}
            placeholder="What the agent answered (or might answer)…"
          />
        </label>
        <label style={formLabel}>
          Human score · <strong>{humanScore.toFixed(2)}</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={humanScore}
              onChange={(e) => setHumanScore(Number(e.target.value))}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={humanScore}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setHumanScore(Math.max(0, Math.min(1, v)));
              }}
              disabled={busy}
              style={{ ...textInput, width: 80 }}
            />
          </div>
        </label>
        <label style={formLabel}>
          Human rationale (optional)
          <textarea
            value={humanRationale}
            onChange={(e) => setHumanRationale(e.target.value)}
            rows={2}
            disabled={busy}
            style={textArea}
            placeholder="Why this score? Helps the next researcher recalibrate."
          />
        </label>
        <label style={formLabel}>
          Notes (optional)
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
            style={textInput}
          />
        </label>
        {err && <div style={errBlock}>Error: {err}</div>}
        <div style={modalActions}>
          <button type="button" onClick={onClose} style={secondaryBtn} disabled={busy}>
            Cancel
          </button>
          <button type="submit" style={primaryBtn} disabled={busy || !canSubmit}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
        <div style={modalHeader}>
          <h3 style={modalTitle}>{title}</h3>
          <button onClick={onClose} style={closeBtn} aria-label="Close" type="button">×</button>
        </div>
        <div style={modalBody}>{children}</div>
      </div>
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

// Agent ids known to OrgIQ. Kept in sync with infra/scripts/agent_prompts.yaml.
const AGENT_OPTIONS = [
  'orgiq-supervisor',
  'orgiq-search',
  'orgiq-scoring',
  'orgiq-advisor',
  'orgiq-ingestion',
  'orgiq-graph-builder',
];

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
const snippetCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const detailRowCell: CSSProperties = {
  padding: 12,
  background: 'var(--color-bg)',
};
const diffGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const detailLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  marginBottom: 4,
  letterSpacing: 0.5,
};
const detailPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 4,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  maxHeight: 200,
  overflowY: 'auto',
};
const primaryBtn: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  color: 'white',
  background: 'var(--color-primary, #6366f1)',
  border: '1px solid transparent',
  borderRadius: 4,
  cursor: 'pointer',
};
const secondaryBtn: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-primary)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  cursor: 'pointer',
};
const inlineBtn: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-primary, #6366f1)',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};
const inlineBtnDanger: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-danger, #ef4444)',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};
const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};
const modalStyle: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  minWidth: 520,
  maxWidth: 720,
  width: '70vw',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
};
const modalHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid var(--color-border)',
};
const modalTitle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
};
const closeBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 20,
  lineHeight: 1,
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
  padding: '0 4px',
};
const modalBody: CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  fontSize: 12,
};
const modalForm: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const modalActions: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 4,
};
const formLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  letterSpacing: 0.3,
};
const textInput: CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  fontWeight: 400,
};
const textArea: CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  fontWeight: 400,
  fontFamily: 'inherit',
  resize: 'vertical',
};
const errBlock: CSSProperties = {
  padding: '8px 12px',
  fontSize: 12,
  background: 'rgba(239, 68, 68, 0.08)',
  border: '1px solid var(--color-danger, #ef4444)',
  borderRadius: 4,
  color: 'var(--color-danger, #ef4444)',
};

export default CalibrationPage;
