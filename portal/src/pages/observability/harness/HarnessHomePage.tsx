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
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  Chip,
  Inline,
  Input,
  PageSection,
  ProgressBar,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
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
import { UnavailableNotice } from '../../../components/UnavailableNotice';
import { T } from '../Text';
import { RowEmpty } from '../ReadState';
import { statusTone, passRateTone, fmtPct, type RunStatus } from './harnessShared';

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

// ── helpers ───────────────────────────────────────────────────────────────────

const passRateColor = (v: number | null): string => {
  if (v == null) return 'var(--color-text-tertiary)';
  if (v >= 0.85) return 'var(--color-success)';
  if (v >= 0.7) return 'var(--color-warning)';
  return 'var(--color-danger)';
};

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

  const {
    data: casesData, error: casesError, refresh: refreshCases,
  } = useFetch<unknown>(
    '/api/observability/harness/cases',
    30_000,
  );
  const cases: TestCase[] = useMemo(() => {
    const d = casesData as { cases?: TestCase[] } | TestCase[] | null;
    return Array.isArray(d) ? d : (d?.cases ?? []);
  }, [casesData]);

  const {
    data: runsData, error: runsError, refresh: refreshRuns,
  } = useFetch<unknown>(
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

  const {
    data: coverageData, error: coverageError, refresh: refreshCoverage,
  } = useFetch<unknown>(
    '/api/observability/harness/coverage',
    30_000,
  );
  const coverage: CoverageRow[] = useMemo(() => {
    const d = coverageData as { byAgent?: CoverageRow[] } | CoverageRow[] | null;
    return Array.isArray(d) ? d : (d?.byAgent ?? []);
  }, [coverageData]);

  // None of /cases, /runs or /coverage answer the `degraded: true` wire
  // marker on a failed read (they throw straight through asyncHandler, unlike
  // calibration.ts's routes) — so the only signal a broken read leaves is
  // useFetch's transport `error`. Before this, none of the three were even
  // read here: a 500 against a real Aurora outage left `casesData`/`runsData`/
  // `coverageData` null, the `?? []` fallbacks turned that into empty lists,
  // and the page rendered "No runs yet. Click Run now…" — indistinguishable
  // from a fleet that has genuinely never been tested. First failure wins,
  // same convention `firstDegraded` uses for a page backed by several reads.
  const readFailure = casesError ?? runsError ?? coverageError ?? null;

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

      // Creating a run only inserts a row; this is what makes it execute.
      // Until the engine existed there was nothing to call, so every run sat
      // at pending and the poll below watched a number that never moved.
      const exec = await fetch(
        `/api/observability/harness/runs/${encodeURIComponent(json.runId)}/execute`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' },
      );
      if (!exec.ok) {
        const body = (await exec.json().catch(() => ({}))) as { error?: string };
        setModalErr(body.error ?? `Could not start the run (${exec.status}).`);
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
        <Inline as="div" gap="sm">
          <Button
            variant="primary"
            size="sm"
            onClick={openModal}
            disabled={!!activeRunId && !activeDismissed}
          >
            Run now
          </Button>
          <Button variant="secondary" size="sm" onClick={refreshAll}>
            Refresh
          </Button>
        </Inline>
      }
    >
      {readFailure && (
        <UnavailableNotice
          error={readFailure}
          what="the test harness"
          source="Cases, runs and coverage live in the Aurora observability tables"
          onRetry={refreshAll}
          className="mb-4"
        />
      )}

      {/* Header */}
      <Card padding="md">
        <Inline
          as="div"
          align="center"
          wrap
          gap="xs"
          className="text-[12px] text-[var(--color-text-secondary)] mt-1.5"
        >
          <strong>{activeCount}</strong> active case{activeCount === 1 ? '' : 's'}
          <T className="text-[var(--color-text-tertiary)]">·</T>
          last run <strong>{relTime(lastRun?.startedAt ?? null)}</strong>
          <T className="text-[var(--color-text-tertiary)]">·</T>
          judge: <T className="font-[ui-monospace,monospace] text-[11.5px]">{judgeModelId}</T>
        </Inline>

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
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            Pass-rate over last {sparkData.length || 14} run{sparkData.length === 1 ? '' : 's'}{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              green ≥ 85% · amber 70–85% · red &lt; 70%
            </T>
          </Inline>
        </Inline>
        {sparkData.length === 0 ? (
          <RowEmpty text="No runs yet. Click Run now to replay the test set." degraded={runsError} />
        ) : (
          <Stack className="w-full h-[220px]">
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
          </Stack>
        )}
      </Card>

      {/* Recent runs */}
      <Card padding="md">
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            Recent runs{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              latest {runs.length} · Δ shows pass-count drift vs previous run
            </T>
          </Inline>
        </Inline>
        {runs.length === 0 ? (
          <SmartEmptyState
            title="No runs yet"
            detail="A run replays the active test set against agents and scores the responses with the LLM-as-judge."
            degraded={runsError}
            degradedWhat="the run history"
            degradedSource="Runs live in the Aurora observability tables"
            onRetry={refreshRuns}
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
                    <TableTd className="text-[12px] font-medium max-w-[220px]" title={r.label}>
                      <Stack gap="xs">
                        <span>{r.label}</span>
                        {r.gitSha && (
                          <T className="text-[10.5px] text-[var(--color-text-tertiary)] font-[ui-monospace,monospace]">
                            {shortSha(r.gitSha)}
                          </T>
                        )}
                      </Stack>
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <ModeChip mode={r.mode} />
                    </TableTd>
                    <TableTd className="text-[11px] text-[var(--color-text-tertiary)] whitespace-nowrap">
                      {new Date(r.startedAt).toLocaleString()}
                    </TableTd>
                    <TableTd className="text-[12px] text-[var(--color-text-secondary)] whitespace-nowrap">
                      {r.completed}/{r.totalCases}
                    </TableTd>
                    <TableTd>
                      <Chip tone={passRateTone(r.passRate)} size="xs">
                        {fmtPct(r.passRate)}
                      </Chip>
                    </TableTd>
                    <TableTd className="text-[12px] text-[var(--color-text-secondary)] whitespace-nowrap">
                      <RegressionDelta current={r} previous={prev} />
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <CostChip cost={r.totalCostUsd} />
                    </TableTd>
                    <TableTd>
                      <Chip tone={statusTone(r.status)} size="xs">
                        {r.status}
                      </Chip>
                    </TableTd>
                    <TableTd>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/admin/observability/harness/runs/${r.runId}`)}
                      >
                        view
                      </Button>
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
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap className="text-[14px] font-semibold m-0">
            Coverage{' '}
            <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
              ⚠ flag indicates &lt; 5 cases · last-run pass count shown on the right
            </T>
          </Inline>
        </Inline>
        {coverage.length === 0 ? (
          <RowEmpty text="No coverage data yet." degraded={coverageError} />
        ) : (
          <Stack gap="sm">
            {(() => {
              const maxCount = Math.max(...coverage.map((c) => c.count), 1);
              return coverage.map((c) => {
                const thin = c.count < 5;
                const hasLast =
                  c.lastRunTotal != null &&
                  c.lastRunPassed != null &&
                  c.lastRunTotal > 0;
                const lastRate = hasLast
                  ? (c.lastRunPassed as number) / (c.lastRunTotal as number)
                  : null;
                return (
                  <Inline key={c.agentId} as="div" align="center" gap="md" className="text-[12px]">
                    <Inline as="div" align="center" gap="xs" className="w-[160px] shrink-0 font-medium">
                      <span>{c.agentId}</span>
                      {thin && (
                        <T
                          className="text-[10.5px] text-[var(--color-warning)]"
                          title="Thin coverage (< 5 cases)"
                        >
                          ⚠ thin
                        </T>
                      )}
                    </Inline>
                    <Inline as="div" gap="none" className="flex-1">
                      <ProgressBar
                        value={c.count}
                        max={maxCount}
                        size="sm"
                        showRatio={false}
                        label={`${c.count} case${c.count === 1 ? '' : 's'}`}
                        color={
                          thin ? 'var(--color-warning)' : 'var(--color-primary)'
                        }
                      />
                    </Inline>
                    <T as="div" className="w-[80px] text-right">
                      {hasLast ? (
                        <Chip tone={passRateTone(lastRate)} size="xs">
                          {c.lastRunPassed}/{c.lastRunTotal}
                        </Chip>
                      ) : (
                        <T className="text-[11px] text-[var(--color-text-tertiary)] font-normal">
                          no data
                        </T>
                      )}
                    </T>
                  </Inline>
                );
              });
            })()}
          </Stack>
        )}
      </Card>

      {/* Run-now modal */}
      {modalOpen && (
        <Modal onClose={closeModal}>
          <Inline as="h3" gap="none" className="mt-0 mb-3 text-[15px] font-semibold">
            Start a new run
          </Inline>
          <Stack as="label" gap="xs" className="text-[12px] text-[var(--color-text-secondary)]">
            Label for this run
            <Input
              autoFocus
              value={modalLabel}
              onChange={(e) => setModalLabel(e.target.value)}
              placeholder="manual@2026-01-01T12:00"
            />
          </Stack>
          {modalErr && (
            <Stack
              as="div"
              gap="none"
              className="mt-2.5 py-1.5 px-2.5 text-[12px] bg-[rgba(239,68,68,0.10)] border border-[var(--color-danger)] rounded-[4px] text-[var(--color-danger)]"
            >
              {modalErr}
            </Stack>
          )}
          <Inline as="div" justify="end" gap="sm" className="mt-4">
            <Button variant="secondary" size="sm" onClick={closeModal} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={startRun} disabled={submitting}>
              {submitting ? 'Starting…' : 'Start'}
            </Button>
          </Inline>
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
    <Stack
      gap="none"
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[4px] py-1.5 px-2.5 text-[12px] leading-[1.55]"
    >
      <T as="div" className="font-semibold">
        {p.fullLabel}
      </T>
      <div>
        {p.passed}/{p.total} passing ({(p.passRate * 100).toFixed(1)}%)
      </div>
      <T as="div" className="text-[var(--color-text-tertiary)] text-[11px]">
        judge: {p.judgeModelId}
      </T>
    </Stack>
  );
}

function RegressionDelta({
  current,
  previous,
}: {
  current: TestRun;
  previous: TestRun | undefined;
}) {
  if (!previous) return <T className="text-[var(--color-text-tertiary)]">—</T>;
  const delta = current.passed - previous.passed;
  if (delta === 0) return <T className="text-[var(--color-text-tertiary)]">—</T>;
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

const activeRunBannerToneClasses: Record<'info' | 'success' | 'danger', string> = {
  success: 'bg-[rgba(16,185,129,0.10)] border-[var(--color-success)]',
  danger: 'bg-[rgba(239,68,68,0.10)] border-[var(--color-danger)]',
  info: 'bg-[rgba(99,102,241,0.10)] border-[var(--color-primary)]',
};

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

  const message = !status
    ? 'Run started · monitoring…'
    : isTerminal
      ? `Run ${status.status} · ${status.passed}/${status.total} passing`
      : `Running ${status.completed}/${status.total}…`;

  return (
    <Inline
      as="div"
      align="center"
      gap="md"
      className={`mt-3 rounded-[4px] border py-2 px-3 text-[12px] ${activeRunBannerToneClasses[tone]}`}
    >
      <T className="flex-1">
        <strong>{message}</strong>
        <T className="text-[var(--color-text-tertiary)] ml-2">
          run id: <T className="font-[ui-monospace,monospace] text-[11.5px]">{runId.slice(0, 8)}…</T>
        </T>
      </T>
      <Button variant="ghost" size="sm" onClick={onView}>
        view details
      </Button>
      {isTerminal && (
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          dismiss
        </Button>
      )}
    </Inline>
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
    <Inline
      as="div"
      align="center"
      justify="center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 bg-[rgba(0,0,0,0.4)] z-[1000]"
    >
      <Stack
        as="div"
        gap="none"
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md py-5 px-5 min-w-[360px] max-w-[480px] shadow-[0_10px_30px_rgba(0,0,0,0.25)]"
      >
        {children}
      </Stack>
    </Inline>
  );
}

export default HarnessHomePage;
