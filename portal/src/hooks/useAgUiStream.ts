import { useState, useCallback } from 'react';

interface AgUiMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface UseAgUiStreamReturn {
  messages: AgUiMessage[];
  isStreaming: boolean;
  sendMessage: (content: string) => void;
}

export function useAgUiStream(_endpoint?: string): UseAgUiStreamReturn {
  const [messages] = useState<AgUiMessage[]>([]);
  const [isStreaming] = useState(false);

  const sendMessage = useCallback((_content: string) => {
    // Phase 4: POST to AG-UI SSE endpoint, parse event stream
  }, []);

  return { messages, isStreaming, sendMessage };
}
