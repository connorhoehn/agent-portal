import { Fragment, useState } from 'react';
import {
  Button,
  CardHeader,
  Card,
  CatalogGrid,
  Chip,
  CodeBlock,
  CollapsibleSection,
  InlineAlert,
  InlinePlaceholder,
  MetaLine,
  PageSection,
  SectionLabel,
  Stack,
  StatStrip,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTh,
  TableTd,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { T } from './Text';

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
      <StatStrip
        className="mb-4"
        items={[
          { label: 'Active Sessions', value: active.length, tone: 'accent' },
          { label: 'Sessions (lifetime)', value: sessions.length },
          { label: 'Last Activity', value: lastEverActive ? formatAge(lastEverActive.lastActivityAt) : '—' },
        ]}
      />

      {canManage && (
        <Card padding="none" className="mb-4 overflow-hidden">
          <CardHeader
            title="Run Python"
            subtitle="isolated AgentCore sandbox · no network · ~$0.10/hr while running"
            action={(
              <Button variant="primary" size="sm" onClick={runCode} disabled={running || !code.trim()}>
                {running ? 'Running…' : 'Run'}
              </Button>
            )}
          />
          <Stack gap="sm" className="px-3.5 py-3">
            <Textarea
              value={code}
              onChange={e => setCode(e.target.value)}
              spellCheck={false}
              minRows={6}
              autoResize
              className="font-mono text-xs"
            />
            {result && (
              <Stack gap="xs">
                <MetaLine
                  items={[
                    result.error
                      ? <T className="text-danger">Error · {result.durationMs}ms</T>
                      : <>Output · {result.durationMs}ms{result.sessionId ? <> · <T className="font-mono">{result.sessionId}</T></> : null}</>,
                  ]}
                />
                {result.error ? (
                  <InlineAlert tone="error">{result.error}</InlineAlert>
                ) : (
                  <CodeBlock code={result.output || '(no output)'} language="text" theme="light" />
                )}
                <Button variant="ghost" size="sm" onClick={clearResult}>Clear</Button>
              </Stack>
            )}
          </Stack>
        </Card>
      )}

      {active.length > 0 && (
        <Card padding="md" className="mb-4">
          <SectionLabel as="div" className="mb-3">Active Sessions</SectionLabel>
          <Stack gap="sm">
            {active.map(session => (
              <CollapsibleSection
                key={session.sessionId}
                title={(
                  <MetaLine
                    items={[
                      <Chip tone={session.status === 'ACTIVE' ? 'success' : 'neutral'} size="xs">{session.status}</Chip>,
                      <T className="text-[13px] font-medium">{session.agentName}</T>,
                      <T className="font-mono text-[11px] text-text-tertiary">{session.sessionId}</T>,
                      <T className="text-[11px] text-text-tertiary">Last active {formatAge(session.lastActivityAt)}</T>,
                    ]}
                  />
                )}
                badge={canManage && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); terminateSession(session.sessionId); }}
                  >
                    Terminate
                  </Button>
                )}
              >
                <CatalogGrid columns={2} dense>
                  <Stack gap="xs">
                    <SectionLabel>Last executed code</SectionLabel>
                    <CodeBlock code={session.lastCode || '(no recorded code)'} language="text" theme="light" />
                  </Stack>
                  <Stack gap="xs">
                    <SectionLabel>Last output</SectionLabel>
                    <CodeBlock code={session.lastOutput || '(no recorded output)'} language="text" theme="light" />
                  </Stack>
                </CatalogGrid>
              </CollapsibleSection>
            ))}
          </Stack>
        </Card>
      )}

      <Card padding="none" className="mb-4 overflow-hidden">
        <CardHeader
          title="Code Execution Traces"
          subtitle="every code_execute capability event · in-memory ring (last 50)"
          action={<T className="text-[11px] text-text-tertiary">{codeEvents.length} event{codeEvents.length === 1 ? '' : 's'}</T>}
        />
        {codeEvents.length === 0 ? (
          <InlinePlaceholder size="sm" align="center" className="px-3.5 py-6">
            No code executions recorded yet. Use the Run Python panel above or invoke an agent that calls the sandbox.
          </InlinePlaceholder>
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
                  <Fragment key={ev.id}>
                    <TableRow>
                      <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                        {formatAge(ev.startedAt)}
                      </TableTd>
                      <TableTd className="font-mono text-[10px] text-text-tertiary">
                        {ev.sessionId ? (ev.sessionId.length > 18 ? ev.sessionId.slice(0, 14) + '…' : ev.sessionId) : '—'}
                      </TableTd>
                      <TableTd className="text-[11px]">{language}</TableTd>
                      <TableTd className="text-[11px] text-text-tertiary">{ev.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={ev.ok ? 'success' : 'danger'} size="xs">{ev.ok ? 'ok' : 'error'}</Chip>
                      </TableTd>
                      <TableTd>
                        <Button variant="ghost" size="sm" onClick={() => setExpandedEvent(isOpen ? null : ev.id)}>
                          {isOpen ? 'Hide' : 'View'}
                        </Button>
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableTd colSpan={6}>
                          <CatalogGrid columns={2} dense>
                            <Stack gap="xs">
                              <SectionLabel>Code</SectionLabel>
                              <CodeBlock code={codeSnippet || '(no snippet)'} language="text" theme="light" />
                            </Stack>
                            <Stack gap="xs">
                              <SectionLabel>Output</SectionLabel>
                              {ev.error ? (
                                <InlineAlert tone="error">{ev.error}</InlineAlert>
                              ) : (
                                <CodeBlock code={outputSnippet || '(no output)'} language="text" theme="light" />
                              )}
                            </Stack>
                          </CatalogGrid>
                        </TableTd>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="none" className="mb-4 overflow-hidden">
        <CardHeader
          title="Agent Sandbox Executions"
          subtitle="code the agents themselves ran during recent invocations"
          action={<T className="text-[11px] text-text-tertiary">{agentSandboxRows.length} execution{agentSandboxRows.length === 1 ? '' : 's'}</T>}
        />
        {agentSandboxRows.length === 0 ? (
          <InlinePlaceholder size="sm" align="center" className="px-3.5 py-6">
            No agent-driven sandbox executions in the last 50 invocations.
          </InlinePlaceholder>
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
                  <Fragment key={key}>
                    <TableRow>
                      <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                        {formatAge(exec.timestamp)}
                      </TableTd>
                      <TableTd className="text-xs">{exec.agentName}</TableTd>
                      <TableTd className="font-mono text-[10px] text-text-tertiary">
                        {exec.sessionId ? (exec.sessionId.length > 18 ? exec.sessionId.slice(0, 14) + '…' : exec.sessionId) : '—'}
                      </TableTd>
                      <TableTd className="text-[11px] text-text-tertiary">{exec.durationMs}ms</TableTd>
                      <TableTd>
                        <Chip tone={exec.error ? 'danger' : 'success'} size="xs">{exec.error ? 'error' : 'ok'}</Chip>
                      </TableTd>
                      <TableTd>
                        <Button variant="ghost" size="sm" onClick={() => setExpandedExec(isOpen ? null : key)}>
                          {isOpen ? 'Hide' : 'View'}
                        </Button>
                      </TableTd>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableTd colSpan={6}>
                          <CatalogGrid columns={2} dense>
                            <Stack gap="xs">
                              <SectionLabel>Code</SectionLabel>
                              <CodeBlock code={exec.code || '(no code captured)'} language="text" theme="light" />
                            </Stack>
                            <Stack gap="xs">
                              <SectionLabel>Output</SectionLabel>
                              {exec.error ? (
                                <InlineAlert tone="error">{exec.error}</InlineAlert>
                              ) : (
                                <CodeBlock code={exec.output || '(no output)'} language="text" theme="light" />
                              )}
                            </Stack>
                          </CatalogGrid>
                        </TableTd>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="none" className="overflow-hidden">
        <CardHeader
          title="Past Sessions"
          subtitle="from AgentCore Data Plane · code interpreter sessions auto-terminate after execution"
          action={<T className="text-[11px] text-text-tertiary">{terminated.length} terminated</T>}
        />
        {terminated.length === 0 ? (
          <InlinePlaceholder size="sm" align="center" className="px-3.5 py-6">
            No past sessions yet. Run code above or invoke the scoring agent to trigger one.
          </InlinePlaceholder>
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
                    <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                      {new Date(s.startedAt).toLocaleString()}
                    </TableTd>
                    <TableTd className="font-mono text-[10px] text-text-tertiary">
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
