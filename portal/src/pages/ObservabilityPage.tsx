import { Fragment, useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components/shared';
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

interface GuardrailMetrics {
  totalInvocations: number;
  totalInterventions: number;
  interventionRate: string;
  series: Array<{ timestamp: string; invocations: number; interventions: number }>;
}

interface Invocation {
  id: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  durationMs: number;
  promptSnippet: string;
  responseSnippet: string;
  guardrailIntervened: boolean;
  runtimeSessionId?: string;
  error?: string;
}

function ObservabilityPage() {
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000);
  const { data: tracesData } = useFetch<{ traces: Trace[] }>('/api/observability/traces');
  const { data: guardrail } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=24', 60000);
  const { data: recent } = useFetch<{ invocations: Invocation[] }>('/api/observability/recent-invocations?limit=50', 5000);
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

      <Card padding="md" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Guardrail Activity (24h){' '}
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              from AWS/Bedrock metrics
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
            <span><span style={{ color: 'var(--color-text-tertiary)' }}>Invocations: </span><b>{guardrail?.totalInvocations ?? 0}</b></span>
            <span><span style={{ color: 'var(--color-text-tertiary)' }}>Interventions: </span><b style={{ color: (guardrail?.totalInterventions ?? 0) > 0 ? '#dc2626' : undefined }}>{guardrail?.totalInterventions ?? 0}</b></span>
            <span><span style={{ color: 'var(--color-text-tertiary)' }}>Rate: </span><b>{guardrail?.interventionRate ?? '0.0'}%</b></span>
          </div>
        </div>
        <GuardrailSparkline series={guardrail?.series ?? []} />
      </Card>

      <Card padding="md" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Recent Activity{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              live · last 50 invocations · 5s refresh
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {recent?.invocations.filter(i => i.guardrailIntervened).length ?? 0} intervened
          </span>
        </div>
        {(recent?.invocations ?? []).length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No invocations yet. Send a message via the Invoke Agent page and it'll appear here within 5 seconds.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Response</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {(recent?.invocations ?? []).map(inv => (
                <TableRow key={inv.id}>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {new Date(inv.startedAt).toLocaleTimeString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{inv.agentName}</TableTd>
                  <TableTd style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inv.promptSnippet}>
                    {inv.promptSnippet}
                  </TableTd>
                  <TableTd style={{ fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }} title={inv.responseSnippet || inv.error}>
                    {inv.error ? <span style={{ color: 'var(--color-danger, #dc2626)' }}>error: {inv.error}</span> : inv.responseSnippet}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{(inv.durationMs / 1000).toFixed(1)}s</TableTd>
                  <TableTd>
                    {inv.error ? (
                      <Chip tone="danger" size="xs">error</Chip>
                    ) : inv.guardrailIntervened ? (
                      <Chip tone="warning" size="xs">blocked</Chip>
                    ) : (
                      <Chip tone="success" size="xs">ok</Chip>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

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

function GuardrailSparkline({ series }: { series: Array<{ timestamp: string; invocations: number; interventions: number }> }) {
  const width = 800;
  const height = 60;
  const padding = 2;
  const maxVal = Math.max(1, ...series.map(p => Math.max(p.invocations, p.interventions)));
  const points = (key: 'invocations' | 'interventions') =>
    series.map((p, i) => {
      const x = padding + (i / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - (p[key] / maxVal) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

  if (series.length === 0) {
    return <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 12, textAlign: 'center' }}>No guardrail activity in the last 24h.</div>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 60, display: 'block' }}>
      <polyline fill="none" stroke="var(--color-primary, #6366f1)" strokeWidth="1.5" points={points('invocations')} />
      <polyline fill="none" stroke="#dc2626" strokeWidth="1.5" points={points('interventions')} />
    </svg>
  );
}

export default ObservabilityPage;
