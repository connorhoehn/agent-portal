import { Fragment, useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehn/ui-components';
import { useFetch } from '../hooks/useFetch';

interface ObsSummary {
  totalInvocations24h: number;
  totalErrors24h: number;
  totalTokens24h: number;
  avgLatencyMs: number;
  successRate: string;
  traceCount: number;
}

interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTimeMs: number;
  durationMs: number;
  status: string;
}

interface Trace {
  traceId: string;
  agentName: string;
  startTime: string;
  totalDurationMs: number;
  spanCount: number;
  status: string;
  tokensIn: number;
  tokensOut: number;
  spans: TraceSpan[];
}

const SPAN_COLORS: Record<string, string> = {
  agent: '#2563eb',
  tool: '#16a34a',
  llm: '#9333ea',
  retrieval: '#d97706',
};

function ObservabilityPage() {
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000);
  const { data: tracesData } = useFetch<{ traces: Trace[] }>('/api/observability/traces');
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);

  const traces = tracesData?.traces ?? [];

  return (
    <PageSection title="Observability">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
        <StatCard label="Invocations (24h)" value={summary?.totalInvocations24h.toLocaleString() ?? '—'} />
        <StatCard label="Avg Latency" value={summary ? `${(summary.avgLatencyMs / 1000).toFixed(1)}s` : '—'} />
        <StatCard label="Tokens (24h)" value={summary ? `${(summary.totalTokens24h / 1000).toFixed(0)}k` : '—'} />
        <StatCard label="Success Rate" value={summary ? `${summary.successRate}%` : '—'} accent />
        <StatCard label="Errors (24h)" value={String(summary?.totalErrors24h ?? 0)} danger={!!summary && summary.totalErrors24h > 0} />
      </div>

      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent Traces</h2>
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Agent</TableTh>
              <TableTh>Time</TableTh>
              <TableTh>Duration</TableTh>
              <TableTh>Spans</TableTh>
              <TableTh>Tokens</TableTh>
              <TableTh>Status</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {traces.map(trace => (
              <Fragment key={trace.traceId}>
                <TableRow
                  onClick={() => setExpandedTrace(expandedTrace === trace.traceId ? null : trace.traceId)}
                  style={{ cursor: 'pointer' }}
                >
                  <TableTd style={{ fontWeight: 500 }}>{trace.agentName}</TableTd>
                  <TableTd style={{ fontSize: 12 }}>{new Date(trace.startTime).toLocaleTimeString()}</TableTd>
                  <TableTd>{(trace.totalDurationMs / 1000).toFixed(2)}s</TableTd>
                  <TableTd>{trace.spanCount}</TableTd>
                  <TableTd style={{ fontSize: 12 }}>{trace.tokensIn + trace.tokensOut}</TableTd>
                  <TableTd>
                    <Chip tone={trace.status === 'ok' ? 'success' : 'danger'} size="xs">{trace.status}</Chip>
                  </TableTd>
                </TableRow>
                {expandedTrace === trace.traceId && (
                  <TableRow key={`${trace.traceId}-detail`}>
                    <TableTd colSpan={6} style={{ padding: 0 }}>
                      <TraceWaterfall spans={trace.spans} totalDurationMs={trace.totalDurationMs} />
                    </TableTd>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>
    </PageSection>
  );
}

function TraceWaterfall({ spans, totalDurationMs }: { spans: TraceSpan[]; totalDurationMs: number }) {
  return (
    <div style={{ padding: '12px 16px', background: 'var(--color-surface-hover, #f8fafc)' }}>
      {spans.map(span => {
        const left = (span.startTimeMs / totalDurationMs) * 100;
        const width = Math.max((span.durationMs / totalDurationMs) * 100, 1);
        const color = SPAN_COLORS[span.kind] ?? '#64748b';

        return (
          <div key={span.spanId} style={{ display: 'flex', alignItems: 'center', marginBottom: 4, height: 24 }}>
            <div style={{ width: 180, fontSize: 11, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {span.name}
            </div>
            <div style={{ flex: 1, position: 'relative', height: 16 }}>
              <div style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                height: '100%',
                background: span.status === 'error' ? '#fecaca' : `${color}30`,
                border: `1px solid ${span.status === 'error' ? '#ef4444' : color}`,
                borderRadius: 3,
              }} />
            </div>
            <div style={{ width: 60, fontSize: 10, textAlign: 'right', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
              {span.durationMs}ms
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{
        fontSize: 24, fontWeight: 700, marginTop: 4,
        color: danger ? 'var(--color-danger)' : accent ? 'var(--color-success)' : undefined,
      }}>{value}</div>
    </Card>
  );
}

export default ObservabilityPage;
