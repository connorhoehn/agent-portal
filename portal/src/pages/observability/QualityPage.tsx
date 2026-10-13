// Quality dashboard. Agent picker drives a time-series + histogram of judge
// scores, plus a per-invocation feedback table. Data sources:
//   GET  /api/observability/quality/scores?agentId=&since=ISO8601 (30s poll)
//   POST /api/observability/quality/feedback
//
// Optimistic UI: feedback rows flip immediately on click and revert on error.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Button,
  Card,
  Chip,
  IconButton,
  Inline,
  Input,
  PageSection,
  SectionLabel,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded, readDegraded } from '../../lib/degraded';
import { toastError } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { relativeTime } from '../../lib/relativeTime';

interface QualityScore {
  invocationId: string;
  agentId: string;
  judgeScore: number | null;
  judgeRationale: string;
  ts: string;
  // Sprint 1 cost + provenance (nullable until Agent A's migration lands).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
  judgeCostUsd?: number | null;
  totalCostUsd?: number | null;
  promptVersion?: string | null;
  modelId?: string | null;
}

interface DriftSummaryRow {
  agentId: string;
}

type FeedbackLabel = 'good' | 'bad' | 'fixed';

// A judge score can be null — a run the judge never scored (sampled out,
// or the judge itself errored). Null is "unscored", not zero: it gets a
// neutral chip and stays out of the histogram rather than landing in the
// 0.0–0.1 bin as a phantom failure.
function judgeTone(v: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (v == null) return 'neutral';
  if (v >= 0.7) return 'success';
  if (v >= 0.5) return 'warning';
  return 'danger';
}

function isoSince24h(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function QualityPage() {
  const navigate = useNavigate();
  // Human labels POST /api/observability/quality/feedback (LabelFeedback).
  const { can, ready } = useCapabilities();
  const canLabel = ready && can('LabelFeedback');
  // Reuse the drift summary endpoint just to populate the agent picker — both
  // pages share the same set of sampled agents. If it 404s, fall back to an
  // empty list; user can still pick once the endpoint returns data.
  // Healthy: a bare array. Failed: `{ agents: [], degraded, error }` — an
  // array cannot carry a marker, so the failure changes shape. The
  // `Array.isArray` guard below is exactly what used to swallow it: a broken
  // drift query left the agent picker reading "(no agents)".
  const { data: agentsSummary } = useFetch<
    DriftSummaryRow[] | { agents?: DriftSummaryRow[]; degraded?: boolean; error?: string }
  >(
    '/api/observability/drift/summary?windowHours=1',
    30_000,
  );
  const agentOptions = useMemo(
    () => (Array.isArray(agentsSummary) ? agentsSummary.map((a) => a.agentId) : []),
    [agentsSummary],
  );

  const [selectedAgent, setSelectedAgent] = useState<string>('');
  useEffect(() => {
    if (!selectedAgent && agentOptions.length > 0) {
      setSelectedAgent(agentOptions[0]);
    }
  }, [agentOptions, selectedAgent]);

  // `since` is recomputed only when the agent changes — otherwise polling would
  // generate a new URL each render and the hook would refetch immediately.
  const since = useMemo(() => isoSince24h(), [selectedAgent]);
  const scoresUrl = selectedAgent
    ? `/api/observability/quality/scores?agentId=${encodeURIComponent(selectedAgent)}&since=${encodeURIComponent(since)}`
    : '';
  const {
    data: scoresData, error: scoresError, refresh,
  } = useFetch<{ points?: QualityScore[] } | QualityScore[]>(scoresUrl, 30_000);
  // Either read can fail: the picker's agent list, or this agent's scores.
  const qualityDegraded = firstDegraded(agentsSummary, scoresData);
  // Two separate reads behind two separate claims: the sample count comes from
  // the scores query, and the picker's option list from the drift rollup. The
  // comment above records that a broken drift query left the picker reading
  // "(no agents)" — capturing the marker fixed the fetch, but the label was
  // still hardcoded to that phrase, so the bug survived its own fix.
  const scoresBlind = scoresError ?? readDegraded(scoresData);
  const agentsBlind = readDegraded(agentsSummary);
  const scores = useMemo<QualityScore[]>(
    () => Array.isArray(scoresData) ? scoresData : (scoresData?.points ?? []),
    [scoresData],
  );

  // Sort ascending for the chart; the table renders newest-first.
  const chartData = useMemo(
    () =>
      [...scores]
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
        .map((s) => ({
          ts: new Date(s.ts).getTime(),
          tsLabel: new Date(s.ts).toLocaleTimeString(),
          judgeScore: s.judgeScore,
        })),
    [scores],
  );

  const histogram = useMemo(() => {
    const bins = new Array(10).fill(0).map((_, i) => ({
      bin: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
      count: 0,
    }));
    for (const s of scores) {
      if (s.judgeScore == null) continue;
      let idx = Math.floor(s.judgeScore * 10);
      if (idx < 0) idx = 0;
      if (idx > 9) idx = 9;
      bins[idx].count += 1;
    }
    return bins;
  }, [scores]);

  const tableRows = useMemo(
    () => [...scores].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()),
    [scores],
  );

  // Optimistic feedback state: invocationId -> label currently selected.
  // `null` = explicitly cleared (didn't submit / errored).
  const [feedback, setFeedback] = useState<Record<string, FeedbackLabel | null>>({});
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  async function submitFeedback(invocationId: string, label: FeedbackLabel, note?: string) {
    const prev = feedback[invocationId] ?? null;
    setFeedback((m) => ({ ...m, [invocationId]: label }));
    const res = await writeJson('/api/observability/quality/feedback', 'POST', { invocationId, label, note });
    if (!res.ok) {
      // Revert on error, and say so — a silent revert reads as the click
      // having done nothing, not as a refused write.
      setFeedback((m) => ({ ...m, [invocationId]: prev }));
      toastError(null, 'Feedback not saved', res.error ?? 'unknown error');
      return;
    }
    // Refresh after a successful note submission so the rationale column
    // can pick up any backend-side updates.
    if (label === 'fixed') refresh();
  }

  function startNote(invocationId: string) {
    setNoteFor(invocationId);
    setNoteText('');
  }

  function cancelNote() {
    setNoteFor(null);
    setNoteText('');
  }

  function commitNote() {
    if (!noteFor) return;
    submitFeedback(noteFor, 'fixed', noteText || undefined);
    setNoteFor(null);
    setNoteText('');
  }

  const renderFeedback = (invocationId: string) => {
    const currentLabel = feedback[invocationId];
    return noteFor === invocationId ? (
                          <Inline as="div" align="center" gap="xs" wrap={false}>
                            <Input
                              autoFocus
                              value={noteText}
                              onChange={(e) => setNoteText(e.target.value)}
                              placeholder="note…"
                              className="min-w-[160px]"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitNote();
                                if (e.key === 'Escape') cancelNote();
                              }}
                            />
                            <Button variant="secondary" size="sm" onClick={commitNote}>
                              save
                            </Button>
                            <Button variant="secondary" size="sm" onClick={cancelNote}>
                              cancel
                            </Button>
                          </Inline>
                        ) : !canLabel ? null : (
                          <Inline as="div" gap="xs" wrap={false}>
                            <FeedbackBtn
                              label="good"
                              symbol="✓"
                              active={currentLabel === 'good'}
                              onClick={() => submitFeedback(invocationId, 'good')}
                            />
                            <FeedbackBtn
                              label="bad"
                              symbol="✗"
                              active={currentLabel === 'bad'}
                              onClick={() => submitFeedback(invocationId, 'bad')}
                            />
                            <FeedbackBtn
                              label="fixed"
                              symbol="✎"
                              active={currentLabel === 'fixed'}
                              onClick={() => startNote(invocationId)}
                            />
                          </Inline>
                        );
  };

  return (
    <PageSection
      title="Quality"
      description={
        scoresBlind
          ? 'Last 24h · 30s refresh · sample count could not be read'
          : `Last 24h · 30s refresh · ${scores.length} sample${scores.length === 1 ? '' : 's'}`
      }
      actions={
        <Select
          aria-label="Filter by agent"
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          disabled={agentOptions.length === 0}
          options={
            agentOptions.length === 0
              ? [{ value: '', label: agentsBlind ? '(agent list unavailable)' : '(no agents)' }]
              : agentOptions.map((a) => ({ value: a, label: a }))
          }
        />
      }
    >
      {(scoresError || qualityDegraded) && (
        <UnavailableNotice
          error={scoresError ?? qualityDegraded ?? 'the judge-score query failed'}
          what="judge scores"
          source="Scores are read from the sampled invocation traces in Aurora"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      <Card padding="md">

        {chartData.length === 0 ? (
          <SmartEmptyState
            title="No judge scores yet"
            detail="Quality charts populate once invocations are sampled and scored by the LLM-as-judge."
            degraded={qualityDegraded}
            degradedWhat="the judge-score chart"
            degradedSource="Scores are read from the sampled invocation traces in Aurora"
            onRetry={refresh}
            actions={[
              {
                label: 'Run the test harness',
                detail: 'Generates ~10 sampled traces with judge scores in ~30s.',
                code: 'python3 infra/scripts/harness.py run --mode live --label "drift-seed@$(git rev-parse --short HEAD)"',
              },
              {
                label: 'Or invoke an agent directly to generate one trace',
                code: "agentcore invoke --agent orgiq-search --prompt 'Who knows K8s?'",
              },
            ]}
          />
        ) : (
          <Inline as="div" align="start" gap="lg">
            <Card padding="sm" className="flex-1 min-w-0">
              <SectionLabel as="div" className="mb-2">Time series</SectionLabel>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={chartData}
                  margin={{ top: 4, right: 12, bottom: 4, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="tsLabel"
                    fontSize={10}
                    stroke="var(--color-text-tertiary)"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0, 1]}
                    fontSize={10}
                    stroke="var(--color-text-tertiary)"
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="judgeScore"
                    stroke="var(--color-primary)"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
            <Card padding="sm" className="flex-1 min-w-0">
              <SectionLabel as="div" className="mb-2">Histogram (10 bins)</SectionLabel>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={histogram}
                  margin={{ top: 4, right: 12, bottom: 4, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="bin" fontSize={10} stroke="var(--color-text-tertiary)" />
                  <YAxis fontSize={10} allowDecimals={false} stroke="var(--color-text-tertiary)" />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <Bar
                    dataKey="count"
                    fill="var(--color-primary)"
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Inline>
        )}
      </Card>

      <Card padding="md">
        <Inline as="div" align="center" justify="between" wrap gap="md" className="mb-3">
          <Inline as="h2" gap="xs" wrap align="baseline" className="m-0">
            <T size="sm" weight="semibold">
            Recent Invocations</T>
            <T size="xs" tone="tertiary">
              click a feedback button to label · ✎ adds a note
            </T>
          </Inline>
        </Inline>

        {tableRows.length === 0 ? (
          <EmptyState text="No invocations to review yet." degraded={qualityDegraded} />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Score</TableTh>
                <TableTh>Rationale</TableTh>
                <TableTh>Cost</TableTh>
                <TableTh>Feedback</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((r) => {
                return (
                  <TableRow key={r.invocationId}>
                    <TableTd
                      className="whitespace-nowrap"
                      title={new Date(r.ts).toLocaleString()}
                    >
                      {relativeTime(r.ts)}
                    </TableTd>
                    <TableTd>
                      <Chip tone={judgeTone(r.judgeScore)} size="xs">
                        {r.judgeScore == null ? '—' : r.judgeScore.toFixed(2)}
                      </Chip>
                    </TableTd>
                    <TableTd
                      className={`w-full max-w-0 ${r.invocationId ? 'cursor-pointer' : ''}`}
                      title={
                        r.invocationId
                          ? `${r.judgeRationale} — click to open invocation`
                          : r.judgeRationale
                      }
                      onClick={() => {
                        if (r.invocationId) {
                          navigate(`/admin/observability/invocations/${r.invocationId}`);
                        }
                      }}
                    >
                      <T className="block truncate">{r.judgeRationale}</T>
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <CostChip cost={r.totalCostUsd} />
                    </TableTd>
                    <TableTd>{renderFeedback(r.invocationId)}</TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

function FeedbackBtn({
  label,
  symbol,
  active,
  onClick,
}: {
  label: FeedbackLabel;
  symbol: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      aria-label={label}
      title={label}
      icon={symbol}
      variant={active ? 'primary' : 'ghost'}
      size="sm"
      onClick={onClick}
    />
  );
}

// Row-level "nothing here" that will not say so when it does not know.
function EmptyState({ text, degraded }: { text: string; degraded?: string | null }) {
  if (degraded) {
    return (
      <Inline as="div" justify="center" className="p-6 text-danger"><T size="xs" tone="inherit">
        Unknown — this read failed ({degraded}).</T>
      </Inline>
    );
  }
  return (
    <Inline as="div" justify="center" className="p-6"><T size="xs" tone="tertiary">{text}</T></Inline>
  );
}

export default QualityPage;
