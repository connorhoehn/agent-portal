import { useState, useCallback, useRef } from 'react';

interface AgUiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: string; result?: string }>;
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  done: boolean;
}

interface SendOptions {
  selection?: { peopleIds: string[] };
}

interface UseAgUiStreamReturn {
  messages: AgUiMessage[];
  isStreaming: boolean;
  streamingText: string;
  activeToolCalls: LiveToolCall[];
  error: string | null;
  sessionId: string | null;
  sendMessage: (content: string, opts?: SendOptions) => void;
  reset: () => void;
  loadHistory: (sid: string, msgs: AgUiMessage[]) => void;
}

export function useAgUiStream(endpoint: string): UseAgUiStreamReturn {
  const [messages, setMessages] = useState<AgUiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<LiveToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentMsg = useRef<{ id: string; content: string; toolCalls: AgUiMessage['toolCalls'] }>({ id: '', content: '', toolCalls: [] });
  // sessionId mirror in a ref so the memoized sendMessage callback (which has
  // [endpoint] deps only) reads the latest value, not the closure-captured
  // initial null. Without this, every send creates a new Memory session.
  const sessionIdRef = useRef<string | null>(null);

  const setSessionId = useCallback((sid: string | null) => {
    sessionIdRef.current = sid;
    setSessionIdState(sid);
  }, []);

  const sendMessage = useCallback(async (content: string, opts?: SendOptions) => {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content, toolCalls: [] }]);
    setIsStreaming(true);
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    currentMsg.current = { id: '', content: '', toolCalls: [] };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const currentSid = sessionIdRef.current;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          ...(currentSid ? { sessionId: currentSid } : {}),
          ...(opts?.selection ? { selection: opts.selection } : {}),
        }),
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
      setStreamingText('');
      setActiveToolCalls([]);
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [endpoint]);

  function handleEvent(event: Record<string, unknown>) {
    switch (event.type) {
      case 'RUN_STARTED':
        // Middleware echoes back the canonical sessionId on every run; capture
        // it so subsequent sendMessage calls continue the same Memory thread.
        if (typeof event.sessionId === 'string' && event.sessionId) {
          setSessionId(event.sessionId);
        }
        break;
      case 'TEXT_MESSAGE_START':
        currentMsg.current.id = event.messageId as string;
        break;
      case 'TEXT_MESSAGE_CONTENT': {
        const delta = event.delta as string;
        currentMsg.current.content += delta;
        setStreamingText(prev => prev + delta);
        break;
      }
      case 'TOOL_CALL_START': {
        const tc = { id: event.toolCallId as string, name: event.name as string, args: '', result: undefined };
        currentMsg.current.toolCalls = [...(currentMsg.current.toolCalls ?? []), tc];
        setActiveToolCalls(prev => [...prev, { ...tc, done: false }]);
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const tcRef = currentMsg.current.toolCalls?.find(t => t.id === event.toolCallId);
        if (tcRef) tcRef.args += event.delta as string;
        setActiveToolCalls(prev => prev.map(t =>
          t.id === event.toolCallId ? { ...t, args: t.args + (event.delta as string) } : t,
        ));
        break;
      }
      case 'TOOL_CALL_END': {
        const tcRef = currentMsg.current.toolCalls?.find(t => t.id === event.toolCallId);
        if (tcRef) tcRef.result = event.result as string;
        setActiveToolCalls(prev => prev.map(t =>
          t.id === event.toolCallId ? { ...t, result: String(event.result ?? ''), done: true } : t,
        ));
        break;
      }
    }
  }

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setIsStreaming(false);
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    setSessionId(null);
  }, [setSessionId]);

  const loadHistory = useCallback((sid: string, msgs: AgUiMessage[]) => {
    abortRef.current?.abort();
    setMessages(msgs);
    setIsStreaming(false);
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    setSessionId(sid);
  }, [setSessionId]);

  return { messages, isStreaming, streamingText, activeToolCalls, error, sessionId, sendMessage, reset, loadHistory };
}
