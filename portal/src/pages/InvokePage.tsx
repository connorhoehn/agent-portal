import { useState } from 'react';
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

function InvokePage() {
  const { data: agents } = useFetch<AgentDef[]>('/api/agents');
  const [selectedId, setSelectedId] = useState('orgiq-supervisor');
  const { messages, isStreaming, error, sendMessage, reset } = useAgUiStream(`/api/agents/${selectedId}/invoke`);
  const [input, setInput] = useState('');

  const selectedAgent = agents?.find(a => a.id === selectedId);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

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
              <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{msg.content}</div>
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

export default InvokePage;
