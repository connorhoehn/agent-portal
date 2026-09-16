// Single run detail. Shows header + regressions (if any) + full matrix.
// Endpoints:
//   GET /api/observability/harness/runs/:id            → {run, results}
//   GET /api/observability/harness/runs?limit=14       → used to find prev run
//   GET /api/observability/harness/runs/:prevId        → previous results for delta

import { useEffect, useMemo, useState, Fragment } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  CodeBlock,
  Inline,
  Modal,
  PageSection,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCrumbLabel } from '../../../lib/crumbLabels';
import { CostChip } from '../../../components/observability/CostChip';
import { ModeChip } from '../../../components/observability/ModeChip';
import { T } from '../Text';
import { RowEmpty } from '../ReadState';
import { PassChip, SchemaChip, ErrorBlock, RunIdLine } from './harnessShared';

// ── types ─────────────────────────────────────────────────────────────────────

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
  // Sprint 3 (M8) — used by the promote modal so the user can bless this
  // run's prompt versions for production.
  agentVersions?: Record<string, string>;
}

interface TestResult {
  runId: string;
  testId: string;
  invocationId: string | null;
  passed: boolean | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  tagHits: Record<string, boolean> | null;
  referenceSimilarity: number | null;
  responseSnippet: string | null;
  failReasons: string[] | null;
  durationMs: number | null;
  ts: string;
  // joined when GET /runs/:id
  agentId?: string;
  prompt?: string;
  // Sprint 1 cost + provenance (nullable until Agent A's migration lands).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
}

interface RunDetailResp {
  run: TestRun;
  results: TestResult[];
}

type Tone = 'success' | 'warning' | 'danger';

// ── helpers ───────────────────────────────────────────────────────────────────

const passRateTone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.85 ? 'success' : v >= 0.7 ? 'warning' : 'danger';

const statusTone = (s: RunStatus): Tone => {
  if (s === 'done') return 'success';
  if (s === 'failed') return 'danger';
  return 'warning';
};

const judgeTone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmtPct = (v: number | null, digits = 1): string =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';

const fmt = (v: number | null, digits = 2): string =>
  v != null && Number.isFinite(v) ? v.toFixed(digits) : '—';

function durationStr(startIso: string, endIso: string | null): string {
  if (!endIso) return '—';
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const ms = b - a;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function shortSha(s: string | null): string {
  if (!s) return '';
  return s.length > 7 ? s.slice(0, 7) : s;
}

function tagSummary(t: Record<string, boolean> | null): string {
  if (!t) return '—';
  const entries = Object.entries(t);
  if (entries.length === 0) return '—';
  const hit = entries.filter(([, v]) => v).length;
  return `${hit}/${entries.length}`;
}

function tagTone(t: Record<string, boolean> | null): Tone {
  if (!t) return 'warning';
  const entries = Object.entries(t);
  if (entries.length === 0) return 'warning';
  const hit = entries.filter(([, v]) => v).length;
  const ratio = hit / entries.length;
  return ratio >= 0.85 ? 'success' : ratio >= 0.5 ? 'warning' : 'danger';
}

function snip(s: string | null, max = 80): string {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── component ─────────────────────────────────────────────────────────────────

function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const runId = params.runId ?? '';

  // Sprint 3 (M8) — promote modal toggle.
  const [promoteOpen, setPromoteOpen] = useState(false);

  // Poll active runs every 5s; once the run reaches a terminal state it is
  // static, so stop polling entirely rather than just widening the interval.
  const [terminal, setTerminal] = useState(false);
  useEffect(() => { setTerminal(false); }, [runId]);
  const { data: detailData, isLoading, error } = useFetch<RunDetailResp>(
    runId ? `/api/observability/harness/runs/${encodeURIComponent(runId)}` : '',
    terminal ? undefined : 5_000,
  );
  const run = detailData?.run ?? null;
  useEffect(() => {
    if (run && (run.status === 'done' || run.status === 'failed')) setTerminal(true);
  }, [run]);
  // The trail reads the run's label ("nightly-2026-08-24"), not "Run b000…".
  useCrumbLabel(runId, run?.label);
  const results = useMemo<TestResult[]>(
    () => (detailData?.results ? [...detailData.results] : []),
    [detailData],
  );

  // Locate the previous run (the run immediately preceding this one in time).
  const { data: runsData } = useFetch<unknown>(
    '/api/observability/harness/runs?limit=14',
    30_000,
  );
  const allRuns: TestRun[] = useMemo(() => {
    const d = runsData as { runs?: TestRun[] } | TestRun[] | null;
    const list = Array.isArray(d) ? d : (d?.runs ?? []);
    return [...list].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [runsData]);

  const previousRunId = useMemo<string | null>(() => {
    const idx = allRuns.findIndex((r) => r.runId === runId);
    if (idx < 0) return null;
    return allRuns[idx + 1]?.runId ?? null;
  }, [allRuns, runId]);

  // Fetch previous run's results once we know the id. Static endpoint — no poll.
  const [prevResults, setPrevResults] = useState<TestResult[] | null>(null);
  useEffect(() => {
    if (!previousRunId) {
      setPrevResults(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/observability/harness/runs/${encodeURIComponent(previousRunId)}`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: RunDetailResp | null) => {
        if (!cancelled) setPrevResults(j?.results ?? []);
      })
      .catch(() => {
        if (!cancelled) setPrevResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [previousRunId]);

  // Build regression list: tests present in both runs whose score dropped.
  const regressions = useMemo<
    Array<{
      testId: string;
      agentId: string | undefined;
      prev: number | null;
      curr: number | null;
      delta: number;
      responseSnippet: string | null;
    }>
  >(() => {
    if (!prevResults || prevResults.length === 0) return [];
    const prevMap = new Map<string, TestResult>(prevResults.map((r) => [r.testId, r]));
    const out: Array<{
      testId: string;
      agentId: string | undefined;
      prev: number | null;
      curr: number | null;
      delta: number;
      responseSnippet: string | null;
    }> = [];
    for (const r of results) {
      const p = prevMap.get(r.testId);
      if (!p) continue;
      const prevScore = p.judgeScore;
      const currScore = r.judgeScore;
      if (prevScore == null || currScore == null) continue;
      const delta = currScore - prevScore;
      if (delta >= 0) continue; // only regressions
      out.push({
        testId: r.testId,
        agentId: r.agentId,
        prev: prevScore,
        curr: currScore,
        delta,
        responseSnippet: r.responseSnippet,
      });
    }
    out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return out;
  }, [results, prevResults]);

  // Sort full matrix ascending by score by default (lowest = most interesting).
  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => {
      const av = a.judgeScore ?? 999;
      const bv = b.judgeScore ?? 999;
      return av - bv;
    });
  }, [results]);

  // Cases without results — when total > completed.
  const missingCount =
    run && run.totalCases > 0 ? Math.max(0, run.totalCases - run.completed) : 0;

  // Matrix collapse: closed by default if regressions exist, open if not.
  const hasRegressions = regressions.length > 0;
  const [matrixOpen, setMatrixOpen] = useState<boolean | null>(null);
  const matrixDefault = !hasRegressions;
  const matrixIsOpen = matrixOpen ?? matrixDefault;

  const [expanded, setExpanded] = useState<string | null>(null);

  // ── render ─────────────────────────────────────────────────────────────────

  if (!runId) {
    return <ErrorBlock title="Missing run id" detail="No run id in the URL." />;
  }
  if (error) {
    return (
      <ErrorBlock
        title="Could not load run"
        detail={error}
        context={<RunIdLine runId={runId} />}
      />
    );
  }
  if (!run && isLoading) {
    return (
      <PageSection title="Harness Run">
        <Card padding="md">
          <T as="div" className="text-text-tertiary text-[12px]">
            Loading run…
          </T>
        </Card>
      </PageSection>
    );
  }
  if (!run) {
    return (
      <ErrorBlock
        title="Run not found"
        detail={`No run with id "${runId}" yet — the backend may be initialising.`}
        context={<RunIdLine runId={runId} />}
      />
    );
  }

  return (
    <PageSection title={run.label}>
      {/* Header */}
      <Card padding="md">
        <Inline justify="between" align="start" gap="md" className="mb-3">
          <Stack gap="xs">
            <Inline gap="sm" align="center">
              <Chip tone={statusTone(run.status)} size="xs">
                {run.status}
              </Chip>
              <ModeChip mode={run.mode} />
              <Inline
                as="span"
                gap="xs"
                className="text-[11px] text-text-tertiary"
                title="total cost across all results in this run"
              >
                <CostChip cost={run.totalCostUsd} />
                <T>total</T>
              </Inline>
            </Inline>
            <Inline gap="sm" align="center" className="text-[12px] text-text-secondary">
              <T>started <strong>{new Date(run.startedAt).toLocaleString()}</strong></T>
              {run.finishedAt && (
                <>
                  <T className="text-text-tertiary">·</T>
                  <T>finished <strong>{new Date(run.finishedAt).toLocaleString()}</strong></T>
                  <T className="text-text-tertiary">·</T>
                  <T>duration <strong>{durationStr(run.startedAt, run.finishedAt)}</strong></T>
                </>
              )}
            </Inline>
            <Inline gap="sm" align="center" className="text-[12px] text-text-secondary">
              <T>judge:</T> <T className="font-mono text-[11.5px]">{run.judgeModelId}</T>
              {run.gitSha && (
                <>
                  <T className="text-text-tertiary">·</T>
                  <T>git:</T> <T className="font-mono text-[11.5px]">{shortSha(run.gitSha)}</T>
                </>
              )}
              <T className="text-text-tertiary">·</T>
              <T>pass rate:</T>
              <Chip tone={passRateTone(run.passRate)} size="xs">
                {fmtPct(run.passRate)} ({run.passed}/{run.totalCases})
              </Chip>
            </Inline>
            {run.notes && (
              <T as="div" className="text-[12px] text-text-secondary italic">{run.notes}</T>
            )}
          </Stack>
          <Inline gap="sm" align="center" wrap>
            <BaselinePicker
              runs={allRuns}
              currentRunId={runId}
              onPick={(baselineId) => {
                if (!baselineId) return;
                navigate(
                  `/admin/observability/harness/compare/${encodeURIComponent(baselineId)}/${encodeURIComponent(runId)}`,
                );
              }}
            />
            {run.agentVersions && Object.keys(run.agentVersions).length > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setPromoteOpen(true)}
                title="Promote one or more of this run's prompt versions"
              >
                Promote prompt versions
              </Button>
            )}
            <Link
              to="/admin/observability/harness"
              className="text-[12px] text-primary no-underline px-2 py-0.5 rounded hover:underline"
            >
              ← Back to harness
            </Link>
          </Inline>
        </Inline>
      </Card>

      {promoteOpen && run.agentVersions && (
        <PromoteModal
          agentVersions={run.agentVersions}
          onClose={() => setPromoteOpen(false)}
        />
      )}

      {/* Regressions */}
      {hasRegressions && (
        <Card padding="md">
          <CardHeader
            title="Regressions vs. previous run"
            subtitle={`${regressions.length} test${regressions.length === 1 ? '' : 's'} scored lower · sorted by |Δ|`}
          />
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Test</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Prev</TableTh>
                <TableTh>This</TableTh>
                <TableTh>Δ</TableTh>
                <TableTh>Response</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {regressions.map((r) => (
                <TableRow key={r.testId}>
                  <TableTd className="text-[11px] text-text-tertiary font-mono whitespace-nowrap">{r.testId}</TableTd>
                  <TableTd className="text-[12px] font-medium whitespace-nowrap">{r.agentId ?? '—'}</TableTd>
                  <TableTd>
                    <Chip tone={judgeTone(r.prev)} size="xs">
                      {fmt(r.prev)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={judgeTone(r.curr)} size="xs">
                      {fmt(r.curr)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone="danger" size="xs">
                      ↓ {fmt(Math.abs(r.delta))}
                    </Chip>
                  </TableTd>
                  <TableTd
                    className="text-[12px] max-w-[320px] truncate"
                    title={r.responseSnippet ?? undefined}
                  >
                    {snip(r.responseSnippet)}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Full matrix */}
      <Card padding="md">
        <Inline justify="between" align="center" className="mb-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMatrixOpen(!matrixIsOpen)}
            aria-expanded={matrixIsOpen}
          >
            {matrixIsOpen ? '▾' : '▸'} Full matrix
          </Button>
          <T className="text-[11px] text-text-tertiary">
            {sortedResults.length} result{sortedResults.length === 1 ? '' : 's'} · sorted by
            ascending score · click a row to expand
          </T>
        </Inline>

        {matrixIsOpen && (
          sortedResults.length === 0 ? (
            <RowEmpty text="No results yet for this run." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Test</TableTh>
                  <TableTh>Agent</TableTh>
                  <TableTh>Pass</TableTh>
                  <TableTh>Score</TableTh>
                  <TableTh>Schema</TableTh>
                  <TableTh>Tags</TableTh>
                  <TableTh>Duration</TableTh>
                  <TableTh>Cost</TableTh>
                  <TableTh>Response</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedResults.map((r) => {
                  const isOpen = expanded === r.testId;
                  return (
                    <Fragment key={r.testId}>
                      <TableRow
                        key={r.testId}
                        onClick={() => setExpanded(isOpen ? null : r.testId)}
                        className="cursor-pointer"
                      >
                        <TableTd className="text-[11px] text-text-tertiary font-mono whitespace-nowrap">
                          {r.testId}
                          {r.invocationId && (
                            <Link
                              to={`/admin/observability/invocations/${r.invocationId}`}
                              onClick={(e) => e.stopPropagation()}
                              title="Open invocation detail"
                              className="ml-1.5 text-primary no-underline text-[11px]"
                            >
                              →
                            </Link>
                          )}
                        </TableTd>
                        <TableTd className="text-[12px] font-medium whitespace-nowrap">{r.agentId ?? '—'}</TableTd>
                        <TableTd>
                          <PassChip passed={r.passed} labeled />
                        </TableTd>
                        <TableTd>
                          <Chip tone={judgeTone(r.judgeScore)} size="xs">
                            {fmt(r.judgeScore)}
                          </Chip>
                        </TableTd>
                        <TableTd>
                          <SchemaChip valid={r.schemaValid} />
                        </TableTd>
                        <TableTd>
                          <Chip tone={tagTone(r.tagHits)} size="xs">
                            {tagSummary(r.tagHits)}
                          </Chip>
                        </TableTd>
                        <TableTd className="text-[12px] text-text-secondary whitespace-nowrap">
                          {r.durationMs != null ? `${r.durationMs}ms` : '—'}
                        </TableTd>
                        <TableTd className="whitespace-nowrap">
                          <CostChip cost={r.estCostUsd} />
                        </TableTd>
                        <TableTd
                          className="text-[12px] max-w-[320px] truncate"
                          title={r.responseSnippet ?? undefined}
                        >
                          {snip(r.responseSnippet, 60)}
                        </TableTd>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${r.testId}-detail`}>
                          <TableTd colSpan={9} className="p-3 bg-bg">
                            <ResultDetail result={r} />
                          </TableTd>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )
        )}
      </Card>

      {/* Cases without results */}
      {missingCount > 0 && (
        <Card padding="md">
          <CardHeader
            title="Cases without results"
            subtitle={`${missingCount} test${missingCount === 1 ? '' : 's'} did not produce a result · runner may have crashed`}
          />
          <Card padding="sm" className="text-[12px] text-text-secondary">
            Total cases: <strong>{run.totalCases}</strong>, completed:{' '}
            <strong>{run.completed}</strong>, missing: <strong>{missingCount}</strong>.
            Inspect the runner logs (<T className="font-mono text-[11.5px]">infra/scripts/harness.py</T>) for
            crashes.
          </Card>
        </Card>
      )}
    </PageSection>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function ResultDetail({ result }: { result: TestResult }) {
  const tagEntries = result.tagHits ? Object.entries(result.tagHits) : [];
  return (
    <Stack gap="md">
      {result.prompt && (
        <Stack gap="xs">
          <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">PROMPT</T>
          <CodeBlock code={result.prompt} language="text" />
        </Stack>
      )}
      <Stack gap="xs">
        <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">RESPONSE</T>
        <CodeBlock code={result.responseSnippet ?? '(no response captured)'} language="text" />
      </Stack>
      <Inline gap="md" align="start">
        <Stack gap="xs" className="flex-1 min-w-0">
          <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">JUDGE RATIONALE</T>
          {result.judgeRationale ? (
            <CodeBlock code={result.judgeRationale} language="text" />
          ) : (
            <T className="text-[11px] text-text-tertiary italic">(no rationale)</T>
          )}
        </Stack>
        <Stack gap="xs" className="flex-1 min-w-0">
          <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">FAIL REASONS</T>
          {result.failReasons && result.failReasons.length > 0 ? (
            <Stack as="ul" gap="xs" className="m-0 pl-4 text-[12px] text-danger list-disc">
              {result.failReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </Stack>
          ) : (
            <T className="text-[11px] text-text-tertiary italic">(none)</T>
          )}
        </Stack>
      </Inline>
      {tagEntries.length > 0 && (
        <Stack gap="xs">
          <T as="div" className="text-[10px] font-bold text-text-tertiary tracking-wide">TAG BREAKDOWN</T>
          <Inline gap="xs">
            {tagEntries.map(([tag, hit]) => (
              <Chip key={tag} tone={hit ? 'success' : 'danger'} size="xs">
                {hit ? '✓' : '✗'} {tag}
              </Chip>
            ))}
          </Inline>
        </Stack>
      )}
      <Inline gap="sm" align="center" className="text-[11px] text-text-tertiary">
        <T>reference similarity: <strong>{fmt(result.referenceSimilarity)}</strong></T>
        {(result.inputTokens != null || result.outputTokens != null) && (
          <>
            <T>·</T>
            <T>
              tokens:{' '}
              <strong>
                input: {result.inputTokens ?? '—'} · output: {result.outputTokens ?? '—'}
              </strong>
            </T>
          </>
        )}
        {result.estCostUsd != null && (
          <>
            <T>·</T>
            <T>cost:</T> <CostChip cost={result.estCostUsd} />
          </>
        )}
        {result.invocationId && (
          <>
            <T>·</T>
            <T>invocation:</T>
            <Link
              to={`/admin/observability/invocations/${result.invocationId}`}
              className="font-mono text-[11.5px] text-primary"
              title="Open invocation detail"
            >
              {result.invocationId} →
            </Link>
          </>
        )}
        <T>·</T>
        <T>ts: {new Date(result.ts).toLocaleString()}</T>
      </Inline>
    </Stack>
  );
}

// Sprint 3 (M8) — pick a baseline run to compare against this run. Up to 10
// recent runs other than the current one are shown.
function BaselinePicker({
  runs,
  currentRunId,
  onPick,
}: {
  runs: TestRun[];
  currentRunId: string;
  onPick: (runId: string) => void;
}) {
  const candidates = useMemo(
    () => runs.filter((r) => r.runId !== currentRunId).slice(0, 10),
    [runs, currentRunId],
  );
  if (candidates.length === 0) return null;
  return (
    <Inline
      as="label"
      gap="xs"
      align="center"
      className="text-[11px]"
      title="Pick another run to side-by-side compare against this one"
    >
      <T className="text-text-tertiary">Compare to baseline:</T>
      <Select
        size="sm"
        value=""
        placeholder="pick a run…"
        onChange={(e) => onPick(e.target.value)}
        options={candidates.map((c) => {
          const short = c.runId.length > 8 ? c.runId.slice(0, 8) : c.runId;
          return { value: c.runId, label: `${short} · ${c.label}` };
        })}
      />
    </Inline>
  );
}

// Sprint 3 (M8) — list each agentId → promptVersion in agentVersions and let
// the user promote any of them. Tracks per-agent state so the UI can show a
// success chip immediately on click without a refetch.
function PromoteModal({
  agentVersions,
  onClose,
}: {
  agentVersions: Record<string, string>;
  onClose: () => void;
}) {
  type RowState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; promotedAt: string }
    | { kind: 'error'; message: string };
  const [state, setState] = useState<Record<string, RowState>>({});

  async function promote(agentId: string, promptVersion: string) {
    setState((s) => ({ ...s, [agentId]: { kind: 'pending' } }));
    try {
      const res = await fetch('/api/observability/harness/promote', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ agentId, promptVersion }),
      });
      if (!res.ok) {
        const txt = await res.text();
        setState((s) => ({
          ...s,
          [agentId]: { kind: 'error', message: `${res.status} ${txt.slice(0, 100)}` },
        }));
        return;
      }
      const j = (await res.json()) as { promotedAt?: string };
      setState((s) => ({
        ...s,
        [agentId]: { kind: 'done', promotedAt: j.promotedAt ?? new Date().toISOString() },
      }));
    } catch (e: unknown) {
      setState((s) => ({
        ...s,
        [agentId]: { kind: 'error', message: e instanceof Error ? e.message : 'request failed' },
      }));
    }
  }

  const entries = Object.entries(agentVersions).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Modal open onClose={onClose} title="Promote prompt versions" maxWidth={520} rawChildren>
      <Stack gap="md" className="p-4 overflow-y-auto text-[12px]">
        <Stack as="p" gap="none" className="mb-2 text-text-secondary">
          Mark these prompt versions as production-blessed. Promote per-agent so a
          partial decision (some agents OK, others still under review) stays clean.
        </Stack>
        {entries.length === 0 ? (
          <T as="div" className="text-text-tertiary">
            This run did not record any prompt versions.
          </T>
        ) : (
          entries.map(([agentId, pv]) => {
            const short = pv.length > 8 ? pv.slice(0, 8) : pv;
            const rs = state[agentId] ?? { kind: 'idle' as const };
            return (
              <Inline key={agentId} justify="between" align="center" gap="md" className="py-2 border-b border-border">
                <Stack gap="none">
                  <T className="text-[12px] font-medium">{agentId}</T>
                  <T className="font-mono text-[11.5px] text-text-tertiary">
                    p:{short}
                  </T>
                </Stack>
                <Inline gap="sm" align="center">
                  {rs.kind === 'idle' && (
                    <Button variant="secondary" size="sm" onClick={() => promote(agentId, pv)}>
                      Promote {agentId}
                    </Button>
                  )}
                  {rs.kind === 'pending' && (
                    <Chip tone="warning" size="xs">promoting…</Chip>
                  )}
                  {rs.kind === 'done' && (
                    <Chip tone="success" size="xs">
                      ✓ promoted {new Date(rs.promotedAt).toLocaleTimeString()}
                    </Chip>
                  )}
                  {rs.kind === 'error' && (
                    <Chip tone="danger" size="xs">{rs.message}</Chip>
                  )}
                </Inline>
              </Inline>
            );
          })
        )}
      </Stack>
    </Modal>
  );
}

export default RunDetailPage;
