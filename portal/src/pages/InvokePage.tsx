import { useEffect, useState } from 'react';
import { useAgUiStream } from '../hooks/useAgUiStream';
import { useFetch } from '../hooks/useFetch';

interface AgentDef {
  id: string;
  name: string;
  status: string;
  protocol: string;
  model: string;
  tools: string[];
}

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
}

interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
}

function InvokePage() {
  const { data: agents } = useFetch<AgentDef[]>('/api/agents');
  const [selectedId, setSelectedId] = useState('orgiq-supervisor');
  const {
    messages,
    isStreaming,
    error,
    sessionId,
    sendMessage,
    reset,
    loadHistory,
  } = useAgUiStream(`/api/agents/${selectedId}/invoke`);
  const [input, setInput] = useState('');
  const { data: sessionList, refresh: refreshSessions } = useFetch<{ sessions: SessionSummary[] }>(
    '/api/sessions',
    15000,
  );

  const selectedAgent = agents?.find(a => a.id === selectedId);

  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refreshSessions(), 1500);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refreshSessions]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  async function loadSession(sid: string) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/events`);
    if (!r.ok) return;
    const body = (await r.json()) as { events: MemoryEvent[] };
    const msgs = body.events
      .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
      .map(e => ({
        id: e.eventId + ':' + e.role,
        role: e.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: e.text,
        toolCalls: [],
      }));
    loadHistory(sid, msgs);
  }

  const sessions = sessionList?.sessions ?? [];

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Agent selector sidebar */}
      <div style={{ width: 220, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, fontSize: 13, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Agents
        </div>
        <div style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
          {(agents ?? []).map(agent => (
            <div
              key={agent.id}
              onClick={() => { setSelectedId(agent.id); reset(); }}
              style={{
                padding: '8px 16px',
                cursor: 'pointer',
                background: selectedId === agent.id ? 'var(--color-surface-hover)' : undefined,
                borderLeft: selectedId === agent.id ? '3px solid var(--color-primary)' : '3px solid transparent',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {agent.protocol.toUpperCase()} · {agent.model}
              </div>
            </div>
          ))}
        </div>
        {selectedAgent && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', fontSize: 11 }}>
            <div style={{ color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Tools:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedAgent.tools.map(t => (
                <span key={t} style={{ padding: '2px 6px', background: 'var(--color-surface-hover)', borderRadius: 3, fontSize: 10, fontFamily: 'monospace' }}>{t}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Session sidebar */}
      <div style={{ width: 220, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sessions</span>
          <button
            onClick={reset}
            title="New session"
            style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', cursor: 'pointer' }}
          >
            + New
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sessions.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              No sessions yet — send a message to start one.
            </div>
          )}
          {sessions.map(s => {
            const selected = s.sessionId === sessionId;
            return (
              <div
                key={s.sessionId}
                onClick={() => loadSession(s.sessionId)}
                style={{
                  padding: '8px 14px',
                  cursor: 'pointer',
                  background: selected ? 'var(--color-surface-hover)' : undefined,
                  borderLeft: selected ? '3px solid var(--color-primary)' : '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.sessionId.slice(0, 8)}…{s.sessionId.slice(-4)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24 }}>
        <div style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}>
          {messages.length === 0 && !isStreaming && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>Invoke {selectedAgent?.name ?? 'Agent'}</div>
              <div style={{ fontSize: 13 }}>Send a message to start a conversation</div>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                {msg.role === 'user' ? 'You' : selectedAgent?.name ?? 'Agent'}
              </div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  {msg.toolCalls.map(tc => (
                    <div key={tc.id} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--color-info-bg, #eff6ff)', borderRadius: 4, marginBottom: 3, fontFamily: 'monospace' }}>
                      {tc.name} {tc.result && <span style={{ color: 'var(--color-success)' }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
              <MessageContent content={msg.content} />
            </div>
          ))}
          {isStreaming && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Streaming...</div>}
          {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>Error: {error}</div>}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder={`Ask ${selectedAgent?.name ?? 'agent'}...`}
            disabled={isStreaming}
            style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 14, outline: 'none' }}
          />
          <button onClick={handleSend} disabled={isStreaming || !input.trim()} style={{
            padding: '10px 20px', background: 'var(--color-primary)', color: 'white',
            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 500,
            opacity: isStreaming || !input.trim() ? 0.6 : 1,
          }}>Send</button>
        </div>
      </div>
    </div>
  );
}

// Split assistant content on <thinking>…</thinking> so the chain-of-thought
// renders as a collapsed detail block instead of cluttering the response.
type Segment = { kind: 'text' | 'thinking'; body: string };

function parseSegments(content: string): Segment[] {
  const out: Segment[] = [];
  const re = /<thinking>([\s\S]*?)<\/thinking>/gi;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: 'text', body: content.slice(cursor, m.index) });
    }
    out.push({ kind: 'thinking', body: m[1] ?? '' });
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) {
    out.push({ kind: 'text', body: content.slice(cursor) });
  }
  // Handle an unclosed <thinking> tag during streaming
  const openIdx = content.lastIndexOf('<thinking>');
  const closeIdx = content.lastIndexOf('</thinking>');
  if (openIdx > closeIdx) {
    const partial = content.slice(openIdx + '<thinking>'.length);
    const before = content.slice(0, openIdx);
    return [
      ...(before ? [{ kind: 'text' as const, body: before }] : []),
      { kind: 'thinking', body: partial },
    ];
  }
  return out;
}

function MessageContent({ content }: { content: string }) {
  const segments = parseSegments(content);
  if (segments.length === 0) {
    return <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{content}</div>;
  }
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6 }}>
      {segments.map((seg, i) =>
        seg.kind === 'thinking' ? (
          <details
            key={i}
            style={{
              margin: '6px 0',
              padding: '6px 10px',
              background: 'var(--color-surface-hover, #f3f4f6)',
              borderLeft: '3px solid var(--color-text-tertiary, #94a3b8)',
              borderRadius: 4,
              fontSize: 12,
              color: 'var(--color-text-tertiary, #64748b)',
            }}
          >
            <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 500 }}>
              thinking
            </summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontStyle: 'italic' }}>
              {seg.body.trim()}
            </div>
          </details>
        ) : (
          <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{seg.body}</div>
        ),
      )}
    </div>
  );
}

export default InvokePage;
