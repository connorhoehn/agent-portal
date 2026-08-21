// coalesceMessages — merge back-to-back assistant messages into one turn.
//
// useAgentStream flushes an assistant message at every TEXT_MESSAGE_END, so a
// single supervisor turn (text → tool call → more text) lands as several
// adjacent assistant messages. Each one rendered its own MessageBubble, and
// each bubble prints the role label — which is why "Search agent" appeared
// twice (or more) per turn. Merging adjacent same-role assistant messages
// keeps one label, one bubble, and the union of the turn's tool calls.

interface ChatMessageLike {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: string; result?: string; done: boolean }>;
}

export function coalesceAssistantMessages<T extends ChatMessageLike>(messages: T[]): T[] {
  const out: T[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      out[out.length - 1] = {
        ...prev,
        content: [prev.content, msg.content].filter((c) => c.trim().length > 0).join('\n\n'),
        toolCalls: [...(prev.toolCalls ?? []), ...(msg.toolCalls ?? [])],
      };
    } else {
      out.push(msg);
    }
  }
  return out;
}
