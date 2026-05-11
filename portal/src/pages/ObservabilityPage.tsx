import { useState } from 'react';
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

interface SandboxExecution {
  code: string;
  output: string;
  durationMs: number;
  sessionId: string;
  timestamp: string;
  error?: string;
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
  sandboxExecutions?: SandboxExecution[];
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
  const { data: guardrail } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=6', 60000);
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
            Guardrail Activity (6h){' '}
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

      <CodeInterpreterTraces invocations={recent?.invocations ?? []} />

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
    return <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 12, textAlign: 'center' }}>No guardrail activity in the last 6h.</div>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 60, display: 'block' }}>
      <polyline fill="none" stroke="var(--color-primary, #6366f1)" strokeWidth="1.5" points={points('invocations')} />
      <polyline fill="none" stroke="#dc2626" strokeWidth="1.5" points={points('interventions')} />
    </svg>
  );
}

// ─── Code Interpreter Traces ──────────────────────────────────────────────────

const monoStyle: React.CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  overflowX: 'auto',
};

function CodeInterpreterTraces({ invocations }: { invocations: Invocation[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedExec, setExpandedExec] = useState<Set<string>>(new Set());

  const traced = invocations.filter(i => (i.sandboxExecutions?.length ?? 0) > 0);

  const toggle = (id: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const toggleExec = (key: string) =>
    setExpandedExec(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });

  return (
    <Card padding="md" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Code Interpreter Traces</h2>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          invocations that triggered run_in_sandbox · live ring buffer
        </span>
        {traced.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>
            {traced.length} invocation{traced.length !== 1 ? 's' : ''} ·{' '}
            {traced.reduce((n, i) => n + (i.sandboxExecutions?.length ?? 0), 0)} execution{traced.reduce((n, i) => n + (i.sandboxExecutions?.length ?? 0), 0) !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {traced.length === 0 ? (
        <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          No Code Interpreter executions yet. Ask the scoring or graph-builder agent a computational question (e.g. "compute PageRank" or "run expertise scoring 5 different ways") and executions will appear here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {traced.map(inv => {
            const isOpen = expanded.has(inv.id);
            const execCount = inv.sandboxExecutions?.length ?? 0;
            return (
              <div key={inv.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                {/* Invocation header row */}
                <div
                  onClick={() => toggle(inv.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                    cursor: 'pointer', background: isOpen ? 'var(--color-surface-hover)' : 'var(--color-surface)',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {new Date(inv.startedAt).toLocaleTimeString()}
                  </span>
                  <span style={{
                    padding: '1px 7px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                    background: 'var(--color-surface-hover)', color: 'var(--color-primary)',
                  }}>
                    {inv.agentName.replace('orgiq-', '')}
                  </span>
                  <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.promptSnippet}
                  </span>
                  <span style={{
                    padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                    background: 'var(--color-primary)', color: '#fff',
                  }}>
                    {execCount} sandbox run{execCount !== 1 ? 's' : ''}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {(inv.durationMs / 1000).toFixed(1)}s total
                  </span>
                </div>

                {/* Sandbox execution list */}
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
                    {(inv.sandboxExecutions ?? []).map((exec, idx) => {
                      const execKey = `${inv.id}-${idx}`;
                      const execOpen = expandedExec.has(execKey);
                      return (
                        <div key={execKey} style={{ borderBottom: idx < execCount - 1 ? '1px solid var(--color-border)' : undefined }}>
                          {/* Execution summary row */}
                          <div
                            onClick={() => toggleExec(execKey)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 8px 28px',
                              cursor: 'pointer', userSelect: 'none',
                              background: execOpen ? 'var(--color-surface)' : 'transparent',
                            }}
                          >
                            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{execOpen ? '▾' : '▸'}</span>
                            <span style={{
                              padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                              background: exec.error ? 'var(--color-error-bg, #fee2e2)' : 'var(--color-success-bg, #dcfce7)',
                              color: exec.error ? 'var(--color-error, #dc2626)' : 'var(--color-success, #16a34a)',
                            }}>
                              run {idx + 1}
                            </span>
                            <code style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {exec.code.trim().split('\n').find(l => l.trim() && !l.startsWith('#')) ?? exec.code.trim().slice(0, 80)}
                            </code>
                            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                              {exec.durationMs}ms · {exec.sessionId.slice(-8)}
                            </span>
                          </div>

                          {/* Full code + output */}
                          {execOpen && (
                            <div style={{ padding: '0 14px 12px 28px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>INPUT — generated code</div>
                                <pre style={{ ...monoStyle, background: 'var(--color-surface)', border: '1px solid var(--color-border)', maxHeight: 300, overflowY: 'auto' }}>
                                  {exec.code}
                                </pre>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                                  OUTPUT{exec.error ? ' — error' : ''}
                                </div>
                                <pre style={{
                                  ...monoStyle,
                                  background: exec.error ? 'var(--color-error-bg, #fee2e2)' : 'var(--color-bg)',
                                  border: '1px solid var(--color-border)',
                                  color: exec.error ? 'var(--color-error, #dc2626)' : 'var(--color-text)',
                                  maxHeight: 300, overflowY: 'auto',
                                }}>
                                  {exec.output || '(no output)'}
                                </pre>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default ObservabilityPage;
