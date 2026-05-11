import { useState, useRef, useEffect } from 'react';
import { useAgUiStream } from '../hooks/useAgUiStream';
import { useFetch } from '../hooks/useFetch';

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

function SearchPage() {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    isStreaming,
    error,
    sessionId,
    sendMessage,
    reset,
    loadHistory,
  } = useAgUiStream('/api/agents/orgiq-search/invoke');

  const { data: sessionList, refresh: refreshSessions } = useFetch<{ sessions: SessionSummary[] }>(
    '/api/sessions',
    15000,
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Refresh the session list shortly after each message so the new session
  // appears once AgentCore writes the first event.
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
      {/* Session sidebar */}
      <div
        style={{
          width: 240,
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-surface)',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Sessions
          </span>
          <button
            onClick={reset}
            title="Start a new session"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              background: 'var(--color-surface)',
              cursor: 'pointer',
            }}
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>Conversational Search</h1>
            {sessionId && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                session: <code style={{ fontFamily: 'monospace' }}>{sessionId}</code>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}>
          {messages.length === 0 && !isStreaming && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>Ask about your organization</div>
              <div style={{ fontSize: 14 }}>
                Try "Who knows Kubernetes best?" or "Show me the team structure"
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: msg.role === 'user' ? 'var(--color-primary)' : 'var(--color-surface-hover)',
                    color: msg.role === 'user' ? 'white' : 'var(--color-text-secondary)',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {msg.role === 'user' ? 'U' : 'AI'}
                </div>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                  {msg.role === 'user' ? 'You' : 'OrgIQ Search'}
                </span>
              </div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={{ marginLeft: 36, marginBottom: 8 }}>
                  {msg.toolCalls.map(tc => (
                    <div
                      key={tc.id}
                      style={{
                        fontSize: 11,
                        padding: '4px 8px',
                        background: 'var(--color-info-bg, #eff6ff)',
                        borderRadius: 4,
                        marginBottom: 4,
                        fontFamily: 'monospace',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{tc.name}</span>
                      {tc.result && (
                        <span style={{ marginLeft: 8, color: 'var(--color-success, #16a34a)' }}>
                          ✓ {tc.result}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginLeft: 36, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {msg.content}
              </div>
            </div>
          ))}

          {isStreaming && (
            <div style={{ marginLeft: 36, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              <span className="animate-pulse">Thinking...</span>
            </div>
          )}

          {error && (
            <div style={{ marginLeft: 36, color: 'var(--color-danger, #ef4444)', fontSize: 13 }}>
              Error: {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask about your organization..."
            disabled={isStreaming}
            style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 14,
              outline: 'none',
              opacity: isStreaming ? 0.6 : 1,
            }}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            style={{
              padding: '10px 20px',
              background: 'var(--color-primary)',
              color: 'white',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontWeight: 500,
              opacity: isStreaming || !input.trim() ? 0.6 : 1,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default SearchPage;
