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

interface CapabilityEvent {
  id: string;
  kind: 'browser_navigate' | 'browser_screenshot' | 'browser_launch' | 'browser_close' | 'code_execute';
  startedAt: string;
  durationMs: number;
  sessionId: string;
  detail: Record<string, string | number | boolean | undefined>;
  ok: boolean;
  error?: string;
}

interface BedrockInvocation {
  requestId: string;
  timestamp: string;
  agent: string;
  modelId: string;
  operation: string;
  promptSnippet: string;
  responseSnippet: string;
  inputTokens: number;
  outputTokens: number;
  intervened: boolean;
  interventions: Array<{ source: 'INPUT' | 'OUTPUT'; policyType: string; detail: string }>;
}

function ObservabilityPage() {
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000);
  const { data: guardrail } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=24', 60000);
  const { data: recent } = useFetch<{ invocations: Invocation[] }>('/api/observability/recent-invocations?limit=50', 5000);
  const { data: bedrock } = useFetch<{ entries: BedrockInvocation[] }>('/api/observability/bedrock-invocations?limit=20&sinceMin=60', 20000);
  const { data: capEvents } = useFetch<{ events: CapabilityEvent[] }>('/api/observability/capability-events?limit=50', 5000);

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

      <Card padding="md" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Bedrock Invocations{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              from /orgiq/bedrock-invocations · ~30s lag · full guardrail trace
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {bedrock?.entries.filter(e => e.intervened).length ?? 0} intervened in last hour
          </span>
        </div>
        {(bedrock?.entries ?? []).length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No Bedrock calls in the last hour. Invoke an agent and wait ~30s.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Op</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Tokens</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {(bedrock?.entries ?? []).map(b => (
                <TableRow key={b.requestId}>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {new Date(b.timestamp).toLocaleTimeString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{b.agent}</TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'monospace' }}>{b.operation}</TableTd>
                  <TableTd style={{ fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.promptSnippet}>
                    {b.promptSnippet}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{b.inputTokens}↓ / {b.outputTokens}↑</TableTd>
                  <TableTd>
                    {b.intervened ? (
                      <span title={b.interventions.map(i => `${i.source}: ${i.policyType}/${i.detail}`).join('\n')}>
                        <Chip tone="warning" size="xs">{b.interventions[0]?.detail || 'blocked'}</Chip>
                      </span>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Capability Events{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              browser + code interpreter activity · live · 5s refresh
            </span>
          </h2>
        </div>
        {(capEvents?.events ?? []).length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No browser or code-interpreter activity yet. Use the Capabilities page to trigger some.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Kind</TableTh>
                <TableTh>Session</TableTh>
                <TableTh>Detail</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {(capEvents?.events ?? []).map(ev => {
                const detailText = formatCapDetail(ev);
                return (
                  <TableRow key={ev.id}>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                      {new Date(ev.startedAt).toLocaleTimeString()}
                    </TableTd>
                    <TableTd>
                      <Chip tone={ev.kind.startsWith('browser') ? 'default' : 'info' as any} size="xs">
                        {ev.kind.replace('_', ' ')}
                      </Chip>
                    </TableTd>
                    <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                      {ev.sessionId ? ev.sessionId.slice(0, 12) + '…' : '—'}
                    </TableTd>
                    <TableTd style={{ fontSize: 12, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detailText}>
                      {detailText}
                    </TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {(ev.durationMs / 1000).toFixed(2)}s
                    </TableTd>
                    <TableTd>
                      {ev.ok ? (
                        <Chip tone="success" size="xs">ok</Chip>
                      ) : (
                        <Chip tone="danger" size="xs">err</Chip>
                      )}
                    </TableTd>
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

function formatCapDetail(ev: CapabilityEvent): string {
  const d = ev.detail || {};
  switch (ev.kind) {
    case 'browser_launch':
      return `${d['agentName'] ?? ''} → ${d['url'] ?? 'about:blank'}${d['pageTitle'] ? ` (${d['pageTitle']})` : ''}`;
    case 'browser_navigate':
      return `→ ${d['url']}${d['pageTitle'] ? ` (${d['pageTitle']})` : ''}`;
    case 'browser_screenshot':
      return `${d['bytes']} bytes`;
    case 'browser_close':
      return 'session closed';
    case 'code_execute':
      return `${d['codeSnippet']} → ${d['outputSnippet']}`;
    default:
      return JSON.stringify(d);
  }
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
