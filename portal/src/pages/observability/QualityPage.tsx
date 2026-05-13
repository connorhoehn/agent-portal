// Quality dashboard. Agent picker drives a time-series + histogram of judge
// scores, plus a per-invocation feedback table. Data sources:
//   GET  /api/observability/quality/scores?agentId=&since=ISO8601 (30s poll)
//   POST /api/observability/quality/feedback
//
// Optimistic UI: feedback rows flip immediately on click and revert on error.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
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
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface QualityScore {
  invocationId: string;
  agentId: string;
  judgeScore: number;
  judgeRationale: string;
  ts: string;
}

interface DriftSummaryRow {
  agentId: string;
}

type FeedbackLabel = 'good' | 'bad' | 'fixed';

function judgeTone(v: number): 'success' | 'warning' | 'danger' {
  if (v >= 0.7) return 'success';
  if (v >= 0.5) return 'warning';
  return 'danger';
}

function isoSince24h(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function QualityPage() {
  // Reuse the drift summary endpoint just to populate the agent picker — both
  // pages share the same set of sampled agents. If it 404s, fall back to an
  // empty list; user can still pick once the endpoint returns data.
  const { data: agentsSummary } = useFetch<DriftSummaryRow[]>(
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
  const { data: scoresData, refresh } = useFetch<QualityScore[]>(scoresUrl, 30_000);
  const scores = useMemo(
    () => (Array.isArray(scoresData) ? scoresData : []),
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
    try {
      const res = await fetch('/api/observability/quality/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ invocationId, label, note }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Refresh after a successful note submission so the rationale column
      // can pick up any backend-side updates.
      if (label === 'fixed') refresh();
    } catch {
      // Revert on error.
      setFeedback((m) => ({ ...m, [invocationId]: prev }));
    }
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

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Judge Scores{' '}
            <span style={hint}>
              last 24h · 30s refresh · {scores.length} sample{scores.length === 1 ? '' : 's'}
            </span>
          </h2>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            style={selectStyle}
            disabled={agentOptions.length === 0}
          >
            {agentOptions.length === 0 && <option value="">(no agents)</option>}
            {agentOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        {chartData.length === 0 ? (
          <EmptyState text="No judge scores yet. Quality charts populate once invocations are sampled and scored." />
        ) : (
          <div style={chartGrid}>
            <div style={chartBox}>
              <div style={chartTitle}>Time series</div>
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
                    stroke="var(--color-primary, #6366f1)"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={chartBox}>
              <div style={chartTitle}>Histogram (10 bins)</div>
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
                    fill="var(--color-primary, #6366f1)"
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Recent Invocations{' '}
            <span style={hint}>click a feedback button to label · ✎ adds a note</span>
          </h2>
        </div>

        {tableRows.length === 0 ? (
          <EmptyState text="No invocations to review yet." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Score</TableTh>
                <TableTh>Rationale</TableTh>
                <TableTh>Feedback</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((r) => {
                const currentLabel = feedback[r.invocationId];
                const isNoting = noteFor === r.invocationId;
                return (
                  <TableRow key={r.invocationId}>
                    <TableTd style={tsCell}>
                      {new Date(r.ts).toLocaleTimeString()}
                    </TableTd>
                    <TableTd>
                      <Chip tone={judgeTone(r.judgeScore)} size="xs">
                        {r.judgeScore.toFixed(2)}
                      </Chip>
                    </TableTd>
                    <TableTd
                      style={rationaleCell}
                      title={r.judgeRationale}
                    >
                      {r.judgeRationale}
                    </TableTd>
                    <TableTd>
                      {isNoting ? (
                        <div style={noteRow}>
                          <input
                            autoFocus
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            placeholder="note…"
                            style={{ ...selectStyle, minWidth: 160 }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNote();
                              if (e.key === 'Escape') cancelNote();
                            }}
                          />
                          <button style={btnSecondary} onClick={commitNote}>
                            save
                          </button>
                          <button style={btnSecondary} onClick={cancelNote}>
                            cancel
                          </button>
                        </div>
                      ) : (
                        <div style={fbBtnRow}>
                          <FeedbackBtn
                            label="good"
                            symbol="✓"
                            active={currentLabel === 'good'}
                            onClick={() => submitFeedback(r.invocationId, 'good')}
                          />
                          <FeedbackBtn
                            label="bad"
                            symbol="✗"
                            active={currentLabel === 'bad'}
                            onClick={() => submitFeedback(r.invocationId, 'bad')}
                          />
                          <FeedbackBtn
                            label="fixed"
                            symbol="✎"
                            active={currentLabel === 'fixed'}
                            onClick={() => startNote(r.invocationId)}
                          />
                        </div>
                      )}
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
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
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        ...fbBtn,
        background: active ? 'var(--color-primary, #6366f1)' : 'var(--color-surface)',
        color: active ? '#fff' : 'var(--color-text-secondary)',
        borderColor: active ? 'var(--color-primary, #6366f1)' : 'var(--color-border)',
      }}
    >
      {symbol}
    </button>
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

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap',
};

const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };

const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};

const selectStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

const btnSecondary: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const chartGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 16,
};

const chartBox: CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 12,
  background: 'var(--color-surface)',
};

const chartTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};

const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};

const rationaleCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 480,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--color-text-secondary)',
};

const fbBtnRow: CSSProperties = { display: 'flex', gap: 4 };

const fbBtn: CSSProperties = {
  width: 28,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 700,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const noteRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

export default QualityPage;
