import { useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip, StatCard } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
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
  // Executions and session termination mutate /api/capabilities (ManageDevbox
  // — sandboxes spend real AWS resources). Reads stay open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
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
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Active Sessions" value={String(active.length)} accent />
          <StatCard label="Sessions (lifetime)" value={String(sessions.length)} />
          <StatCard label="Last Activity" value={lastEverActive ? formatAge(lastEverActive.lastActivityAt) : '—'} />
        </div>

        {canManage && (
        <Card padding="md">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              Run Python{' '}
              <span className="text-[11px] text-text-tertiary font-normal">
                isolated AgentCore sandbox · no network · ~$0.10/hr while running
              </span>
            </h2>
            <button
              onClick={runCode}
              disabled={running || !code.trim()}
              className={`px-[18px] py-1.5 text-xs bg-primary text-white border-none rounded-sm ${running ? 'cursor-wait opacity-60' : 'cursor-pointer opacity-100'}`}
            >
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
          <textarea
            value={code}
            onChange={e => setCode(e.target.value)}
            spellCheck={false}
            className="w-full min-h-40 p-3 text-xs font-mono border border-border rounded-sm bg-surface text-text-primary resize-y outline-none"
          />
          {result && (
            <div className="mt-2.5">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] text-text-tertiary">
                  {result.error ? (
                    <span className="text-danger">Error · {result.durationMs}ms</span>
                  ) : (
                    <>Output · {result.durationMs}ms{result.sessionId ? <> · <code>{result.sessionId}</code></> : null}</>
                  )}
                </div>
                <button
                  onClick={clearResult}
                  className="text-[11px] px-2 py-0.5 bg-transparent border border-border text-text-secondary rounded-sm cursor-pointer"
                >
                  Clear
                </button>
              </div>
              <pre className={`m-0 p-3 text-xs font-mono border border-border rounded-sm whitespace-pre-wrap break-words max-h-[240px] overflow-auto ${result.error ? 'bg-danger-bg text-[#991b1b]' : 'bg-surface-hover text-text-primary'}`}>{result.error ?? result.output}</pre>
            </div>
          )}
        </Card>
        )}

        {active.length > 0 && (
          <Card padding="md">
            <h2 className="text-sm font-semibold mb-3">Active Sessions</h2>
            {active.map(session => (
              <div
                key={session.sessionId}
                className="border border-border rounded-md mb-2.5 overflow-hidden"
              >
                <div
                  onClick={() => setExpanded(expanded === session.sessionId ? null : session.sessionId)}
                  className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer bg-surface-hover"
                >
                  <Chip tone={session.status === 'ACTIVE' ? 'success' : 'neutral'} size="xs">{session.status}</Chip>
                  <span className="font-medium text-[13px]">{session.agentName}</span>
                  <span className="text-[11px] text-text-tertiary flex-1 font-mono">
                    {session.sessionId}
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    Last active {formatAge(session.lastActivityAt)}
                  </span>
                  {canManage && (
                    <button
                      onClick={e => { e.stopPropagation(); terminateSession(session.sessionId); }}
                      className="text-[11px] px-2 py-0.5 bg-transparent border border-danger text-danger rounded-sm cursor-pointer"
                    >
                      Terminate
                    </button>
                  )}
                </div>

                {expanded === session.sessionId && (
                  <div className="px-3.5 py-3 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] font-semibold text-text-tertiary mb-1">LAST EXECUTED CODE</div>
                      <pre className="m-0 text-[11px] bg-surface p-2.5 rounded-sm overflow-auto max-h-[120px]">{session.lastCode || '(no recorded code)'}</pre>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-text-tertiary mb-1">LAST OUTPUT</div>
                      <pre className="m-0 text-[11px] bg-surface p-2.5 rounded-sm overflow-auto max-h-[120px]">{session.lastOutput || '(no recorded output)'}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}

        <Card padding="md">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              Code Execution Traces{' '}
              <span className="text-[11px] font-normal text-text-tertiary">
                every code_execute capability event · in-memory ring (last 50)
              </span>
            </h2>
            <span className="text-[11px] text-text-tertiary">
              {codeEvents.length} event{codeEvents.length === 1 ? '' : 's'}
            </span>
          </div>
          {codeEvents.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-tertiary">
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
                      <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                        {formatAge(ev.startedAt)}
                      </TableTd>
                      <TableTd className="text-[10px] font-mono text-text-tertiary">
                        {ev.sessionId ? (ev.sessionId.length > 18 ? ev.sessionId.slice(0, 14) + '…' : ev.sessionId) : '—'}
                      </TableTd>
                      <TableTd className="text-[11px]">{language}</TableTd>
                      <TableTd className="text-[11px] text-text-tertiary">{ev.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={ev.ok ? 'success' : 'danger'} size="xs">{ev.ok ? 'ok' : 'error'}</Chip>
                      </TableTd>
                      <TableTd>
                        <button
                          onClick={() => setExpandedEvent(isOpen ? null : ev.id)}
                          className="text-[11px] px-2 py-0.5 bg-transparent border border-border text-text-secondary rounded-sm cursor-pointer"
                        >
                          {isOpen ? 'Hide' : 'View'}
                        </button>
                        {isOpen && (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] font-semibold text-text-tertiary mb-1">CODE</div>
                              <pre className="m-0 text-[11px] bg-surface p-2 rounded-sm overflow-auto max-h-[160px] whitespace-pre-wrap">{codeSnippet || '(no snippet)'}</pre>
                            </div>
                            <div>
                              <div className="text-[10px] font-semibold text-text-tertiary mb-1">OUTPUT</div>
                              <pre className={`m-0 text-[11px] p-2 rounded-sm overflow-auto max-h-[160px] whitespace-pre-wrap ${ev.ok ? 'bg-surface text-text-primary' : 'bg-danger-bg text-[#991b1b]'}`}>{ev.error || outputSnippet || '(no output)'}</pre>
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
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              Agent Sandbox Executions{' '}
              <span className="text-[11px] font-normal text-text-tertiary">
                code the agents themselves ran during recent invocations
              </span>
            </h2>
            <span className="text-[11px] text-text-tertiary">
              {agentSandboxRows.length} execution{agentSandboxRows.length === 1 ? '' : 's'}
            </span>
          </div>
          {agentSandboxRows.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-tertiary">
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
                      <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                        {formatAge(exec.timestamp)}
                      </TableTd>
                      <TableTd className="text-xs">{exec.agentName}</TableTd>
                      <TableTd className="text-[10px] font-mono text-text-tertiary">
                        {exec.sessionId ? (exec.sessionId.length > 18 ? exec.sessionId.slice(0, 14) + '…' : exec.sessionId) : '—'}
                      </TableTd>
                      <TableTd className="text-[11px] text-text-tertiary">{exec.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={exec.error ? 'danger' : 'success'} size="xs">{exec.error ? 'error' : 'ok'}</Chip>
                      </TableTd>
                      <TableTd>
                        <button
                          onClick={() => setExpandedExec(isOpen ? null : key)}
                          className="text-[11px] px-2 py-0.5 bg-transparent border border-border text-text-secondary rounded-sm cursor-pointer"
                        >
                          {isOpen ? 'Hide' : 'View'}
                        </button>
                        {isOpen && (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] font-semibold text-text-tertiary mb-1">CODE</div>
                              <pre className="m-0 text-[11px] bg-surface p-2 rounded-sm overflow-auto max-h-[160px] whitespace-pre-wrap">{exec.code || '(no code captured)'}</pre>
                            </div>
                            <div>
                              <div className="text-[10px] font-semibold text-text-tertiary mb-1">OUTPUT</div>
                              <pre className={`m-0 text-[11px] p-2 rounded-sm overflow-auto max-h-[160px] whitespace-pre-wrap ${exec.error ? 'bg-danger-bg text-[#991b1b]' : 'bg-surface text-text-primary'}`}>{exec.error || exec.output || '(no output)'}</pre>
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
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              Past Sessions{' '}
              <span className="text-[11px] font-normal text-text-tertiary">
                from AgentCore Data Plane · code interpreter sessions auto-terminate after execution
              </span>
            </h2>
            <span className="text-[11px] text-text-tertiary">
              {terminated.length} terminated
            </span>
          </div>
          {terminated.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-tertiary">
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
                      <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                        {new Date(s.startedAt).toLocaleString()}
                      </TableTd>
                      <TableTd className="text-[10px] font-mono text-text-tertiary">
                        {s.sessionId.length > 22 ? s.sessionId.slice(0, 16) + '…' : s.sessionId}
                      </TableTd>
                      <TableTd className="text-xs">{s.agentName}</TableTd>
                      <TableTd className="text-[11px] text-text-tertiary">
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
