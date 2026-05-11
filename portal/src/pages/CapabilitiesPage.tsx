import { useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components';
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

function GuardrailsTab() {
  const { data: guardrail, refresh } = useFetch<Guardrail>('/api/capabilities/guardrail', 30000);
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

  async function terminateSession(sessionId: string) {
    await fetch(`/api/capabilities/code-sessions/${sessionId}`, { method: 'DELETE' });
    refresh();
  }

  const sessions = data?.sessions ?? [];
  const active = sessions.filter(s => s.status !== 'TERMINATED');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <StatCard label="Active Sessions" value={String(sessions.filter(s => s.status === 'ACTIVE').length)} accent />
        <StatCard label="Idle Sessions" value={String(sessions.filter(s => s.status === 'IDLE').length)} />
        <StatCard label="Total Executions" value={String(sessions.reduce((a, s) => a + s.executionCount, 0))} />
      </div>

      {active.length === 0 ? (
        <Card padding="md">
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            No active code interpreter sessions. Sessions start automatically when graph-builder or scoring agents need code execution.
          </div>
        </Card>
      ) : (
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
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: 1 }}>
                  {session.sessionId} · {session.executionCount} executions · {session.memoryUsageMb}MB
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
                    <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 10, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 120 }}>{session.lastCode}</pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>LAST OUTPUT</div>
                    <pre style={{ margin: 0, fontSize: 11, background: 'var(--color-surface)', padding: 10, borderRadius: 'var(--radius-sm)', overflow: 'auto', maxHeight: 120 }}>{session.lastOutput}</pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Browser Tab ──────────────────────────────────────────────────────────────

function BrowserTab() {
  const { data, refresh } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [newSessionAgent, setNewSessionAgent] = useState('');
  const [newSessionUrl, setNewSessionUrl] = useState('');
  const [launching, setLaunching] = useState(false);

  async function closeSession(sessionId: string) {
    await fetch(`/api/capabilities/browser-sessions/${sessionId}`, { method: 'DELETE' });
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

  const sessions = data?.sessions ?? [];
  const open = sessions.filter(s => s.status !== 'CLOSED');

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

export default CapabilitiesPage;
