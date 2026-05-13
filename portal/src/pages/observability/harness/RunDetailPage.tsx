// Single run detail. Shows header + regressions (if any) + full matrix.
// Endpoints:
//   GET /api/observability/harness/runs/:id            → {run, results}
//   GET /api/observability/harness/runs?limit=14       → used to find prev run
//   GET /api/observability/harness/runs/:prevId        → previous results for delta

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
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
import { useFetch } from '../../../hooks/useFetch';

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
  const runId = params.runId ?? '';

  // Poll active runs every 5s; once terminal it's basically static so longer is fine.
  const { data: detailData, isLoading, error } = useFetch<RunDetailResp>(
    runId ? `/api/observability/harness/runs/${encodeURIComponent(runId)}` : '',
    5_000,
  );
  const run = detailData?.run ?? null;
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
        runId={runId}
      />
    );
  }
  if (!run && isLoading) {
    return (
      <div style={pageStyle}>
        <Card padding="md">
          <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontSize: 12 }}>
            Loading run…
          </div>
        </Card>
      </div>
    );
  }
  if (!run) {
    return (
      <ErrorBlock
        title="Run not found"
        detail={`No run with id "${runId}" yet — the backend may be initialising.`}
        runId={runId}
      />
    );
  }

  return (
    <div style={pageStyle}>
      {/* Header */}
      <Card padding="md">
        <div style={headerRow}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={h2title}>{run.label}</h2>
              <Chip tone={statusTone(run.status)} size="xs">
                {run.status}
              </Chip>
            </div>
            <div style={subline}>
              started <strong>{new Date(run.startedAt).toLocaleString()}</strong>
              {run.finishedAt && (
                <>
                  <span style={dot}>·</span>
                  finished <strong>{new Date(run.finishedAt).toLocaleString()}</strong>
                  <span style={dot}>·</span>
                  duration <strong>{durationStr(run.startedAt, run.finishedAt)}</strong>
                </>
              )}
            </div>
            <div style={subline}>
              judge: <span style={monoInline}>{run.judgeModelId}</span>
              {run.gitSha && (
                <>
                  <span style={dot}>·</span>
                  git: <span style={monoInline}>{shortSha(run.gitSha)}</span>
                </>
              )}
              <span style={dot}>·</span>
              pass rate:{' '}
              <Chip tone={passRateTone(run.passRate)} size="xs">
                {fmtPct(run.passRate)} ({run.passed}/{run.totalCases})
              </Chip>
            </div>
            {run.notes && <div style={notesLine}>{run.notes}</div>}
          </div>
          <div>
            <Link to="/observability/harness" style={btnLink}>
              ← Back to harness
            </Link>
          </div>
        </div>
      </Card>

      {/* Regressions */}
      {hasRegressions && (
        <Card padding="md">
          <div style={headerRow}>
            <h2 style={h2}>
              Regressions vs. previous run{' '}
              <span style={hint}>
                {regressions.length} test{regressions.length === 1 ? '' : 's'} scored lower · sorted
                by |Δ|
              </span>
            </h2>
          </div>
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
                  <TableTd style={monoCell}>{r.testId}</TableTd>
                  <TableTd style={agentCell}>{r.agentId ?? '—'}</TableTd>
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
                  <TableTd style={snippetCell} title={r.responseSnippet ?? undefined}>
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
        <div style={headerRow}>
          <h2 style={h2}>
            <button
              onClick={() => setMatrixOpen(!matrixIsOpen)}
              style={collapseBtn}
              aria-expanded={matrixIsOpen}
            >
              {matrixIsOpen ? '▾' : '▸'} Full matrix
            </button>{' '}
            <span style={hint}>
              {sortedResults.length} result{sortedResults.length === 1 ? '' : 's'} · sorted by
              ascending score · click a row to expand
            </span>
          </h2>
        </div>

        {matrixIsOpen && (
          sortedResults.length === 0 ? (
            <EmptyState text="No results yet for this run." />
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
                  <TableTh>Response</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedResults.map((r) => {
                  const isOpen = expanded === r.testId;
                  return (
                    <>
                      <TableRow
                        key={r.testId}
                        onClick={() => setExpanded(isOpen ? null : r.testId)}
                        style={{ cursor: 'pointer' }}
                      >
                        <TableTd style={monoCell}>{r.testId}</TableTd>
                        <TableTd style={agentCell}>{r.agentId ?? '—'}</TableTd>
                        <TableTd>
                          <PassChip passed={r.passed} />
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
                        <TableTd style={numCell}>
                          {r.durationMs != null ? `${r.durationMs}ms` : '—'}
                        </TableTd>
                        <TableTd
                          style={snippetCell}
                          title={r.responseSnippet ?? undefined}
                        >
                          {snip(r.responseSnippet, 60)}
                        </TableTd>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${r.testId}-detail`}>
                          <TableTd colSpan={8} style={detailRowCell}>
                            <ResultDetail result={r} />
                          </TableTd>
                        </TableRow>
                      )}
                    </>
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
          <div style={headerRow}>
            <h2 style={h2}>
              Cases without results{' '}
              <span style={hint}>
                {missingCount} test{missingCount === 1 ? '' : 's'} did not produce a result · runner
                may have crashed
              </span>
            </h2>
          </div>
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-surface-hover)',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
            }}
          >
            Total cases: <strong>{run.totalCases}</strong>, completed:{' '}
            <strong>{run.completed}</strong>, missing: <strong>{missingCount}</strong>.
            Inspect the runner logs (<code style={monoInline}>infra/scripts/harness.py</code>) for
            crashes.
          </div>
        </Card>
      )}
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function PassChip({ passed }: { passed: boolean | null }) {
  if (passed === null) return <Chip tone="warning" size="xs">—</Chip>;
  return passed ? (
    <Chip tone="success" size="xs">✓ pass</Chip>
  ) : (
    <Chip tone="danger" size="xs">✗ fail</Chip>
  );
}

function SchemaChip({ valid }: { valid: boolean | null }) {
  if (valid === null) return <Chip tone="warning" size="xs">—</Chip>;
  return valid ? (
    <Chip tone="success" size="xs">✓</Chip>
  ) : (
    <Chip tone="danger" size="xs">✗</Chip>
  );
}

function ResultDetail({ result }: { result: TestResult }) {
  const tagEntries = result.tagHits ? Object.entries(result.tagHits) : [];
  return (
    <div style={detailGrid}>
      {result.prompt && (
        <div style={detailFull}>
          <div style={detailLabel}>PROMPT</div>
          <pre style={detailPre}>{result.prompt}</pre>
        </div>
      )}
      <div style={detailFull}>
        <div style={detailLabel}>RESPONSE</div>
        <pre style={detailPre}>{result.responseSnippet ?? '(no response captured)'}</pre>
      </div>
      <div style={detailHalf}>
        <div style={detailLabel}>JUDGE RATIONALE</div>
        {result.judgeRationale ? (
          <pre style={detailPre}>{result.judgeRationale}</pre>
        ) : (
          <div style={detailEmpty}>(no rationale)</div>
        )}
      </div>
      <div style={detailHalf}>
        <div style={detailLabel}>FAIL REASONS</div>
        {result.failReasons && result.failReasons.length > 0 ? (
          <ul style={failList}>
            {result.failReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <div style={detailEmpty}>(none)</div>
        )}
      </div>
      {tagEntries.length > 0 && (
        <div style={detailFull}>
          <div style={detailLabel}>TAG BREAKDOWN</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tagEntries.map(([tag, hit]) => (
              <Chip key={tag} tone={hit ? 'success' : 'danger'} size="xs">
                {hit ? '✓' : '✗'} {tag}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <div style={detailFull}>
        <div style={detailHintLine}>
          reference similarity: <strong>{fmt(result.referenceSimilarity)}</strong>
          {result.invocationId && (
            <>
              <span style={dot}>·</span>
              invocation: <span style={monoInline}>{result.invocationId}</span>
            </>
          )}
          <span style={dot}>·</span>
          ts: {new Date(result.ts).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function ErrorBlock({
  title,
  detail,
  runId,
}: {
  title: string;
  detail: string;
  runId?: string;
}) {
  return (
    <div style={pageStyle}>
      <Card padding="md">
        <div style={headerRow}>
          <div>
            <h2 style={h2title}>{title}</h2>
            {runId && <div style={subline}>run id: <span style={monoInline}>{runId}</span></div>}
            <div style={{ ...subline, color: 'var(--color-text-secondary)' }}>{detail}</div>
          </div>
          <Link to="/observability/harness" style={btnLink}>
            ← Back to harness
          </Link>
        </div>
      </Card>
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
};
const dot: CSSProperties = { color: 'var(--color-text-tertiary)' };
const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};
const notesLine: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  fontStyle: 'italic',
};
const monoInline: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11.5,
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
const snippetCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const collapseBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
};
const btnLink: CSSProperties = {
  padding: '2px 8px',
  fontSize: 12,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
  border: '1px solid transparent',
  borderRadius: 4,
};
const detailRowCell: CSSProperties = {
  padding: 12,
  background: 'var(--color-bg)',
};
const detailGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const detailFull: CSSProperties = {
  gridColumn: '1 / span 2',
};
const detailHalf: CSSProperties = {};
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
  maxHeight: 240,
  overflowY: 'auto',
};
const detailEmpty: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
  padding: '6px 0',
};
const detailHintLine: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  alignItems: 'center',
};
const failList: CSSProperties = {
  margin: 0,
  padding: '0 0 0 16px',
  fontSize: 12,
  color: 'var(--color-danger, #ef4444)',
};

export default RunDetailPage;
