import { useState } from 'react';
import { Card, PageSection } from '@connorhoehn/ui-components';

function SearchPage() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: 'Hello! I can help you search across your organization\'s knowledge. Try asking "Who knows most about Kubernetes?" or "What decisions were made about the auth migration?"' },
  ]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [
      ...prev,
      { role: 'user', content: input },
      { role: 'assistant', content: `Searching for: "${input}"...\n\n[AG-UI streaming not yet connected — this will show real-time results from the Search Agent in Phase 4]` },
    ]);
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Conversational Search</h1>
      <div style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}>
        {messages.map((msg, i) => (
          <Card key={i} padding="sm" style={{ marginBottom: 8, background: msg.role === 'user' ? 'var(--color-info-bg)' : undefined }}>
            <strong style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {msg.role === 'user' ? 'You' : 'OrgIQ'}
            </strong>
            <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 14 }}>{msg.content}</p>
          </Card>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about your organization..."
          style={{
            flex: 1,
            padding: '10px 14px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          style={{
            padding: '10px 20px',
            background: 'var(--color-primary)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default SearchPage;
