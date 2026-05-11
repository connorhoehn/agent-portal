import { useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PiiFilter {
  type: string;
  action: 'ANONYMIZE' | 'BLOCK';
  enabled: boolean;
}

interface DeniedTopic {
  name: string;
  definition: string;
  enabled: boolean;
}

interface Guardrail {
  id: string;
  name: string;
  status: string;
  version: string;
  updatedAt: string;
  piiFilters: PiiFilter[];
  contentPolicy: Record<string, boolean>;
  deniedTopics: DeniedTopic[];
  groundingThreshold: number;
  relevanceThreshold: number;
}

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

interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'guardrails' | 'code-interpreter' | 'browser';

function CapabilitiesPage() {
  const [tab, setTab] = useState<Tab>('guardrails');

  return (
    <PageSection title="Capabilities">
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--color-border)', paddingBottom: 0 }}>
        {(['guardrails', 'code-interpreter', 'browser'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--color-primary)' : '2px solid transparent',
              color: tab === t ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              fontWeight: tab === t ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: -1,
              textTransform: 'capitalize',
            }}
          >
            {t === 'code-interpreter' ? 'Code Interpreter' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'guardrails' && <GuardrailsTab />}
      {tab === 'code-interpreter' && <CodeInterpreterTab />}
      {tab === 'browser' && <BrowserTab />}
    </PageSection>
  );
}

// ─── Guardrails Tab ───────────────────────────────────────────────────────────

interface GuardrailMetrics {
  totalInvocations: number;
  totalInterventions: number;
  interventionRate: string;
  series: Array<{ timestamp: string; invocations: number; interventions: number }>;
}

function GuardrailsTab() {
  const { data: guardrail, refresh } = useFetch<Guardrail>('/api/capabilities/guardrail', 30000);
  const { data: metrics } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=6', 60000);
  const [newTopic, setNewTopic] = useState({ name: '', definition: '' });
  const [addingTopic, setAddingTopic] = useState(false);
  const [saving, setSaving] = useState(false);

  async function togglePii(type: string, enabled: boolean) {
    await fetch(`/api/capabilities/guardrail/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, enabled }),
    });
    refresh();
  }

  async function toggleTopic(name: string, enabled: boolean) {
    await fetch(`/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  async function removeTopic(name: string) {
    if (!confirm(`Delete denied topic "${name}"? This persists to AWS immediately.`)) return;
    await fetch(`/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    refresh();
  }

  async function addTopic() {
    if (!newTopic.name || !newTopic.definition) return;
    setSaving(true);
    await fetch('/api/capabilities/guardrail/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTopic),
    });
    setNewTopic({ name: '', definition: '' });
    setAddingTopic(false);
    setSaving(false);
    refresh();
  }

  if (!guardrail) return <div style={{ color: 'var(--color-text-secondary)', padding: 24 }}>Loading guardrail...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Status bar */}
      <Card padding="md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontWeight: 600 }}>{guardrail.name}</span>
            <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              v{guardrail.version} · Updated {new Date(guardrail.updatedAt).toLocaleString()}
            </span>
          </div>
          <Chip tone={guardrail.status === 'READY' ? 'success' : 'warning'} size="xs">{guardrail.status}</Chip>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>GROUNDING THRESHOLD</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{(guardrail.groundingThreshold * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>RELEVANCE THRESHOLD</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{(guardrail.relevanceThreshold * 100).toFixed(0)}%</div>
          </div>
        </div>
      </Card>

      {/* Metrics — last 24h */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Activity (last 6h){' '}
          <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            from AWS/Bedrock metrics
          </span>
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>INVOCATIONS</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.totalInvocations ?? 0}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>INTERVENTIONS</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.totalInterventions ?? 0}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>RATE</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.interventionRate ?? '0.0'}%</div>
          </div>
        </div>
        <MetricsSparkline series={metrics?.series ?? []} />
      </Card>

      {/* PII Filters */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>PII Filters</h2>
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Type</TableTh>
              <TableTh>Action</TableTh>
              <TableTh>Enabled</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {guardrail.piiFilters.map(filter => (
              <TableRow key={filter.type}>
                <TableTd style={{ fontWeight: 500 }}>{filter.type}</TableTd>
                <TableTd>
                  <Chip tone={filter.action === 'BLOCK' ? 'danger' : 'warning'} size="xs">{filter.action}</Chip>
                </TableTd>
                <TableTd>
                  <Toggle value={filter.enabled} onChange={v => togglePii(filter.type, v)} />
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Content Policy */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Content Policy</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(guardrail.contentPolicy).map(([key, enabled]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)', flexShrink: 0 }} />
              <span style={{ fontSize: 12 }}>{key.replace('Enabled', '')}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Denied Topics */}
      <Card padding="md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>Denied Topics</h2>
          <button
            onClick={() => setAddingTopic(v => !v)}
            style={{ fontSize: 12, padding: '4px 10px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
          >
            + Add Topic
          </button>
        </div>

        {addingTopic && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, padding: 12, background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-md)' }}>
            <input
              placeholder="Topic name"
              value={newTopic.name}
              onChange={e => setNewTopic(p => ({ ...p, name: e.target.value }))}
              style={{ flex: '0 0 160px', padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
            />
            <input
              placeholder="Definition / description"
              value={newTopic.definition}
              onChange={e => setNewTopic(p => ({ ...p, definition: e.target.value }))}
              style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
            />
            <button
              onClick={addTopic}
              disabled={saving}
              style={{ padding: '6px 12px', fontSize: 12, background: 'var(--color-success)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
            >
              Save
            </button>
          </div>
        )}

        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Topic</TableTh>
              <TableTh>Definition</TableTh>
              <TableTh>Enabled</TableTh>
              <TableTh></TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {guardrail.deniedTopics.map(topic => (
              <TableRow key={topic.name}>
                <TableTd style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{topic.name}</TableTd>
                <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{topic.definition}</TableTd>
                <TableTd>
                  <Toggle value={topic.enabled} onChange={v => toggleTopic(topic.name, v)} />
                </TableTd>
                <TableTd>
                  <button
                    onClick={() => removeTopic(topic.name)}
                    aria-label={`Remove ${topic.name}`}
                    style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ─── Code Interpreter Tab ─────────────────────────────────────────────────────

function CodeInterpreterTab() {
  const { data, refresh } = useFetch<{ sessions: CodeSession[] }>('/api/capabilities/code-sessions', 10000);
  const [expanded, setExpanded] = useState<string | null>(null);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <Chip tone={session.status === 'ACTIVE' ? 'success' : 'default'} size="xs">{session.status}</Chip>
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
                    <TableTd><Chip tone="default" size="xs">{s.status}</Chip></TableTd>
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

// ─── Browser Tab ──────────────────────────────────────────────────────────────

function BrowserTab() {
  const { data, refresh } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [newSessionAgent, setNewSessionAgent] = useState('');
  const [newSessionUrl, setNewSessionUrl] = useState('');
  const [launching, setLaunching] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [navUrl, setNavUrl] = useState('https://example.com');
  const [navigating, setNavigating] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotting, setScreenshotting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function closeSession(sessionId: string) {
    await fetch(`/api/capabilities/browser-sessions/${sessionId}`, { method: 'DELETE' });
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
      setScreenshotDataUrl(null);
    }
    refresh();
  }

  async function launchSession() {
    if (!newSessionAgent) return;
    setLaunching(true);
    await fetch('/api/capabilities/browser-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: newSessionAgent, url: newSessionUrl || undefined }),
    });
    setNewSessionAgent('');
    setNewSessionUrl('');
    setLaunching(false);
    refresh();
  }

  async function navigate() {
    if (!selectedSessionId || !navUrl) return;
    setNavigating(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/capabilities/browser-sessions/${selectedSessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: navUrl }),
      });
      if (!r.ok) {
        const body = await r.text();
        setActionError(`Navigate failed: ${body}`);
      } else {
        // Auto-screenshot after navigate so the user sees the page
        await screenshot();
      }
    } catch (e) {
      setActionError(`Navigate error: ${(e as Error).message}`);
    } finally {
      setNavigating(false);
      refresh();
    }
  }

  async function screenshot() {
    if (!selectedSessionId) return;
    setScreenshotting(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/capabilities/browser-sessions/${selectedSessionId}/screenshot`, {
        method: 'POST',
      });
      if (!r.ok) {
        const body = await r.text();
        setActionError(`Screenshot failed: ${body}`);
      } else {
        const body = await r.json();
        setScreenshotDataUrl(body.imageDataUrl ?? null);
      }
    } catch (e) {
      setActionError(`Screenshot error: ${(e as Error).message}`);
    } finally {
      setScreenshotting(false);
    }
  }

  const sessions = data?.sessions ?? [];
  const open = sessions.filter(s => s.status !== 'CLOSED');
  const closed = sessions
    .filter(s => s.status === 'CLOSED')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const statusTone = (s: BrowserSession['status']): 'success' | 'warning' | 'default' =>
    s === 'ACTIVE' ? 'success' : s === 'IDLE' ? 'warning' : 'default';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Launch new session */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Launch Browser Session</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={newSessionAgent}
            onChange={e => setNewSessionAgent(e.target.value)}
            style={{ flex: '0 0 160px', padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
          >
            <option value="">Select agent…</option>
            {['supervisor', 'search', 'advisor'].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <input
            placeholder="Starting URL (optional)"
            value={newSessionUrl}
            onChange={e => setNewSessionUrl(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
          />
          <button
            onClick={launchSession}
            disabled={!newSessionAgent || launching}
            style={{ padding: '7px 16px', fontSize: 12, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: !newSessionAgent ? 0.5 : 1 }}
          >
            {launching ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </Card>

      {/* Active sessions */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Sessions <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>({open.length} open)</span>
        </h2>
        {open.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            No open browser sessions.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Status</TableTh>
                <TableTh>Current URL</TableTh>
                <TableTh>Requests</TableTh>
                <TableTh>Last Active</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {open.map(session => {
                const isSelected = session.sessionId === selectedSessionId;
                return (
                  <TableRow
                    key={session.sessionId}
                    onClick={() => {
                      setSelectedSessionId(session.sessionId);
                      setScreenshotDataUrl(null);
                      setActionError(null);
                    }}
                    style={{
                      cursor: 'pointer',
                      background: isSelected ? 'var(--color-surface-hover, #f3f4f6)' : undefined,
                    } as any}
                  >
                    <TableTd style={{ fontWeight: 500 }}>{session.agentName}</TableTd>
                    <TableTd><Chip tone={statusTone(session.status)} size="xs">{session.status}</Chip></TableTd>
                    <TableTd style={{ fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {session.currentUrl === 'about:blank' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : (
                        <a href={session.currentUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                          {session.currentUrl}
                        </a>
                      )}
                    </TableTd>
                    <TableTd>{session.requestCount}</TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{formatAge(session.lastActivityAt)}</TableTd>
                    <TableTd>
                      <button
                        onClick={(e) => { e.stopPropagation(); closeSession(session.sessionId); }}
                        style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                      >
                        Close
                      </button>
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Interact with selected session */}
      {selectedSessionId && (
        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Interact — <code style={{ fontFamily: 'monospace', fontSize: 12 }}>{selectedSessionId}</code></h2>
            <button
              onClick={() => { setSelectedSessionId(null); setScreenshotDataUrl(null); setActionError(null); }}
              style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
            >
              Done
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              value={navUrl}
              onChange={e => setNavUrl(e.target.value)}
              placeholder="https://..."
              onKeyDown={e => e.key === 'Enter' && navigate()}
              style={{ flex: 1, padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
            />
            <button
              onClick={navigate}
              disabled={navigating || !navUrl}
              style={{ padding: '7px 16px', fontSize: 12, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: navigating ? 0.6 : 1 }}
            >
              {navigating ? 'Navigating…' : 'Navigate'}
            </button>
            <button
              onClick={screenshot}
              disabled={screenshotting}
              style={{ padding: '7px 16px', fontSize: 12, background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: screenshotting ? 0.6 : 1 }}
            >
              {screenshotting ? 'Capturing…' : 'Screenshot'}
            </button>
          </div>

          {actionError && (
            <div style={{ padding: 8, background: '#fef2f2', color: '#991b1b', fontSize: 12, borderRadius: 4, marginBottom: 12 }}>
              {actionError}
            </div>
          )}

          {screenshotDataUrl && (
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: 4, background: '#fafafa' }}>
              <img src={screenshotDataUrl} alt="Browser screenshot" style={{ maxWidth: '100%', display: 'block' }} />
            </div>
          )}
        </Card>
      )}

      {/* Past sessions */}
      <Card padding="md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Past Sessions{' '}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
              from AgentCore Data Plane
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {closed.length} closed
          </span>
        </div>
        {closed.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No past sessions yet. Launch one above or invoke the search agent with a Browse-the-web prompt.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Started</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Last URL</TableTh>
                <TableTh>Requests</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {closed.slice(0, 20).map(s => (
                <TableRow key={s.sessionId}>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {new Date(s.startedAt).toLocaleString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12 }}>{s.agentName}</TableTd>
                  <TableTd style={{ fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.currentUrl}>
                    {s.currentUrl === 'about:blank' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : s.currentUrl}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{s.requestCount}</TableTd>
                  <TableTd><Chip tone="default" size="xs">{s.status}</Chip></TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0, position: 'relative',
        background: value ? 'var(--color-success, #16a34a)' : 'var(--color-border, #e2e8f0)',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: value ? 19 : 3, width: 14, height: 14,
        borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
      }} />
    </button>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: accent ? 'var(--color-success)' : undefined }}>
        {value}
      </div>
    </Card>
  );
}

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function MetricsSparkline({ series }: { series: Array<{ timestamp: string; invocations: number; interventions: number }> }) {
  const width = 600;
  const height = 80;
  const padding = 4;
  const maxVal = Math.max(1, ...series.map(p => Math.max(p.invocations, p.interventions)));
  const points = (key: 'invocations' | 'interventions') =>
    series.map((p, i) => {
      const x = padding + (i / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - (p[key] / maxVal) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

  if (series.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 20, color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        No metrics yet — guardrail hasn't been invoked recently.
      </div>
    );
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 80, display: 'block' }}>
        <polyline fill="none" stroke="var(--color-primary, #6366f1)" strokeWidth="1.5" points={points('invocations')} />
        <polyline fill="none" stroke="#dc2626" strokeWidth="1.5" points={points('interventions')} />
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 2, background: 'var(--color-primary, #6366f1)', marginRight: 4, verticalAlign: 'middle' }} />invocations</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#dc2626', marginRight: 4, verticalAlign: 'middle' }} />interventions</span>
      </div>
    </div>
  );
}

export default CapabilitiesPage;
