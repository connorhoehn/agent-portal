import { createContext, useContext, useState, type ReactNode } from 'react';

interface AgUiContextValue {
  threadId: string | null;
  sessionId: string | null;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  isStreaming: boolean;
}

const AgUiContext = createContext<AgUiContextValue>({
  threadId: null,
  sessionId: null,
  messages: [],
  isStreaming: false,
});

export function AgUiProvider({ children }: { children: ReactNode }) {
  const [threadId] = useState<string | null>(null);
  const [sessionId] = useState<string | null>(null);
  const [messages] = useState<AgUiContextValue['messages']>([]);
  const [isStreaming] = useState(false);

  return (
    <AgUiContext.Provider value={{ threadId, sessionId, messages, isStreaming }}>
      {children}
    </AgUiContext.Provider>
  );
}

export function useAgUiContext() {
  return useContext(AgUiContext);
}
