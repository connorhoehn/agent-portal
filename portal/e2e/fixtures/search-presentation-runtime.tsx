import { useState } from 'react';
import { SearchInput, T } from '@connorhoehnslalom/ui-components/shared';
import type { SearchConversationAPI } from '../../src/pages/InvokePage';

/** Only the invocation/call boundary is inert; SearchWorkspace remains real. */
export default function InertInvocation({ renderWorkspace }: { renderWorkspace: (api: SearchConversationAPI) => React.ReactNode }) {
  const [input, setInput] = useState('Unsent fixture inquiry');
  const api: SearchConversationAPI = {
    transcript: <T size="sm">No conversation was requested in this fixture.</T>, messages: [], sessions: [], sessionsUnavailable: false,
    historyUnavailable: false, isStreaming: false, streamingText: '', sessionId: null, input, setInput,
    send: () => { throw new Error('This read-only Search fixture must never invoke an agent.'); },
    newSession: () => setInput(''), agents: [], agentId: 'orgiq-supervisor', selectAgent: () => {},
  };
  return renderWorkspace(api);
}
export function SearchComposer({ value, onChange }: { value: string; onChange(value: string): void }) {
  return <SearchInput aria-label="Unsent fixture inquiry" value={value} onChange={onChange} className="m-3" />;
}
