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
import { Link, useParams } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  CodeBlock,
  Inline,
  LoadingState,
  Modal,
  PageSection,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTh,
  TableTd, T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { CostChip } from '../../../components/observability/CostChip';
import { ModeChip } from '../../../components/observability/ModeChip';
import { RowEmpty } from '../ReadState';
import { PassChip, ErrorBlock, RunIdPairLine } from './harnessShared';

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
  // null (not 0) when a side has zero completed / zero timed results — see
  // the backend comment on CompareRunsSummary (routes/harness.ts).
  passRateA: number | null;
  passRateB: number | null;
  passRateDelta: number | null;
  costAUsd: number | null;
  costBUsd: number | null;
  costDeltaUsd: number | null;
  avgDurationMsA: number | null;
  avgDurationMsB: number | null;
  durationDeltaMs: number | null;
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

const fmtSignedPct = (v: number | null, digits = 1): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(v) * 100).toFixed(digits)}%`;
};

const passRateDeltaTone = (v: number | null): Tone => {
  if (v == null) return 'neutral';
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

const durationDeltaTone = (v: number | null): Tone => {
  if (v == null) return 'neutral';
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
        context={<RunIdPairLine runIdA={runIdA} runIdB={runIdB} />}
      />
    );
  }

  if (!data && isLoading) {
    return (
      <PageSection title="Compare Runs">
        <Card padding="md">
          <LoadingState label="Loading comparison…" />
        </Card>
      </PageSection>
    );
  }

  if (!data) {
    return (
      <ErrorBlock
        title="Comparison not available"
        detail="The backend returned no comparison payload — one of the two runs may not exist."
        context={<RunIdPairLine runIdA={runIdA} runIdB={runIdB} />}
      />
    );
  }

  const { runA, runB, regressions, fixes, neutral, summary } = data;

  return (
    <PageSection title="Compare Runs">
      {/* Header */}
      <Card padding="md">
        <Inline justify="between" align="start" gap="md" className="mb-3">
          <Stack gap="xs">
            <T as="div" size="sm" weight="semibold">
              Comparing <T size="xs" className="font-mono">{shortRunId(runA.runId)}</T> →{' '}
              <T size="xs" className="font-mono">{shortRunId(runB.runId)}</T>
            </T>
            <Inline gap="sm" align="center" className="text-xs text-text-secondary">
              <T title={`run A: ${runA.runId}`}>A:&nbsp;<T size="sm" weight="semibold">{runA.label}</T></T>
              <ModeChip mode={summary.modeA} />
              <T className="text-text-tertiary">→</T>
              <T title={`run B: ${runB.runId}`}>B:&nbsp;<T size="sm" weight="semibold">{runB.label}</T></T>
              <ModeChip mode={summary.modeB} />
            </Inline>
            <Inline gap="sm" align="center" className="text-xs text-text-secondary">
              <T>pass rate:</T>
              <Chip tone="neutral" size="xs">{fmtPct(summary.passRateA)}</Chip>
              <T className="text-text-tertiary">→</T>
              <Chip tone="neutral" size="xs">{fmtPct(summary.passRateB)}</Chip>
              <T className="text-text-tertiary">·</T>
              <Chip tone={passRateDeltaTone(summary.passRateDelta)} size="xs">
                {summary.passRateDelta == null ? '—' : (summary.passRateDelta >= 0 ? '▲' : '▼')} {fmtSignedPct(summary.passRateDelta)}
              </Chip>
              <T className="text-text-tertiary">·</T>
              <T>cost Δ:</T>
              <Chip tone={costDeltaTone(summary.costDeltaUsd)} size="xs">
                {fmtSignedCost(summary.costDeltaUsd)}
              </Chip>
              <T className="text-text-tertiary">·</T>
              <T>duration Δ:</T>
              <Chip tone={durationDeltaTone(summary.durationDeltaMs)} size="xs">
                {fmtSignedDuration(summary.durationDeltaMs)}
              </Chip>
            </Inline>
            <Inline gap="sm" align="center" className="text-xs text-text-secondary">
              <T>judge A:</T> <T size="xs" className="font-mono">{summary.judgeModelA}</T>
              {summary.judgeModelA !== summary.judgeModelB && (
                <>
                  <T className="text-text-tertiary">·</T>
                  <T>judge B:</T> <T size="xs" className="font-mono">{summary.judgeModelB}</T>
                  <Chip tone="warning" size="xs">judges differ</Chip>
                </>
              )}
              <T className="text-text-tertiary">·</T>
              <T>tests A:&nbsp;<T size="sm" weight="semibold">{runA.passed}/{runA.totalCases}</T></T>
              <T className="text-text-tertiary">·</T>
              <T>tests B:&nbsp;<T size="sm" weight="semibold">{runB.passed}/{runB.totalCases}</T></T>
            </Inline>
          </Stack>
          <Inline gap="sm">
            <Link
              to={`/admin/observability/harness/runs/${encodeURIComponent(runIdA)}`}
              className="text-xs text-primary no-underline px-2 py-0.5 rounded hover:underline"
            >
              ← Run A
            </Link>
            <Link
              to={`/admin/observability/harness/runs/${encodeURIComponent(runIdB)}`}
              className="text-xs text-primary no-underline px-2 py-0.5 rounded hover:underline"
            >
              Run B →
            </Link>
          </Inline>
        </Inline>
      </Card>

      {/* Prompt version delta */}
      {summary.promptVersionDelta.length > 0 && (
        <Card padding="md">
          <CardHeader
            title="Prompt version changes"
            subtitle={`${summary.promptVersionDelta.length} agent${summary.promptVersionDelta.length === 1 ? '' : 's'} updated · click a version to diff`}
          />
          <Stack gap="xs">
            {summary.promptVersionDelta.map((d) => (
              <Inline key={d.agentId} gap="sm" wrap align="center" className="py-1.5 border-b border-border">
                <T size="xs" weight="medium" className="whitespace-nowrap">{d.agentId}</T>
                <T size="xs" className="font-mono text-text-tertiary">
                  p:{shortPv(d.fromVersion)}
                </T>
                <T className="text-text-tertiary">→</T>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDiffEntry(d)}
                  title="Diff the two prompt versions"
                >
                  <Chip tone="neutral" size="xs">
                    <T size="xs" className="font-mono">p:{shortPv(d.toVersion)}</T>
                  </Chip>
                </Button>
              </Inline>
            ))}
          </Stack>
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
        <Inline justify="between" align="center" className="mb-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNeutralOpen(!neutralOpen)}
            aria-expanded={neutralOpen}
          >
            {neutralOpen ? '▾' : '▸'} Neutral
          </Button>
          <T size="xs" className="text-text-tertiary">
            {neutral.length} test{neutral.length === 1 ? '' : 's'} within ±0.05
          </T>
        </Inline>
        {neutralOpen && (
          neutral.length === 0 ? (
            <RowEmpty text="No neutral results." />
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
  const toneClass = tone === 'danger'
    ? 'border-t-2 border-danger'
    : tone === 'success'
      ? 'border-t-2 border-success'
      : undefined;
  return (
    <Card padding="md" className={toneClass}>
      <CardHeader title={title} subtitle={hint} />
      {results.length === 0 ? (
        <RowEmpty text={emptyText} />
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
                className="cursor-pointer"
              >
                <TableTd className="text-text-tertiary whitespace-nowrap"><T className="font-mono">{r.testId}</T></TableTd>
                <TableTd className="whitespace-nowrap">{r.agentId || '—'}</TableTd>
                <TableTd className="whitespace-nowrap">
                  <Chip tone={judgeTone(r.scoreA)} size="xs">{fmt(r.scoreA)}</Chip>
                  <T className="text-text-tertiary mx-1">→</T>
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
                <TableTd className="text-text-secondary whitespace-nowrap">
                  {fmtSignedDuration(r.durationDeltaMs)}
                </TableTd>
                <TableTd className="whitespace-nowrap">
                  <PassChip passed={r.passedA} />
                  <T className="text-text-tertiary mx-1">→</T>
                  <PassChip passed={r.passedB} />
                </TableTd>
                <TableTd className="whitespace-nowrap">
                  <Link
                    to={`/admin/observability/harness/runs/${encodeURIComponent(runIdA)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-primary no-underline hover:underline"
                    title="Open run A"
                  >
                    view A
                  </Link>
                  <T className="text-text-tertiary mx-1">·</T>
                  <Link
                    to={`/admin/observability/harness/runs/${encodeURIComponent(runIdB)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-primary no-underline hover:underline"
                    title="Open run B"
                  >
                    view B
                  </Link>
                </TableTd>
              </TableRow>
              {isOpen && (
                <TableRow key={`${r.testId}-detail`}>
                  <TableTd colSpan={8} className="p-3 bg-bg">
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
    <Inline gap="md" align="start">
      <Stack gap="xs" className="flex-1 min-w-0">
        <T as="div" size="xs" weight="semibold" className="text-text-tertiary tracking-wide">RESPONSE A</T>
        <CodeBlock code={result.responseA ?? '(no response captured)'} language="text" />
      </Stack>
      <Stack gap="xs" className="flex-1 min-w-0">
        <T as="div" size="xs" weight="semibold" className="text-text-tertiary tracking-wide">RESPONSE B</T>
        <CodeBlock code={result.responseB ?? '(no response captured)'} language="text" />
      </Stack>
    </Inline>
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
      {loading && <LoadingState label="Loading…" />}

      {err && (
        <T as="div" size="xs" className="p-4 overflow-y-auto text-danger">
          Could not load prompt versions: {err}
        </T>
      )}

      {!loading && !err && (
        <Stack gap="md" className="text-xs p-4 overflow-y-auto">
          <Inline gap="md" align="start">
            <Stack gap="xs" className="flex-1 min-w-0">
              <T as="div" size="xs" weight="semibold" className="text-text-tertiary tracking-wide">
                FROM — <T size="xs" className="font-mono">p:{shortPv(entry.fromVersion)}</T>
              </T>
              <CodeBlock code={fromDetail?.content ?? '(not registered)'} language="text" />
            </Stack>
            <Stack gap="xs" className="flex-1 min-w-0">
              <T as="div" size="xs" weight="semibold" className="text-text-tertiary tracking-wide">
                TO — <T size="xs" className="font-mono">p:{shortPv(entry.toVersion)}</T>
              </T>
              <CodeBlock code={toDetail?.content ?? '(not registered)'} language="text" />
            </Stack>
          </Inline>
        </Stack>
      )}
    </Modal>
  );
}

export default CompareRunsPage;
