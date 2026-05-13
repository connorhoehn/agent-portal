// Drift detection dashboard. Per-agent rollup + outlier drill-in.
// Data sources:
//   GET /api/observability/drift/summary?windowHours=1   (30s poll)
//   GET /api/observability/drift/outliers?agentId=&limit=20
// Both routes are owned by Agent A and may 404 in this worktree — useFetch
// surfaces that as `data === null` and we render an empty state.

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
import { useFetch } from '../../hooks/useFetch';

interface DriftSummary {
  agentId: string;
  count: number;
  schemaConformance: number;
  judgeP50: number;
  judgeP05: number;
  embeddingDriftP95: number;
}

interface DriftOutlier {
  invocationId: string;
  agentId: string;
  templateId: string;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number;
  cosDist: number;
  ts: string;
}

type Tone = 'success' | 'warning' | 'danger';

function schemaTone(v: number): Tone {
  if (v >= 0.98) return 'success';
  if (v >= 0.9) return 'warning';
  return 'danger';
}

function judgeP05Tone(v: number): Tone {
  if (v >= 0.7) return 'success';
  if (v >= 0.5) return 'warning';
  return 'danger';
}

function driftP95Tone(v: number): Tone {
  if (v <= 0.3) return 'success';
  if (v <= 0.5) return 'warning';
  return 'danger';
}

function judgeP50Tone(v: number): Tone {
  // Mirror judgeP05 thresholds — same axis, weaker signal.
  if (v >= 0.75) return 'success';
  if (v >= 0.55) return 'warning';
  return 'danger';
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function DriftPage() {
  const { data: summary } = useFetch<DriftSummary[]>(
    '/api/observability/drift/summary?windowHours=1',
    30_000,
  );

  const rows = useMemo(() => (Array.isArray(summary) ? summary : []), [summary]);

  const [selectedAgent, setSelectedAgent] = useState<string>('');

  // Default selection to first agent once data arrives.
  useEffect(() => {
    if (!selectedAgent && rows.length > 0) {
      setSelectedAgent(rows[0].agentId);
    }
  }, [rows, selectedAgent]);

  const outlierUrl = selectedAgent
    ? `/api/observability/drift/outliers?agentId=${encodeURIComponent(selectedAgent)}&limit=20`
    : '';
  const { data: outliersData } = useFetch<{ outliers?: DriftOutlier[] } | DriftOutlier[]>(outlierUrl, 30_000);
  const outlierRows = useMemo<DriftOutlier[]>(
    () => Array.isArray(outliersData) ? outliersData : (outliersData?.outliers ?? []),
    [outliersData],
  );

  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Drift Rollup{' '}
            <span style={hint}>
              per-agent · {rows.length} agent{rows.length === 1 ? '' : 's'} · 30s refresh · 1h window
            </span>
          </h2>
        </div>

        {rows.length === 0 ? (
          <EmptyState text="No invocations sampled yet. Drift detection activates after the first sampled invocation." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Count</TableTh>
                <TableTh>Schema OK %</TableTh>
                <TableTh>Judge P50</TableTh>
                <TableTh>Judge P05</TableTh>
                <TableTh>Drift P95</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.agentId}>
                  <TableTd style={agentCell}>{r.agentId}</TableTd>
                  <TableTd style={numCell}>{r.count}</TableTd>
                  <TableTd>
                    <Chip tone={schemaTone(r.schemaConformance)} size="xs">
                      {(r.schemaConformance * 100).toFixed(1)}%
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={judgeP50Tone(r.judgeP50)} size="xs">
                      {fmt(r.judgeP50)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={judgeP05Tone(r.judgeP05)} size="xs">
                      {fmt(r.judgeP05)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    <Chip tone={driftP95Tone(r.embeddingDriftP95)} size="xs">
                      {fmt(r.embeddingDriftP95)}
                    </Chip>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Outliers{' '}
            <span style={hint}>
              lowest judge / highest drift · click row for full prompt + response
            </span>
          </h2>
          <select
            value={selectedAgent}
            onChange={(e) => {
              setSelectedAgent(e.target.value);
              setExpanded(null);
            }}
            style={selectStyle}
            disabled={rows.length === 0}
          >
            {rows.length === 0 && <option value="">(no agents)</option>}
            {rows.map((r) => (
              <option key={r.agentId} value={r.agentId}>
                {r.agentId}
              </option>
            ))}
          </select>
        </div>

        {!selectedAgent ? (
          <EmptyState text="Pick an agent above to see outliers." />
        ) : outlierRows.length === 0 ? (
          <EmptyState text="No outliers for this agent in the current window." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Template</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Response</TableTh>
                <TableTh>Judge</TableTh>
                <TableTh>CosDist</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {outlierRows.map((o) => {
                const isOpen = expanded === o.invocationId;
                return (
                  <>
                    <TableRow key={o.invocationId}>
                      <TableTd style={tsCell}>{new Date(o.ts).toLocaleTimeString()}</TableTd>
                      <TableTd style={monoCell}>{o.templateId}</TableTd>
                      <TableTd
                        style={{ ...snippetCell, cursor: 'pointer' }}
                        title={o.promptSnippet}
                        onClick={() => toggle(o.invocationId)}
                      >
                        {o.promptSnippet}
                      </TableTd>
                      <TableTd
                        style={{ ...snippetCell, cursor: 'pointer' }}
                        title={o.responseSnippet}
                        onClick={() => toggle(o.invocationId)}
                      >
                        {o.responseSnippet}
                      </TableTd>
                      <TableTd>
                        <Chip tone={judgeP05Tone(o.judgeScore)} size="xs">
                          {fmt(o.judgeScore)}
                        </Chip>
                      </TableTd>
                      <TableTd>
                        <Chip tone={driftP95Tone(o.cosDist)} size="xs">
                          {fmt(o.cosDist)}
                        </Chip>
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${o.invocationId}-detail`}>
                        <TableTd colSpan={6} style={{ padding: 12, background: 'var(--color-bg)' }}>
                          <div style={detailGrid}>
                            <div>
                              <div style={detailLabel}>PROMPT</div>
                              <pre style={detailPre}>{o.promptSnippet}</pre>
                            </div>
                            <div>
                              <div style={detailLabel}>RESPONSE</div>
                              <pre style={detailPre}>{o.responseSnippet}</pre>
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

const agentCell: CSSProperties = { fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };
const numCell: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)' };
const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};
const monoCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
};
const snippetCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const detailGrid: CSSProperties = {
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
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  maxHeight: 300,
  overflowY: 'auto',
};

export default DriftPage;
