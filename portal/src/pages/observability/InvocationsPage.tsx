import { useMemo, useState } from 'react';
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
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';

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
  // Sprint 1 cost + provenance fields (nullable until Agent A's migration lands).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
  judgeCostUsd?: number | null;
  totalCostUsd?: number | null;
  promptVersion?: string | null;
  modelId?: string | null;
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

type StatusFilter = 'all' | 'ok' | 'blocked' | 'error';

function InvocationsPage() {
  const { data: recent } = useFetch<{ invocations: Invocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    5000,
  );
  const { data: bedrock } = useFetch<{ entries: BedrockInvocation[] }>(
    '/api/observability/bedrock-invocations?limit=20&sinceMin=60',
    20000,
  );

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const allInvocations = recent?.invocations ?? [];

  const agentOptions = useMemo(() => {
    const names = new Set<string>();
    allInvocations.forEach((i) => names.add(i.agentName));
    return Array.from(names).sort();
  }, [allInvocations]);

  const filtered = useMemo(() => {
    return allInvocations.filter((inv) => {
      if (agentFilter !== 'all' && inv.agentName !== agentFilter) return false;
      if (statusFilter === 'ok' && (inv.error || inv.guardrailIntervened)) return false;
      if (statusFilter === 'blocked' && !inv.guardrailIntervened) return false;
      if (statusFilter === 'error' && !inv.error) return false;
      return true;
    });
  }, [allInvocations, agentFilter, statusFilter]);

  const intervenedCount = filtered.filter((i) => i.guardrailIntervened).length;

  return (
    <PageSection
      title="Recent Activity"
      description="Live · last 50 invocations · 5s refresh"
      actions={
        <>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="all">All agents</option>
            {agentOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            style={selectStyle}
          >
            <option value="all">All statuses</option>
            <option value="ok">OK</option>
            <option value="blocked">Blocked</option>
            <option value="error">Error</option>
          </select>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {intervenedCount} intervened
          </span>
        </>
      }
    >
      <Card padding="md">
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            {allInvocations.length === 0
              ? "No invocations yet. Send a message via the Agent Tools page and it'll appear here within 5 seconds."
              : 'No invocations match the current filters.'}
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt ver.</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Response</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh>Cost</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((inv) => (
                <TableRow key={inv.id}>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {new Date(inv.startedAt).toLocaleTimeString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {inv.agentName}
                  </TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap' }}>
                    <PromptVersionChip promptVersion={inv.promptVersion} />
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 12,
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={inv.promptSnippet}
                  >
                    {inv.promptSnippet}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 12,
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--color-text-secondary)',
                    }}
                    title={inv.responseSnippet || inv.error}
                  >
                    {inv.error ? (
                      <span style={{ color: 'var(--color-danger, #dc2626)' }}>
                        error: {inv.error}
                      </span>
                    ) : (
                      inv.responseSnippet
                    )}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {(inv.durationMs / 1000).toFixed(1)}s
                  </TableTd>
                  <TableTd style={{ whiteSpace: 'nowrap' }}>
                    <CostChip cost={inv.totalCostUsd} />
                  </TableTd>
                  <TableTd>
                    {inv.error ? (
                      <Chip tone="danger" size="xs">
                        error
                      </Chip>
                    ) : inv.guardrailIntervened ? (
                      <Chip tone="warning" size="xs">
                        blocked
                      </Chip>
                    ) : (
                      <Chip tone="success" size="xs">
                        ok
                      </Chip>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CodeInterpreterTraces invocations={filtered} />

      <Card padding="md">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Bedrock Invocations{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              from /orgiq/bedrock-invocations · ~30s lag · full guardrail trace
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {bedrock?.entries.filter((e) => e.intervened).length ?? 0} intervened in last hour
          </span>
        </div>
        {(bedrock?.entries ?? []).length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
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
              {(bedrock?.entries ?? []).map((b) => (
                <TableRow key={b.requestId}>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {new Date(b.timestamp).toLocaleTimeString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {b.agent}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      fontFamily: 'monospace',
                    }}
                  >
                    {b.operation}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 12,
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={b.promptSnippet}
                  >
                    {b.promptSnippet}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {b.inputTokens}↓ / {b.outputTokens}↑
                  </TableTd>
                  <TableTd>
                    {b.intervened ? (
                      <span
                        title={b.interventions
                          .map((i) => `${i.source}: ${i.policyType}/${i.detail}`)
                          .join('\n')}
                      >
                        <Chip tone="warning" size="xs">
                          {b.interventions[0]?.detail || 'blocked'}
                        </Chip>
                      </span>
                    ) : (
                      <Chip tone="success" size="xs">
                        ok
                      </Chip>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

// ─── Code Interpreter Traces ──────────────────────────────────────────────────

const monoStyle: CSSProperties = {
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

const selectStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

function CodeInterpreterTraces({ invocations }: { invocations: Invocation[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedExec, setExpandedExec] = useState<Set<string>>(new Set());

  const traced = invocations.filter((i) => (i.sandboxExecutions?.length ?? 0) > 0);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const toggleExec = (key: string) =>
    setExpandedExec((prev) => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });

  const totalExecs = traced.reduce((n, i) => n + (i.sandboxExecutions?.length ?? 0), 0);

  return (
    <Card padding="md" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Code Interpreter Traces</h2>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          invocations that triggered run_in_sandbox · live ring buffer
        </span>
        {traced.length > 0 && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-primary)',
            }}
          >
            {traced.length} invocation{traced.length !== 1 ? 's' : ''} · {totalExecs} execution
            {totalExecs !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {traced.length === 0 ? (
        <div
          style={{
            padding: '20px 0',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--color-text-tertiary)',
          }}
        >
          No Code Interpreter executions yet. Ask the scoring or graph-builder agent a
          computational question (e.g. "compute PageRank" or "run expertise scoring 5 different
          ways") and executions will appear here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {traced.map((inv) => {
            const isOpen = expanded.has(inv.id);
            const execCount = inv.sandboxExecutions?.length ?? 0;
            return (
              <div
                key={inv.id}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}
              >
                <div
                  onClick={() => toggle(inv.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    cursor: 'pointer',
                    background: isOpen ? 'var(--color-surface-hover)' : 'var(--color-surface)',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {new Date(inv.startedAt).toLocaleTimeString()}
                  </span>
                  <span
                    style={{
                      padding: '1px 7px',
                      borderRadius: 99,
                      fontSize: 11,
                      fontWeight: 600,
                      background: 'var(--color-surface-hover)',
                      color: 'var(--color-primary)',
                    }}
                  >
                    {inv.agentName.replace('orgiq-', '')}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {inv.promptSnippet}
                  </span>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 99,
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      background: 'var(--color-primary)',
                      color: '#fff',
                    }}
                  >
                    {execCount} sandbox run{execCount !== 1 ? 's' : ''}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {(inv.durationMs / 1000).toFixed(1)}s total
                  </span>
                </div>

                {isOpen && (
                  <div
                    style={{
                      borderTop: '1px solid var(--color-border)',
                      background: 'var(--color-bg)',
                    }}
                  >
                    {(inv.sandboxExecutions ?? []).map((exec, idx) => {
                      const execKey = `${inv.id}-${idx}`;
                      const execOpen = expandedExec.has(execKey);
                      return (
                        <div
                          key={execKey}
                          style={{
                            borderBottom:
                              idx < execCount - 1 ? '1px solid var(--color-border)' : undefined,
                          }}
                        >
                          <div
                            onClick={() => toggleExec(execKey)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 14px 8px 28px',
                              cursor: 'pointer',
                              userSelect: 'none',
                              background: execOpen ? 'var(--color-surface)' : 'transparent',
                            }}
                          >
                            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                              {execOpen ? '▾' : '▸'}
                            </span>
                            <span
                              style={{
                                padding: '1px 6px',
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 700,
                                background: exec.error
                                  ? 'var(--color-error-bg, #fee2e2)'
                                  : 'var(--color-success-bg, #dcfce7)',
                                color: exec.error
                                  ? 'var(--color-error, #dc2626)'
                                  : 'var(--color-success, #16a34a)',
                              }}
                            >
                              run {idx + 1}
                            </span>
                            <code
                              style={{
                                fontSize: 11,
                                color: 'var(--color-text-secondary)',
                                flex: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {exec.code
                                .trim()
                                .split('\n')
                                .find((l) => l.trim() && !l.startsWith('#')) ??
                                exec.code.trim().slice(0, 80)}
                            </code>
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--color-text-tertiary)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {exec.durationMs}ms · {exec.sessionId.slice(-8)}
                            </span>
                          </div>

                          {execOpen && (
                            <div
                              style={{
                                padding: '0 14px 12px 28px',
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 10,
                              }}
                            >
                              <div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: 'var(--color-text-tertiary)',
                                    marginBottom: 4,
                                  }}
                                >
                                  INPUT — generated code
                                </div>
                                <pre
                                  style={{
                                    ...monoStyle,
                                    background: 'var(--color-surface)',
                                    border: '1px solid var(--color-border)',
                                    maxHeight: 300,
                                    overflowY: 'auto',
                                  }}
                                >
                                  {exec.code}
                                </pre>
                              </div>
                              <div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: 'var(--color-text-tertiary)',
                                    marginBottom: 4,
                                  }}
                                >
                                  OUTPUT{exec.error ? ' — error' : ''}
                                </div>
                                <pre
                                  style={{
                                    ...monoStyle,
                                    background: exec.error
                                      ? 'var(--color-error-bg, #fee2e2)'
                                      : 'var(--color-bg)',
                                    border: '1px solid var(--color-border)',
                                    color: exec.error
                                      ? 'var(--color-error, #dc2626)'
                                      : 'var(--color-text)',
                                    maxHeight: 300,
                                    overflowY: 'auto',
                                  }}
                                >
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

export default InvocationsPage;
