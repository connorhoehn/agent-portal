// Sprint 3 (M8) — Run-vs-run comparison.
//
// Route: /observability/harness/compare/:runIdA/:runIdB
// Endpoint: GET /api/observability/harness/runs/:runIdA/compare/:runIdB →
//   { runA, runB, regressions[], fixes[], neutral[], summary }
//
// Layout:
//   1. Header — labels, two ModeChips, pass-rate Δ chip, cost Δ chip, duration Δ chip
//   2. Prompt version delta — per-agent fromVersion → toVersion, each opens a
//      side-by-side diff modal
//   3. Regressions section (red header, shown first if any exist)
//   4. Fixes section (green header)
//   5. Neutral section (collapsed by default)

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
  PageSection,
  Modal,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { CostChip } from '../../../components/observability/CostChip';
import { ModeChip } from '../../../components/observability/ModeChip';

// ── types ─────────────────────────────────────────────────────────────────────

type Mode = 'live' | 'sim';

interface TestRunLite {
  runId: string;
  label: string;
  judgeModelId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  passRate: number | null;
  passed: number;
  failed: number;
  totalCases: number;
  mode: Mode;
  agentVersions: Record<string, string>;
}

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
  responseA?: string;
  responseB?: string;
}

interface PromptVersionDeltaEntry {
  agentId: string;
  fromVersion: string;
  toVersion: string;
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
  promptVersionDelta: PromptVersionDeltaEntry[];
}

interface CompareResp {
  runA: TestRunLite;
  runB: TestRunLite;
  regressions: ComparedResult[];
  fixes: ComparedResult[];
  neutral: ComparedResult[];
  summary: CompareSummary;
}

interface PromptVersionDetail {
  promptVersion: string;
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;
  notes: string | null;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

// ── helpers ───────────────────────────────────────────────────────────────────

const judgeTone = (v: number | null): Tone =>
  v == null ? 'warning' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmt = (v: number | null, digits = 2): string =>
  v != null && Number.isFinite(v) ? v.toFixed(digits) : '—';

const fmtPct = (v: number | null, digits = 1): string =>
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

const passRateDeltaTone = (v: number): Tone => {
  if (v > 0.01) return 'success';
  if (v < -0.01) return 'danger';
  return 'neutral';
};

const costDeltaTone = (v: number | null): Tone => {
  if (v == null) return 'neutral';
  if (v > 0.001) return 'danger';   // more $ spent — bad
  if (v < -0.001) return 'success'; // less $ spent — good
  return 'neutral';
};

const durationDeltaTone = (v: number): Tone => {
  if (v > 100) return 'danger';   // slower
  if (v < -100) return 'success'; // faster
  return 'neutral';
};

function snip(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function shortRunId(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

function shortPv(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// ── component ─────────────────────────────────────────────────────────────────

function CompareRunsPage() {
  const params = useParams<{ runIdA: string; runIdB: string }>();
  const runIdA = params.runIdA ?? '';
  const runIdB = params.runIdB ?? '';

  const compareUrl = (runIdA && runIdB)
    ? `/api/observability/harness/runs/${encodeURIComponent(runIdA)}/compare/${encodeURIComponent(runIdB)}`
    : '';

  const { data, isLoading, error } = useFetch<CompareResp>(compareUrl);

  // Diff modal for prompt-version side-by-side view
  const [diffEntry, setDiffEntry] = useState<PromptVersionDeltaEntry | null>(null);

  // Row expansion for response side-by-side
  const [expanded, setExpanded] = useState<string | null>(null);

  const [neutralOpen, setNeutralOpen] = useState(false);

  if (!runIdA || !runIdB) {
    return <ErrorBlock title="Missing run ids" detail="Both runIdA and runIdB are required in the URL." />;
  }

  if (error) {
    return (
      <ErrorBlock
        title="Could not load comparison"
        detail={error}
        runIdA={runIdA}
        runIdB={runIdB}
      />
    );
  }

  if (!data && isLoading) {
    return (
      <PageSection title="Compare Runs">
        <Card padding="md">
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>
            Loading comparison…
          </div>
        </Card>
      </PageSection>
    );
  }

  if (!data) {
    return (
      <ErrorBlock
        title="Comparison not available"
        detail="The backend returned no comparison payload — one of the two runs may not exist."
        runIdA={runIdA}
        runIdB={runIdB}
      />
    );
  }

  const { runA, runB, regressions, fixes, neutral, summary } = data;

  return (
    <PageSection title="Compare Runs">
      {/* Header */}
      <Card padding="md">
        <div style={headerRow}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={h2title}>
                Comparing <span style={monoInline}>{shortRunId(runA.runId)}</span> →{' '}
                <span style={monoInline}>{shortRunId(runB.runId)}</span>
              </h2>
            </div>
            <div style={subline}>
              <span style={runLabelChip} title={`run A: ${runA.runId}`}>
                A: <strong>{runA.label}</strong>
              </span>
              <ModeChip mode={summary.modeA} />
              <span style={dot}>→</span>
              <span style={runLabelChip} title={`run B: ${runB.runId}`}>
                B: <strong>{runB.label}</strong>
              </span>
              <ModeChip mode={summary.modeB} />
            </div>
            <div style={subline}>
              pass rate:&nbsp;
              <Chip tone="neutral" size="xs">{fmtPct(summary.passRateA)}</Chip>
              <span style={dot}>→</span>
              <Chip tone="neutral" size="xs">{fmtPct(summary.passRateB)}</Chip>
              <span style={dot}>·</span>
              <Chip tone={passRateDeltaTone(summary.passRateDelta)} size="xs">
                {summary.passRateDelta >= 0 ? '▲' : '▼'} {fmtSignedPct(summary.passRateDelta)}
              </Chip>
              <span style={dot}>·</span>
              cost Δ:&nbsp;
              <Chip tone={costDeltaTone(summary.costDeltaUsd)} size="xs">
                {fmtSignedCost(summary.costDeltaUsd)}
              </Chip>
              <span style={dot}>·</span>
              duration Δ:&nbsp;
              <Chip tone={durationDeltaTone(summary.durationDeltaMs)} size="xs">
                {fmtSignedDuration(summary.durationDeltaMs)}
              </Chip>
            </div>
            <div style={subline}>
              judge A: <span style={monoInline}>{summary.judgeModelA}</span>
              {summary.judgeModelA !== summary.judgeModelB && (
                <>
                  <span style={dot}>·</span>
                  judge B: <span style={monoInline}>{summary.judgeModelB}</span>
                  <Chip tone="warning" size="xs">judges differ</Chip>
                </>
              )}
              <span style={dot}>·</span>
              tests A: <strong>{runA.passed}/{runA.totalCases}</strong>
              <span style={dot}>·</span>
              tests B: <strong>{runB.passed}/{runB.totalCases}</strong>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to={`/admin/observability/harness/runs/${encodeURIComponent(runIdA)}`} style={btnLink}>
              ← Run A
            </Link>
            <Link to={`/admin/observability/harness/runs/${encodeURIComponent(runIdB)}`} style={btnLink}>
              Run B →
            </Link>
          </div>
        </div>
      </Card>

      {/* Prompt version delta */}
      {summary.promptVersionDelta.length > 0 && (
        <Card padding="md">
          <div style={headerRow}>
            <h2 style={h2}>
              Prompt version changes{' '}
              <span style={hint}>
                {summary.promptVersionDelta.length} agent
                {summary.promptVersionDelta.length === 1 ? '' : 's'} updated · click a version to
                diff
              </span>
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {summary.promptVersionDelta.map((d) => (
              <div key={d.agentId} style={pvRow}>
                <span style={agentCell}>{d.agentId}</span>
                <span style={{ ...monoInline, color: 'var(--color-text-tertiary)' }}>
                  p:{shortPv(d.fromVersion)}
                </span>
                <span style={dot}>→</span>
                <button
                  type="button"
                  onClick={() => setDiffEntry(d)}
                  style={pvBtn}
                  title="Diff the two prompt versions"
                >
                  <Chip tone="neutral" size="xs">
                    <span style={monoInline}>p:{shortPv(d.toVersion)}</span>
                  </Chip>
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Regressions */}
      <ResultsSection
        title="Regressions"
        tone="danger"
        hint={`${regressions.length} test${regressions.length === 1 ? '' : 's'} scored lower · sorted by |Δ| desc`}
        results={regressions}
        runIdA={runIdA}
        runIdB={runIdB}
        expanded={expanded}
        onToggleExpand={(testId) => setExpanded((cur) => (cur === testId ? null : testId))}
        defaultOpen
        emptyText="No regressions — every common test held its score within ±0.05."
      />

      {/* Fixes */}
      <ResultsSection
        title="Fixes"
        tone="success"
        hint={`${fixes.length} test${fixes.length === 1 ? '' : 's'} improved · sorted by |Δ| desc`}
        results={fixes}
        runIdA={runIdA}
        runIdB={runIdB}
        expanded={expanded}
        onToggleExpand={(testId) => setExpanded((cur) => (cur === testId ? null : testId))}
        defaultOpen
        emptyText="No fixes — no common test improved by more than 0.05."
      />

      {/* Neutral */}
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            <button
              onClick={() => setNeutralOpen(!neutralOpen)}
              style={collapseBtn}
              aria-expanded={neutralOpen}
            >
              {neutralOpen ? '▾' : '▸'} Neutral
            </button>{' '}
            <span style={hint}>
              {neutral.length} test{neutral.length === 1 ? '' : 's'} within ±0.05
            </span>
          </h2>
        </div>
        {neutralOpen && (
          neutral.length === 0 ? (
            <EmptyState text="No neutral results." />
          ) : (
            <ResultsTable
              results={neutral}
              runIdA={runIdA}
              runIdB={runIdB}
              expanded={expanded}
              onToggleExpand={(testId) =>
                setExpanded((cur) => (cur === testId ? null : testId))
              }
              tone="neutral"
            />
          )
        )}
      </Card>

      {/* Prompt-version diff modal */}
      {diffEntry && (
        <PromptDiffModal entry={diffEntry} onClose={() => setDiffEntry(null)} />
      )}
    </PageSection>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

interface ResultsSectionProps {
  title: string;
  tone: Tone;
  hint: string;
  results: ComparedResult[];
  runIdA: string;
  runIdB: string;
  expanded: string | null;
  onToggleExpand: (testId: string) => void;
  defaultOpen: boolean;
  emptyText: string;
}

function ResultsSection({
  title, tone, hint, results, runIdA, runIdB, expanded, onToggleExpand, emptyText,
}: ResultsSectionProps) {
  const cardTint: CSSProperties = tone === 'danger'
    ? { borderTop: '2px solid var(--color-danger, #ef4444)' }
    : tone === 'success'
      ? { borderTop: '2px solid var(--color-success, #22c55e)' }
      : {};
  return (
    <Card padding="md" style={cardTint}>
      <div style={headerRow}>
        <h2 style={h2}>
          {title}{' '}
          <span style={hintLine}>{hint}</span>
        </h2>
      </div>
      {results.length === 0 ? (
        <EmptyState text={emptyText} />
      ) : (
        <ResultsTable
          results={results}
          runIdA={runIdA}
          runIdB={runIdB}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          tone={tone}
        />
      )}
    </Card>
  );
}

interface ResultsTableProps {
  results: ComparedResult[];
  runIdA: string;
  runIdB: string;
  expanded: string | null;
  onToggleExpand: (testId: string) => void;
  tone: Tone;
}

function ResultsTable({
  results, runIdA, runIdB, expanded, onToggleExpand, tone,
}: ResultsTableProps) {
  // Tone of the Δ chip per row — for regressions force danger, for fixes force
  // success, for neutral use the score-delta sign. This matches the section
  // tone but stays defensive when a stray row leaks into the wrong bucket.
  function rowDeltaTone(deltaVal: number | null): Tone {
    if (deltaVal == null) return 'neutral';
    if (tone === 'danger') return 'danger';
    if (tone === 'success') return 'success';
    if (Math.abs(deltaVal) < 0.05) return 'neutral';
    return deltaVal > 0 ? 'success' : 'danger';
  }
  void runIdA; void runIdB;

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableTh>Test</TableTh>
          <TableTh>Agent</TableTh>
          <TableTh>A → B</TableTh>
          <TableTh>Δ</TableTh>
          <TableTh>Cost Δ</TableTh>
          <TableTh>Dur Δ</TableTh>
          <TableTh>Pass</TableTh>
          <TableTh></TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {results.map((r) => {
          const isOpen = expanded === r.testId;
          const arrow = r.scoreDelta == null
            ? '—'
            : (r.scoreDelta < 0 ? '↓' : (r.scoreDelta > 0 ? '↑' : '·'));
          const dTone = rowDeltaTone(r.scoreDelta);
          return (
            <>
              <TableRow
                key={r.testId}
                onClick={() => onToggleExpand(r.testId)}
                style={{ cursor: 'pointer' }}
              >
                <TableTd style={monoCell}>{r.testId}</TableTd>
                <TableTd style={agentCell}>{r.agentId || '—'}</TableTd>
                <TableTd style={{ whiteSpace: 'nowrap' }}>
                  <Chip tone={judgeTone(r.scoreA)} size="xs">{fmt(r.scoreA)}</Chip>
                  <span style={{ ...dot, margin: '0 4px' }}>→</span>
                  <Chip tone={judgeTone(r.scoreB)} size="xs">{fmt(r.scoreB)}</Chip>
                </TableTd>
                <TableTd>
                  <Chip tone={dTone} size="xs">
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
                <TableTd style={{ whiteSpace: 'nowrap' }}>
                  <PassChip passed={r.passedA} />
                  <span style={{ ...dot, margin: '0 4px' }}>→</span>
                  <PassChip passed={r.passedB} />
                </TableTd>
                <TableTd style={{ whiteSpace: 'nowrap' }}>
                  <Link
                    to={`/admin/observability/harness/runs/${encodeURIComponent(runIdA)}`}
                    onClick={(e) => e.stopPropagation()}
                    style={smallLink}
                    title="Open run A"
                  >
                    view A
                  </Link>
                  <span style={{ ...dot, margin: '0 4px' }}>·</span>
                  <Link
                    to={`/admin/observability/harness/runs/${encodeURIComponent(runIdB)}`}
                    onClick={(e) => e.stopPropagation()}
                    style={smallLink}
                    title="Open run B"
                  >
                    view B
                  </Link>
                </TableTd>
              </TableRow>
              {isOpen && (
                <TableRow key={`${r.testId}-detail`}>
                  <TableTd colSpan={8} style={detailRowCell}>
                    <ResponseDiff result={r} />
                  </TableTd>
                </TableRow>
              )}
            </>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ResponseDiff({ result }: { result: ComparedResult }) {
  return (
    <div style={diffGrid}>
      <div>
        <div style={detailLabel}>RESPONSE A</div>
        <pre style={detailPre}>{result.responseA ?? '(no response captured)'}</pre>
      </div>
      <div>
        <div style={detailLabel}>RESPONSE B</div>
        <pre style={detailPre}>{result.responseB ?? '(no response captured)'}</pre>
      </div>
    </div>
  );
}

function PassChip({ passed }: { passed: boolean | null }) {
  if (passed === null) return <Chip tone="warning" size="xs">—</Chip>;
  return passed ? (
    <Chip tone="success" size="xs">✓</Chip>
  ) : (
    <Chip tone="danger" size="xs">✗</Chip>
  );
}

function PromptDiffModal({
  entry,
  onClose,
}: {
  entry: PromptVersionDeltaEntry;
  onClose: () => void;
}) {
  const [fromDetail, setFromDetail] = useState<PromptVersionDetail | null>(null);
  const [toDetail, setToDetail] = useState<PromptVersionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);

    function fetchOne(pv: string): Promise<PromptVersionDetail | null> {
      return fetch(`/api/observability/prompt-versions/${encodeURIComponent(pv)}`, {
        credentials: 'include',
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
        .then((j: { version?: PromptVersionDetail }) => j?.version ?? null);
    }

    Promise.all([fetchOne(entry.fromVersion), fetchOne(entry.toVersion)])
      .then(([a, b]) => {
        if (cancelled) return;
        setFromDetail(a);
        setToDetail(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Fetch failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.fromVersion, entry.toVersion]);

  const title = `${entry.agentId}: p:${shortPv(entry.fromVersion)} → p:${shortPv(entry.toVersion)}`;

  return (
    <Modal open onClose={onClose} title={title} maxWidth={1200} rawChildren>
      {loading && <div style={modalBody}>Loading…</div>}

      {err && (
        <div style={{ ...modalBody, color: 'var(--color-danger, #ef4444)' }}>
          Could not load prompt versions: {err}
        </div>
      )}

      {!loading && !err && (
        <div style={modalBody}>
          <div style={modalDiffGrid}>
            <div>
              <div style={detailLabel}>
                FROM — <span style={monoInline}>p:{shortPv(entry.fromVersion)}</span>
              </div>
              <pre style={modalPre}>{fromDetail?.content ?? '(not registered)'}</pre>
            </div>
            <div>
              <div style={detailLabel}>
                TO — <span style={monoInline}>p:{shortPv(entry.toVersion)}</span>
              </div>
              <pre style={modalPre}>{toDetail?.content ?? '(not registered)'}</pre>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ErrorBlock({
  title,
  detail,
  runIdA,
  runIdB,
}: {
  title: string;
  detail: string;
  runIdA?: string;
  runIdB?: string;
}) {
  return (
    <PageSection
      title={title}
      actions={
        <Link to="/admin/observability/harness" style={btnLink}>
          ← Back to harness
        </Link>
      }
    >
      <Card padding="md">
        {(runIdA || runIdB) && (
          <div style={subline}>
            runIdA: <span style={monoInline}>{runIdA ?? '—'}</span>
            <span style={dot}>·</span>
            runIdB: <span style={monoInline}>{runIdB ?? '—'}</span>
          </div>
        )}
        <div style={{ ...subline, color: 'var(--color-text-secondary)' }}>{detail}</div>
      </Card>
    </PageSection>
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
const hintLine: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
  marginLeft: 6,
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
const smallLink: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
};
const runLabelChip: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};
const pvRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  padding: '6px 0',
  borderBottom: '1px solid var(--color-border)',
};
const pvBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
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
  maxHeight: 320,
  overflowY: 'auto',
};
const modalBody: CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  fontSize: 12,
};
const modalDiffGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const modalPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 4,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  maxHeight: '65vh',
  overflowY: 'auto',
  color: 'var(--color-text-primary)',
};

export default CompareRunsPage;
