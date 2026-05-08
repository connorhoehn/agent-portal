import { useState, useCallback, useRef } from 'react';

interface AgUiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: string; result?: string }>;
}

interface UseAgUiStreamReturn {
  messages: AgUiMessage[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (content: string) => void;
  reset: () => void;
}

export function useAgUiStream(endpoint: string): UseAgUiStreamReturn {
  const [messages, setMessages] = useState<AgUiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentMsg = useRef<{ id: string; content: string; toolCalls: AgUiMessage['toolCalls'] }>({ id: '', content: '', toolCalls: [] });

  const sendMessage = useCallback(async (content: string) => {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content, toolCalls: [] }]);
    setIsStreaming(true);
    setError(null);
    currentMsg.current = { id: '', content: '', toolCalls: [] };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Stream failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleEvent(event);
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Stream error');
      }
    } finally {
      if (currentMsg.current.content) {
        setMessages(prev => [...prev, {
          id: currentMsg.current.id || crypto.randomUUID(),
          role: 'assistant',
          content: currentMsg.current.content,
          toolCalls: currentMsg.current.toolCalls,
        }]);
      }
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [endpoint]);

  function handleEvent(event: Record<string, unknown>) {
    switch (event.type) {
      case 'TEXT_MESSAGE_START':
        currentMsg.current.id = event.messageId as string;
        break;
      case 'TEXT_MESSAGE_CONTENT':
        currentMsg.current.content += event.delta as string;
        break;
      case 'TOOL_CALL_START':
        currentMsg.current.toolCalls = [
          ...(currentMsg.current.toolCalls ?? []),
          { id: event.toolCallId as string, name: event.name as string, args: '', result: undefined },
        ];
        break;
      case 'TOOL_CALL_ARGS': {
        const tc = currentMsg.current.toolCalls?.find(t => t.id === event.toolCallId);
        if (tc) tc.args += event.delta as string;
        break;
      }
      case 'TOOL_CALL_END': {
        const tc = currentMsg.current.toolCalls?.find(t => t.id === event.toolCallId);
        if (tc) tc.result = event.result as string;
        break;
      }
    }
  }

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setIsStreaming(false);
    setError(null);
  }, []);

  return { messages, isStreaming, error, sendMessage, reset };
}
