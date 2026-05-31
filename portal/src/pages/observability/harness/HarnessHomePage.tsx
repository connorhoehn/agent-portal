// Test harness home. Researchers trigger a replay of the curated test set,
// read pass/fail across the last 14 runs, and spot coverage gaps.
//
// Endpoints (all under /api/observability/harness):
//   GET  /cases                  → {cases: TestCase[]}
//   GET  /runs?limit=14          → {runs: TestRun[]}
//   GET  /coverage               → {byAgent: [...]}
//   GET  /runs/:id/status        → {status, completed, total, passed, failed, passRate}
//   POST /runs                   → {runId}

import { useEffect, useMemo, useRef, useState } from 'react';
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
  Cell,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFetch } from '../../../hooks/useFetch';
import { CostChip } from '../../../components/observability/CostChip';
import { ModeChip } from '../../../components/observability/ModeChip';
import { SmartEmptyState } from '../../../components/observability/SmartEmptyState';

// ── types ─────────────────────────────────────────────────────────────────────

interface TestCase {
  testId: string;
  agentId: string;
  templateId: string | null;
  prompt: string;
  referenceOutput: string | null;
  expectedTags: string[];
  passThreshold: number;
  active: boolean;
  notes: string | null;
}

type RunStatus = 'pending' | 'running' | 'done' | 'failed';

interface TestRun {
  runId: string;
  label: string;
  gitSha: string | null;
  judgeModelId: string;
  status: RunStatus;
  totalCases: number;
  completed: number;
  passed: number;
  failed: number;
  passRate: number | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  // Sprint 1 fields (nullable until Agent A's migration lands).
  mode?: 'live' | 'sim' | string | null;
  totalCostUsd?: number | null;
}

interface CoverageRow {
  agentId: string;
  count: number;
  lastRunPassed?: number;
  lastRunTotal?: number;
}

interface RunStatusResp {
  status: RunStatus;
  completed: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
}

type Tone = 'success' | 'warning' | 'danger';

// ── helpers ───────────────────────────────────────────────────────────────────

const passRateTone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.85 ? 'success' : v >= 0.7 ? 'warning' : 'danger';

const passRateColor = (v: number | null): string => {
  if (v == null) return 'var(--color-text-tertiary, #94a3b8)';
  if (v >= 0.85) return 'var(--color-success, #10b981)';
  if (v >= 0.7) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-danger, #ef4444)';
};

const statusTone = (s: RunStatus): Tone => {
  if (s === 'done') return 'success';
  if (s === 'failed') return 'danger';
  return 'warning'; // pending / running
};

const fmtPct = (v: number | null, digits = 1): string =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleString();
}

function shortSha(s: string | null): string {
  if (!s) return '';
  return s.length > 7 ? s.slice(0, 7) : s;
}

function defaultLabel(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `manual@${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── component ─────────────────────────────────────────────────────────────────

function HarnessHomePage() {
  const navigate = useNavigate();

  const { data: casesData, refresh: refreshCases } = useFetch<unknown>(
    '/api/observability/harness/cases',
    30_000,
  );
  const cases: TestCase[] = useMemo(() => {
    const d = casesData as { cases?: TestCase[] } | TestCase[] | null;
    return Array.isArray(d) ? d : (d?.cases ?? []);
  }, [casesData]);

  const { data: runsData, refresh: refreshRuns } = useFetch<unknown>(
    '/api/observability/harness/runs?limit=14',
    30_000,
  );
  const runs: TestRun[] = useMemo(() => {
    const d = runsData as { runs?: TestRun[] } | TestRun[] | null;
    const list = Array.isArray(d) ? d : (d?.runs ?? []);
    // Defensive: ensure desc by startedAt — backend already sorts but we don't trust order.
    return [...list].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [runsData]);

  const { data: coverageData, refresh: refreshCoverage } = useFetch<unknown>(
    '/api/observability/harness/coverage',
    30_000,
  );
  const coverage: CoverageRow[] = useMemo(() => {
    const d = coverageData as { byAgent?: CoverageRow[] } | CoverageRow[] | null;
    return Array.isArray(d) ? d : (d?.byAgent ?? []);
  }, [coverageData]);

  const activeCount = useMemo(() => cases.filter((c) => c.active).length, [cases]);
  const lastRun = runs[0] ?? null;
  const judgeModelId = lastRun?.judgeModelId ?? '—';

  // ── run-now modal + active-run polling state ───────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [modalLabel, setModalLabel] = useState('');
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<RunStatusResp | null>(null);
  const [activeDismissed, setActiveDismissed] = useState(false);
  const pollRef = useRef<number | null>(null);

  function openModal() {
    setModalLabel(defaultLabel());
    setModalErr(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (submitting) return;
    setModalOpen(false);
  }

  async function startRun() {
    if (!modalLabel.trim()) {
      setModalErr('Label is required.');
      return;
    }
    setSubmitting(true);
    setModalErr(null);
    try {
      const res = await fetch('/api/observability/harness/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ label: modalLabel.trim() }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        setModalErr(`Failed to start run (${res.status}). ${txt.slice(0, 120)}`);
        return;
      }
      const json = (await res.json()) as { runId?: string };
      if (!json.runId) {
        setModalErr('Response missing runId.');
        return;
      }
      setActiveRunId(json.runId);
      setActiveStatus(null);
      setActiveDismissed(false);
      setModalOpen(false);
      refreshRuns();
    } catch (e) {
      setModalErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  // Poll the active run every 2s. Stop when terminal.
  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    async function tick() {
      if (cancelled || !activeRunId) return;
      try {
        const res = await fetch(
          `/api/observability/harness/runs/${encodeURIComponent(activeRunId)}/status`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const json = (await res.json()) as RunStatusResp;
          if (!cancelled) {
            setActiveStatus(json);
            if (json.status === 'done' || json.status === 'failed') {
              refreshRuns();
              if (pollRef.current) {
                window.clearInterval(pollRef.current);
                pollRef.current = null;
              }
            }
          }
        }
      } catch {
        // ignore transient errors — keep polling
      }
    }
    tick();
    pollRef.current = window.setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeRunId, refreshRuns]);

  function refreshAll() {
    refreshCases();
    refreshRuns();
    refreshCoverage();
  }

  // ── sparkline data ─────────────────────────────────────────────────────────

  // Reverse so x-axis goes oldest → newest left-to-right.
  const sparkData = useMemo(() => {
    return [...runs]
      .reverse()
      .map((r) => ({
        runId: r.runId,
        label: r.label.length > 7 ? r.label.slice(-7) : r.label,
        fullLabel: r.label,
        passRate: r.passRate ?? 0,
        passRatePct: r.passRate != null ? Number((r.passRate * 100).toFixed(1)) : 0,
        passed: r.passed,
        total: r.totalCases,
        judgeModelId: r.judgeModelId,
      }));
  }, [runs]);

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <PageSection
      title="Test Harness"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPrimary} onClick={openModal} disabled={!!activeRunId && !activeDismissed}>
            Run now
          </button>
          <button style={btnSecondary} onClick={refreshAll}>
            Refresh
          </button>
        </div>
      }
    >
      {/* Header */}
      <Card padding="md">
        <div style={subline}>
          <strong>{activeCount}</strong> active case{activeCount === 1 ? '' : 's'}
          <span style={dot}>·</span>
          last run <strong>{relTime(lastRun?.startedAt ?? null)}</strong>
          <span style={dot}>·</span>
          judge: <span style={monoInline}>{judgeModelId}</span>
        </div>

        {/* Active-run banner */}
        {activeRunId && !activeDismissed && (
          <ActiveRunBanner
            runId={activeRunId}
            status={activeStatus}
            onView={() => navigate(`/admin/observability/harness/runs/${activeRunId}`)}
            onDismiss={() => setActiveDismissed(true)}
          />
        )}
      </Card>

      {/* Pass-rate sparkline */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Pass-rate over last {sparkData.length || 14} run{sparkData.length === 1 ? '' : 's'}{' '}
            <span style={hint}>green ≥ 85% · amber 70–85% · red &lt; 70%</span>
          </h2>
        </div>
        {sparkData.length === 0 ? (
          <EmptyState text="No runs yet. Click Run now to replay the test set." />
        ) : (
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={sparkData} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={36}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  cursor={{ fill: 'var(--color-surface-hover)' }}
                  contentStyle={{
                    fontSize: 12,
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                  }}
                  content={<SparkTooltip />}
                />
                <Bar dataKey="passRatePct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                  {sparkData.map((d) => (
                    <Cell key={d.runId} fill={passRateColor(d.passRate)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Recent runs */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Recent runs{' '}
            <span style={hint}>
              latest {runs.length} · Δ shows pass-count drift vs previous run
            </span>
          </h2>
        </div>
        {runs.length === 0 ? (
          <SmartEmptyState
            title="No runs yet"
            detail="A run replays the active test set against agents and scores the responses with the LLM-as-judge."
            actions={[
              {
                label: 'Run the test harness',
                detail: 'Or click Run now in the header above for a labelled run.',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Label</TableTh>
                <TableTh>Mode</TableTh>
                <TableTh>Started</TableTh>
                <TableTh>Progress</TableTh>
                <TableTh>Pass rate</TableTh>
                <TableTh>Δ</TableTh>
                <TableTh>Cost</TableTh>
                <TableTh>Status</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map((r, i) => {
                // "Previous run" in time = the one immediately after this one
                // in the runs[] array (because runs is sorted desc by startedAt).
                const prev = runs[i + 1];
                return (
                  <TableRow key={r.runId}>
                    <TableTd style={labelCell} title={r.label}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span>{r.label}</span>
                        {r.gitSha && (
                          <span style={shaInline}>{shortSha(r.gitSha)}</span>
                        )}
                      </div>
                    </TableTd>
                    <TableTd style={{ whiteSpace: 'nowrap' }}>
                      <ModeChip mode={r.mode} />
                    </TableTd>
                    <TableTd style={tsCell}>
                      {new Date(r.startedAt).toLocaleString()}
                    </TableTd>
                    <TableTd style={numCell}>
                      {r.completed}/{r.totalCases}
                    </TableTd>
                    <TableTd>
                      <Chip tone={passRateTone(r.passRate)} size="xs">
                        {fmtPct(r.passRate)}
                      </Chip>
                    </TableTd>
                    <TableTd style={numCell}>
                      <RegressionDelta current={r} previous={prev} />
                    </TableTd>
                    <TableTd style={{ whiteSpace: 'nowrap' }}>
                      <CostChip cost={r.totalCostUsd} />
                    </TableTd>
                    <TableTd>
                      <Chip tone={statusTone(r.status)} size="xs">
                        {r.status}
                      </Chip>
                    </TableTd>
                    <TableTd>
                      <button
                        style={btnLink}
                        onClick={() => navigate(`/admin/observability/harness/runs/${r.runId}`)}
                      >
                        view
                      </button>
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Coverage bars */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Coverage{' '}
            <span style={hint}>
              ⚠ flag indicates &lt; 5 cases · last-run pass count shown on the right
            </span>
          </h2>
        </div>
        {coverage.length === 0 ? (
          <EmptyState text="No coverage data yet." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(() => {
              const maxCount = Math.max(...coverage.map((c) => c.count), 1);
              return coverage.map((c) => {
                const thin = c.count < 5;
                const pct = Math.max(2, Math.round((c.count / maxCount) * 100));
                const hasLast =
                  c.lastRunTotal != null &&
                  c.lastRunPassed != null &&
                  c.lastRunTotal > 0;
                const lastRate = hasLast
                  ? (c.lastRunPassed as number) / (c.lastRunTotal as number)
                  : null;
                return (
                  <div key={c.agentId} style={coverageRow}>
                    <div style={coverageLabel}>
                      <span>{c.agentId}</span>
                      {thin && (
                        <span style={warnInline} title="Thin coverage (< 5 cases)">
                          ⚠ thin
                        </span>
                      )}
                    </div>
                    <div style={coverageBarTrack}>
                      <div
                        style={{
                          ...coverageBarFill,
                          width: `${pct}%`,
                          background: thin
                            ? 'var(--color-warning, #f59e0b)'
                            : 'var(--color-primary, #6366f1)',
                        }}
                      />
                      <span style={coverageBarText}>{c.count} case{c.count === 1 ? '' : 's'}</span>
                    </div>
                    <div style={coverageRight}>
                      {hasLast ? (
                        <Chip tone={passRateTone(lastRate)} size="xs">
                          {c.lastRunPassed}/{c.lastRunTotal}
                        </Chip>
                      ) : (
                        <span style={hint}>no data</span>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </Card>

      {/* Run-now modal */}
      {modalOpen && (
        <Modal onClose={closeModal}>
          <h3 style={modalTitle}>Start a new run</h3>
          <label style={modalLabelStyle}>
            Label for this run
            <input
              autoFocus
              value={modalLabel}
              onChange={(e) => setModalLabel(e.target.value)}
              style={modalInput}
              placeholder="manual@2026-01-01T12:00"
            />
          </label>
          {modalErr && <div style={modalError}>{modalErr}</div>}
          <div style={modalActions}>
            <button style={btnSecondary} onClick={closeModal} disabled={submitting}>
              Cancel
            </button>
            <button style={btnPrimary} onClick={startRun} disabled={submitting}>
              {submitting ? 'Starting…' : 'Start'}
            </button>
          </div>
        </Modal>
      )}
    </PageSection>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

interface SparkPayload {
  fullLabel: string;
  passed: number;
  total: number;
  passRate: number;
  passRatePct: number;
  judgeModelId: string;
}

function SparkTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload: SparkPayload }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const p = props.payload[0].payload;
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        padding: '6px 10px',
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600 }}>{p.fullLabel}</div>
      <div>
        {p.passed}/{p.total} passing ({(p.passRate * 100).toFixed(1)}%)
      </div>
      <div style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>
        judge: {p.judgeModelId}
      </div>
    </div>
  );
}

function RegressionDelta({
  current,
  previous,
}: {
  current: TestRun;
  previous: TestRun | undefined;
}) {
  if (!previous) return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
  const delta = current.passed - previous.passed;
  if (delta === 0) return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
  if (delta > 0) {
    return (
      <Chip tone="success" size="xs">
        ↑ {delta}
      </Chip>
    );
  }
  return (
    <Chip tone="danger" size="xs">
      ↓ {Math.abs(delta)}
    </Chip>
  );
}

function ActiveRunBanner({
  runId,
  status,
  onView,
  onDismiss,
}: {
  runId: string;
  status: RunStatusResp | null;
  onView: () => void;
  onDismiss: () => void;
}) {
  const isTerminal = status?.status === 'done' || status?.status === 'failed';
  const tone: 'info' | 'success' | 'danger' =
    status?.status === 'done'
      ? 'success'
      : status?.status === 'failed'
        ? 'danger'
        : 'info';

  const bg =
    tone === 'success'
      ? 'rgba(16,185,129,0.10)'
      : tone === 'danger'
        ? 'rgba(239,68,68,0.10)'
        : 'rgba(99,102,241,0.10)';
  const border =
    tone === 'success'
      ? 'var(--color-success, #10b981)'
      : tone === 'danger'
        ? 'var(--color-danger, #ef4444)'
        : 'var(--color-primary, #6366f1)';

  const message = !status
    ? 'Run started · monitoring…'
    : isTerminal
      ? `Run ${status.status} · ${status.passed}/${status.total} passing`
      : `Running ${status.completed}/${status.total}…`;

  return (
    <div
      style={{
        marginTop: 12,
        padding: '8px 12px',
        borderRadius: 4,
        background: bg,
        border: `1px solid ${border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 12,
      }}
    >
      <span style={{ flex: 1 }}>
        <strong>{message}</strong>
        <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 8 }}>
          run id: <span style={monoInline}>{runId.slice(0, 8)}…</span>
        </span>
      </span>
      <button style={btnLink} onClick={onView}>
        view details
      </button>
      {isTerminal && (
        <button style={btnLink} onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          padding: 20,
          minWidth: 360,
          maxWidth: 480,
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        }}
      >
        {children}
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

// ── styles ────────────────────────────────────────────────────────────────────

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap',
};
const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const subline: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  marginTop: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
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
const labelCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  maxWidth: 220,
};
const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};
const numCell: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  whiteSpace: 'nowrap',
};
const shaInline: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
};
const coverageRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr 80px',
  alignItems: 'center',
  gap: 12,
  fontSize: 12,
};
const coverageLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontWeight: 500,
};
const warnInline: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-warning, #f59e0b)',
};
const coverageBarTrack: CSSProperties = {
  position: 'relative',
  height: 18,
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  overflow: 'hidden',
};
const coverageBarFill: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
};
const coverageBarText: CSSProperties = {
  position: 'absolute',
  left: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  fontSize: 11,
  color: 'var(--color-text-primary)',
  fontWeight: 500,
  textShadow: '0 0 2px var(--color-surface)',
};
const coverageRight: CSSProperties = {
  textAlign: 'right',
};
const btnPrimary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};
const btnSecondary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};
const btnLink: CSSProperties = {
  padding: '2px 8px',
  fontSize: 12,
  background: 'transparent',
  color: 'var(--color-primary, #6366f1)',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};
const modalTitle: CSSProperties = {
  margin: '0 0 12px 0',
  fontSize: 15,
  fontWeight: 600,
};
const modalLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};
const modalInput: CSSProperties = {
  padding: '6px 10px',
  fontSize: 13,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};
const modalError: CSSProperties = {
  marginTop: 10,
  padding: '6px 10px',
  fontSize: 12,
  background: 'rgba(239,68,68,0.10)',
  border: '1px solid var(--color-danger, #ef4444)',
  borderRadius: 'var(--radius-sm, 4px)',
  color: 'var(--color-danger, #ef4444)',
};
const modalActions: CSSProperties = {
  marginTop: 16,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

export default HarnessHomePage;
