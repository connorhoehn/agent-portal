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

interface JourneyStep {
  index: number;
  startedAt: string;
  url: string;
  pageTitle: string;
  textSnippet: string;
  imageDataUrl?: string;
  question?: string;
  answer?: string;
}

type BrowserMode = 'qa' | 'journey' | 'sessions';

function BrowserTab() {
  const [mode, setMode] = useState<BrowserMode>('qa');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)' }}>
        {([
          ['qa', '🔎 Web Q&A', 'Ask a question about a webpage'],
          ['journey', '🛤  Journey Recorder', 'Record a multi-step web visit'],
          ['sessions', '⚙ Sessions', 'Raw AgentCore session list'],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            title={hint}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: mode === id ? 600 : 400,
              color: mode === id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              background: 'none',
              border: 'none',
              borderBottom: mode === id ? '2px solid var(--color-primary)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'qa' && <WebQATab />}
      {mode === 'journey' && <JourneyTab />}
      {mode === 'sessions' && <SessionsRawTab />}
    </div>
  );
}

// ── Web Q&A: URL + question → screenshot + Nova Lite answer ────────────────

function WebQATab() {
  const [url, setUrl] = useState('https://example.com');
  const [question, setQuestion] = useState('What is this page about?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; pageTitle: string; imageDataUrl: string | null; answer: string } | null>(null);

  async function ask() {
    if (!url.trim() || !question.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch('/api/capabilities/browser/web-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, question }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setResult(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="md">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Ask a webpage</h2>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Spins up a sandboxed Chrome, screenshots the page, sends it + your question to Nova Lite (multimodal). Returns an answer grounded in the visible content.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://..."
          style={inputStyle()}
        />
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ask()}
          placeholder="What do you want to know about this page?"
          style={inputStyle()}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={ask} disabled={busy || !url || !question} style={primaryBtnStyle(busy || !url || !question)}>
            {busy ? 'Asking…' : 'Ask the page'}
          </button>
        </div>
      </div>

      {error && <div style={errBoxStyle()}>{error}</div>}

      {result && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Screenshot ({result.pageTitle || result.url})
            </div>
            {result.imageDataUrl ? (
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: 4, background: '#fafafa' }}>
                <img src={result.imageDataUrl} alt="page" style={{ width: '100%', display: 'block' }} />
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>(no screenshot)</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Answer
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{result.answer}</div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Journey Recorder: build a sequence of URL visits with carousel + timeline ──

function JourneyTab() {
  const { data: sessionsData, refresh: refreshSessions } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [url, setUrl] = useState('https://example.com');
  const [label, setLabel] = useState('journey');
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'carousel' | 'timeline'>('carousel');
  const [carouselIdx, setCarouselIdx] = useState(0);

  const { data: journeyData, refresh: refreshJourney } = useFetch<{ steps: JourneyStep[] }>(
    activeSessionId ? `/api/capabilities/browser-sessions/${activeSessionId}/journey` : '',
    5000,
  );
  const steps = journeyData?.steps ?? [];

  const openSessions = (sessionsData?.sessions ?? []).filter(s => s.status !== 'CLOSED');

  async function startJourney() {
    setNavigating(true);
    setError(null);
    try {
      const r = await fetch('/api/capabilities/browser-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName: label, url }),
      });
      const body = await r.json();
      if (!r.ok || !body.session?.sessionId) throw new Error(body.error || 'launch failed');
      setActiveSessionId(body.session.sessionId);
      // First step gets a screenshot — call navigate explicitly with capture flag
      // to populate the journey ring (the launch endpoint navigates but doesn't
      // capture into the journey).
      await fetch(`/api/capabilities/browser-sessions/${body.session.sessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, captureScreenshot: true }),
      });
      setCarouselIdx(0);
      refreshJourney();
      refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function stepTo(nextUrl: string) {
    if (!activeSessionId) return;
    setNavigating(true);
    setError(null);
    try {
      const r = await fetch(`/api/capabilities/browser-sessions/${activeSessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: nextUrl, captureScreenshot: true }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || 'navigate failed');
      }
      refreshJourney();
      // Jump carousel to the new step
      setCarouselIdx(steps.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function endJourney() {
    if (!activeSessionId) return;
    await fetch(`/api/capabilities/browser-sessions/${activeSessionId}`, { method: 'DELETE' });
    refreshSessions();
    setActiveSessionId(null);
    setCarouselIdx(0);
  }

  return (
    <Card padding="md">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Journey Recorder</h2>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Record an ordered series of web pages with screenshots. Replay as a carousel or scrollable timeline.
        </div>
      </div>

      {!activeSessionId ? (
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Journey label (e.g. competitor-research)"
              style={inputStyle()}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Starting URL"
                onKeyDown={e => e.key === 'Enter' && startJourney()}
                style={{ ...inputStyle(), flex: 1 }}
              />
              <button onClick={startJourney} disabled={navigating || !url} style={primaryBtnStyle(navigating || !url)}>
                {navigating ? 'Starting…' : 'Start journey'}
              </button>
            </div>
          </div>

          {openSessions.length > 0 && (
            <div style={{ marginTop: 16, padding: 10, background: 'var(--color-surface-hover)', borderRadius: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Or resume an open session
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {openSessions.map(s => (
                  <button
                    key={s.sessionId}
                    onClick={() => { setActiveSessionId(s.sessionId); refreshJourney(); }}
                    style={{
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{s.sessionId}</code>
                    <span style={{ marginLeft: 8, color: 'var(--color-text-tertiary)' }}>{s.agentName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="Next URL"
              onKeyDown={e => e.key === 'Enter' && stepTo(url)}
              style={{ ...inputStyle(), flex: 1 }}
            />
            <button onClick={() => stepTo(url)} disabled={navigating || !url} style={primaryBtnStyle(navigating || !url)}>
              {navigating ? 'Navigating…' : 'Navigate (record)'}
            </button>
            <button onClick={endJourney} style={{ ...primaryBtnStyle(false), background: 'var(--color-danger, #dc2626)' }}>
              End
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {steps.length} step{steps.length !== 1 ? 's' : ''} · session <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{activeSessionId.slice(0, 12)}…</code>
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setView('carousel')} style={tabBtn(view === 'carousel')}>Carousel</button>
              <button onClick={() => setView('timeline')} style={tabBtn(view === 'timeline')}>Timeline</button>
            </div>
          </div>

          {error && <div style={errBoxStyle()}>{error}</div>}

          {steps.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No steps captured yet. Enter a URL above.
            </div>
          ) : view === 'carousel' ? (
            <Carousel steps={steps} idx={Math.min(carouselIdx, steps.length - 1)} onIdx={setCarouselIdx} />
          ) : (
            <Timeline steps={steps} onJump={(i) => { setView('carousel'); setCarouselIdx(i); }} />
          )}
        </div>
      )}
    </Card>
  );
}

function Carousel({ steps, idx, onIdx }: { steps: JourneyStep[]; idx: number; onIdx: (i: number) => void }) {
  const step = steps[idx];
  if (!step) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <button onClick={() => onIdx(Math.max(0, idx - 1))} disabled={idx === 0} style={carouselArrowStyle(idx === 0)}>‹</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{step.pageTitle || step.url}</div>
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', marginTop: 2 }}>{step.url}</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
            Step {idx + 1} of {steps.length} · {new Date(step.startedAt).toLocaleTimeString()}
          </div>
        </div>
        <button onClick={() => onIdx(Math.min(steps.length - 1, idx + 1))} disabled={idx === steps.length - 1} style={carouselArrowStyle(idx === steps.length - 1)}>›</button>
      </div>
      {step.imageDataUrl ? (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: 4, background: '#fafafa' }}>
          <img src={step.imageDataUrl} alt={step.pageTitle} style={{ width: '100%', display: 'block' }} />
        </div>
      ) : (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>(no screenshot)</div>
      )}
      {step.question && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--color-surface-hover)', borderRadius: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Q: {step.question}</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>{step.answer}</div>
        </div>
      )}
      {/* Thumbnail strip */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto', paddingBottom: 4 }}>
        {steps.map((s, i) => (
          <button
            key={s.index}
            onClick={() => onIdx(i)}
            style={{
              flex: '0 0 auto',
              border: i === idx ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
              padding: 0,
              background: 'var(--color-surface)',
              cursor: 'pointer',
              width: 80,
              height: 50,
              overflow: 'hidden',
              borderRadius: 3,
            }}
            title={s.pageTitle || s.url}
          >
            {s.imageDataUrl ? (
              <img src={s.imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{i + 1}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Timeline({ steps, onJump }: { steps: JourneyStep[]; onJump: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflowY: 'auto' }}>
      {steps.map((step, i) => (
        <div
          key={step.index}
          onClick={() => onJump(i)}
          style={{
            display: 'flex',
            gap: 12,
            padding: 8,
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            cursor: 'pointer',
            background: 'var(--color-surface)',
          }}
        >
          <div style={{ flex: '0 0 120px', height: 76, overflow: 'hidden', borderRadius: 3, background: '#fafafa' }}>
            {step.imageDataUrl ? (
              <img src={step.imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 10, color: 'var(--color-text-tertiary)' }}>no shot</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>#{i + 1}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{step.pageTitle || step.url}</span>
            </div>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {step.url}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              {new Date(step.startedAt).toLocaleTimeString()}
            </div>
            {step.question && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any }}>
                <b>Q:</b> {step.question}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Sessions: raw open + closed session lists (admin power-user view) ───────

function SessionsRawTab() {
  const { data, refresh } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [newSessionAgent, setNewSessionAgent] = useState('portal');
  const [newSessionUrl, setNewSessionUrl] = useState('');
  const [launching, setLaunching] = useState(false);

  async function launchSession() {
    if (!newSessionAgent) return;
    setLaunching(true);
    await fetch('/api/capabilities/browser-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: newSessionAgent, url: newSessionUrl || undefined }),
    });
    setNewSessionUrl('');
    setLaunching(false);
    refresh();
  }

  async function closeSession(sessionId: string) {
    await fetch(`/api/capabilities/browser-sessions/${sessionId}`, { method: 'DELETE' });
    refresh();
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
          <input
            placeholder="Session label (any text)"
            value={newSessionAgent}
            onChange={e => setNewSessionAgent(e.target.value)}
            style={{ flex: '0 0 160px', padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
          />
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
          Open Sessions <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>({open.length})</span>
        </h2>
        {open.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            No open browser sessions.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Label</TableTh>
                <TableTh>Status</TableTh>
                <TableTh>Current URL</TableTh>
                <TableTh>Requests</TableTh>
                <TableTh>Last Active</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {open.map(session => (
                <TableRow key={session.sessionId}>
                  <TableTd style={{ fontWeight: 500 }}>{session.agentName}</TableTd>
                  <TableTd><Chip tone={statusTone(session.status)} size="xs">{session.status}</Chip></TableTd>
                  <TableTd style={{ fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.currentUrl === 'about:blank' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : (
                      <a href={session.currentUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                        {session.currentUrl}
                      </a>
                    )}
                  </TableTd>
                  <TableTd>{session.requestCount}</TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{formatAge(session.lastActivityAt)}</TableTd>
                  <TableTd>
                    <button
                      onClick={() => closeSession(session.sessionId)}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                    >
                      Close
                    </button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

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

function inputStyle(): React.CSSProperties {
  return {
    padding: '7px 10px',
    fontSize: 12,
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-surface)',
    outline: 'none',
  };
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 16px',
    fontSize: 12,
    background: 'var(--color-primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontWeight: 500,
  };
}

function errBoxStyle(): React.CSSProperties {
  return {
    padding: 8,
    background: '#fef2f2',
    color: '#991b1b',
    fontSize: 12,
    borderRadius: 4,
    marginBottom: 12,
  };
}

function tabBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: active ? 'var(--color-primary)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-secondary)',
    border: '1px solid ' + (active ? 'var(--color-primary)' : 'var(--color-border)'),
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  };
}

function carouselArrowStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    fontSize: 18,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1,
  };
}

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
