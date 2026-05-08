import { useState, useRef, useEffect } from 'react';
import { useAgUiStream } from '../hooks/useAgUiStream';

function SearchPage() {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, isStreaming, error, sendMessage, reset } = useAgUiStream('/api/agents/orgiq-search/invoke');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Conversational Search</h1>
        <button onClick={reset} style={{
          fontSize: 12, padding: '6px 12px', border: '1px solid var(--color-border)',
          borderRadius: 6, background: 'var(--color-surface)', cursor: 'pointer',
        }}>New Session</button>
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
              <div style={{
                width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: msg.role === 'user' ? 'var(--color-primary)' : 'var(--color-surface-hover)',
                color: msg.role === 'user' ? 'white' : 'var(--color-text-secondary)',
                fontSize: 12, fontWeight: 600,
              }}>
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                {msg.role === 'user' ? 'You' : 'OrgIQ Search'}
              </span>
            </div>
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ marginLeft: 36, marginBottom: 8 }}>
                {msg.toolCalls.map(tc => (
                  <div key={tc.id} style={{
                    fontSize: 11, padding: '4px 8px', background: 'var(--color-info-bg, #eff6ff)',
                    borderRadius: 4, marginBottom: 4, fontFamily: 'monospace',
                    color: 'var(--color-text-secondary)',
                  }}>
                    <span style={{ fontWeight: 600 }}>{tc.name}</span>
                    {tc.result && <span style={{ marginLeft: 8, color: 'var(--color-success, #16a34a)' }}>✓ {tc.result}</span>}
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
            flex: 1, padding: '10px 14px', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)', fontSize: 14, outline: 'none',
            opacity: isStreaming ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          style={{
            padding: '10px 20px', background: 'var(--color-primary)', color: 'white',
            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
            fontWeight: 500, opacity: isStreaming || !input.trim() ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default SearchPage;
