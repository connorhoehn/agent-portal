import { useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip, StatCard } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CodeSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  startedAt: string;
  lastActivityAt: string;
  executionCount: number;
  lastCode: string;
  lastOutput: string;
  memoryUsageMb: number;
}

interface CodeCapabilityEvent {
  id: string;
  kind: 'code_execute';
  startedAt: string;
  durationMs: number;
  sessionId: string;
  detail: Record<string, string | number | boolean | undefined>;
  ok: boolean;
  error?: string;
}

interface SandboxExecutionRow {
  code: string;
  output: string;
  durationMs: number;
  sessionId: string;
  timestamp: string;
  error?: string;
}

interface InvocationWithSandbox {
  id: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  durationMs: number;
  sandboxExecutions?: SandboxExecutionRow[];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CodeInterpreterPage() {
  const { data, refresh } = useFetch<{ sessions: CodeSession[] }>('/api/capabilities/code-sessions', 10000);
  const { data: eventsData } = useFetch<{ events: CodeCapabilityEvent[] }>(
    '/api/observability/capability-events?kind=code_execute&limit=50',
    10000,
  );
  const { data: invData } = useFetch<{ invocations: InvocationWithSandbox[] }>(
    '/api/observability/recent-invocations?limit=50',
    10000,
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [expandedExec, setExpandedExec] = useState<string | null>(null);
  const [code, setCode] = useState<string>(`# Sandbox starts fresh each run — no network, but has numpy/pandas.
import statistics
nums = [12, 47, 23, 91, 56, 34, 78, 19, 65, 88]
print(f"mean={statistics.mean(nums):.2f}, stdev={statistics.stdev(nums):.2f}")`);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ output: string; durationMs: number; sessionId: string; error?: string } | null>(null);

  async function runCode() {
    setRunning(true);
    // NB: don't clear result here — keep the previous output visible while we
    // wait so the panel doesn't flicker / appear to vanish between runs.
    try {
      const r = await fetch('/api/capabilities/code-interpreter/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: 'python' }),
      });
      const body = await r.json();
      setResult(body);
    } catch (e) {
      setResult({ output: '', durationMs: 0, sessionId: '', error: (e as Error).message });
    } finally {
      setRunning(false);
      // We don't refresh() the sessions list here — the 10s poll picks it up
      // naturally, and a fast refresh just re-renders the Active Sessions
      // card right under the result, pushing it off-screen.
    }
  }

  function clearResult() {
    setResult(null);
  }

  async function terminateSession(sessionId: string) {
    await fetch(`/api/capabilities/code-sessions/${sessionId}`, { method: 'DELETE' });
    refresh();
  }

  const sessions = data?.sessions ?? [];
  const active = sessions.filter(s => s.status !== 'TERMINATED');
  const terminated = sessions
    .filter(s => s.status === 'TERMINATED')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const lastEverActive = sessions.length > 0
    ? sessions.slice().sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
    : null;

  const codeEvents = eventsData?.events ?? [];
  // Flatten agent invocations → individual sandbox executions. Each invocation
  // can carry multiple sandboxExecutions; tag each with its parent agent so the
  // table can show "which agent ran what".
  const agentSandboxRows: Array<SandboxExecutionRow & { invocationId: string; agentName: string }> = [];
  for (const inv of invData?.invocations ?? []) {
    for (const exec of inv.sandboxExecutions ?? []) {
      agentSandboxRows.push({ ...exec, invocationId: inv.id, agentName: inv.agentName });
    }
  }

  return (
    <PageSection
      title="Code Interpreter"
      description="Run Python in isolated AgentCore sandboxes. Every execution is captured for replay."
    >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <StatCard label="Active Sessions" value={String(active.length)} accent />
          <StatCard label="Sessions (lifetime)" value={String(sessions.length)} />
          <StatCard label="Last Activity" value={lastEverActive ? formatAge(lastEverActive.lastActivityAt) : '—'} />
        </div>

        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Run Python{' '}
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
                isolated AgentCore sandbox · no network · ~$0.10/hr while running
              </span>
            </h2>
            <button
              onClick={runCode}
              disabled={running || !code.trim()}
              style={{ padding: '6px 18px', fontSize: 12, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: running ? 'wait' : 'pointer', opacity: running ? 0.6 : 1 }}
            >
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
          <textarea
            value={code}
            onChange={e => setCode(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 160, padding: 12, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface)', color: 'var(--color-text-primary)', resize: 'vertical', outline: 'none',
            }}
          />
          {result && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  {result.error ? (
                    <span style={{ color: 'var(--color-danger, #dc2626)' }}>Error · {result.durationMs}ms</span>
                  ) : (
                    <>Output · {result.durationMs}ms{result.sessionId ? <> · <code>{result.sessionId}</code></> : null}</>
                  )}
                </div>
                <button
                  onClick={clearResult}
                  style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
              <pre style={{
                margin: 0, padding: 12, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                background: result.error ? '#fef2f2' : 'var(--color-surface-hover)',
                color: result.error ? '#991b1b' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
              }}>{result.error ?? result.output}</pre>
            </div>
          )}
        </Card>

        {active.length > 0 && (
          <Card padding="md">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Active Sessions</h2>
            {active.map(session => (
              <div
                key={session.sessionId}
                style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', marginBottom: 10, overflow: 'hidden' }}
              >
                <div
                  onClick={() => setExpanded(expanded === session.sessionId ? null : session.sessionId)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', background: 'var(--color-surface-hover)' }}
                >
                  <Chip tone={session.status === 'ACTIVE' ? 'success' : 'neutral'} size="xs">{session.status}</Chip>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{session.agentName}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: 1, fontFamily: 'monospace' }}>
                    {session.sessionId}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    Last active {formatAge(session.lastActivityAt)}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); terminateSession(session.sessionId); }}
                    style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                  >
                    Terminate
                  </button>
                </div>

                {expanded === session.sessionId && (
                  <div style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>LAST EXECUTED CODE</div>
                      <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 10, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 120 }}>{session.lastCode || '(no recorded code)'}</pre>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>LAST OUTPUT</div>
                      <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 10, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 120 }}>{session.lastOutput || '(no recorded output)'}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}

        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Code Execution Traces{' '}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
                every code_execute capability event · in-memory ring (last 50)
              </span>
            </h2>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {codeEvents.length} event{codeEvents.length === 1 ? '' : 's'}
            </span>
          </div>
          {codeEvents.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No code executions recorded yet. Use the Run Python panel above or invoke an agent that calls the sandbox.
            </div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>When</TableTh>
                  <TableTh>Session</TableTh>
                  <TableTh>Language</TableTh>
                  <TableTh>Duration</TableTh>
                  <TableTh>Status</TableTh>
                  <TableTh>Code / Output</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {codeEvents.map(ev => {
                  const isOpen = expandedEvent === ev.id;
                  const codeSnippet = String(ev.detail['codeSnippet'] ?? '');
                  const outputSnippet = String(ev.detail['outputSnippet'] ?? '');
                  const language = String(ev.detail['language'] ?? 'python');
                  return (
                    <TableRow key={ev.id}>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                        {formatAge(ev.startedAt)}
                      </TableTd>
                      <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                        {ev.sessionId ? (ev.sessionId.length > 18 ? ev.sessionId.slice(0, 14) + '…' : ev.sessionId) : '—'}
                      </TableTd>
                      <TableTd style={{ fontSize: 11 }}>{language}</TableTd>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{ev.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={ev.ok ? 'success' : 'danger'} size="xs">{ev.ok ? 'ok' : 'error'}</Chip>
                      </TableTd>
                      <TableTd>
                        <button
                          onClick={() => setExpandedEvent(isOpen ? null : ev.id)}
                          style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                        >
                          {isOpen ? 'Hide' : 'View'}
                        </button>
                        {isOpen && (
                          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>CODE</div>
                              <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 8, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap' }}>{codeSnippet || '(no snippet)'}</pre>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>OUTPUT</div>
                              <pre style={{ margin: 0, fontSize: 11, background: ev.ok ? 'var(--color-surface)' : '#fef2f2', color: ev.ok ? 'var(--color-text-primary)' : '#991b1b', padding: 8, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap' }}>{ev.error || outputSnippet || '(no output)'}</pre>
                            </div>
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

        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Agent Sandbox Executions{' '}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
                code the agents themselves ran during recent invocations
              </span>
            </h2>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {agentSandboxRows.length} execution{agentSandboxRows.length === 1 ? '' : 's'}
            </span>
          </div>
          {agentSandboxRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No agent-driven sandbox executions in the last 50 invocations.
            </div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>When</TableTh>
                  <TableTh>Agent</TableTh>
                  <TableTh>Session</TableTh>
                  <TableTh>Duration</TableTh>
                  <TableTh>Status</TableTh>
                  <TableTh>Code / Output</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {agentSandboxRows.map((exec, i) => {
                  const key = `${exec.invocationId}-${i}`;
                  const isOpen = expandedExec === key;
                  return (
                    <TableRow key={key}>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                        {formatAge(exec.timestamp)}
                      </TableTd>
                      <TableTd style={{ fontSize: 12 }}>{exec.agentName}</TableTd>
                      <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                        {exec.sessionId ? (exec.sessionId.length > 18 ? exec.sessionId.slice(0, 14) + '…' : exec.sessionId) : '—'}
                      </TableTd>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{exec.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={exec.error ? 'danger' : 'success'} size="xs">{exec.error ? 'error' : 'ok'}</Chip>
                      </TableTd>
                      <TableTd>
                        <button
                          onClick={() => setExpandedExec(isOpen ? null : key)}
                          style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                        >
                          {isOpen ? 'Hide' : 'View'}
                        </button>
                        {isOpen && (
                          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>CODE</div>
                              <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 8, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap' }}>{exec.code || '(no code captured)'}</pre>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>OUTPUT</div>
                              <pre style={{ margin: 0, fontSize: 11, background: exec.error ? '#fef2f2' : 'var(--color-surface)', color: exec.error ? '#991b1b' : 'var(--color-text-primary)', padding: 8, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap' }}>{exec.error || exec.output || '(no output)'}</pre>
                            </div>
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

        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Past Sessions{' '}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
                from AgentCore Data Plane · code interpreter sessions auto-terminate after execution
              </span>
            </h2>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {terminated.length} terminated
            </span>
          </div>
          {terminated.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No past sessions yet. Run code above or invoke the scoring agent to trigger one.
            </div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Started</TableTh>
                  <TableTh>Session</TableTh>
                  <TableTh>Name</TableTh>
                  <TableTh>Duration</TableTh>
                  <TableTh>Status</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {terminated.slice(0, 20).map(s => {
                  const dur = new Date(s.lastActivityAt).getTime() - new Date(s.startedAt).getTime();
                  return (
                    <TableRow key={s.sessionId}>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                        {new Date(s.startedAt).toLocaleString()}
                      </TableTd>
                      <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                        {s.sessionId.length > 22 ? s.sessionId.slice(0, 16) + '…' : s.sessionId}
                      </TableTd>
                      <TableTd style={{ fontSize: 12 }}>{s.agentName}</TableTd>
                      <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        {dur > 0 ? `${(dur / 1000).toFixed(1)}s` : '—'}
                      </TableTd>
                      <TableTd><Chip tone="neutral" size="xs">{s.status}</Chip></TableTd>
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

// ─── Local helpers ────────────────────────────────────────────────────────────

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default CodeInterpreterPage;
