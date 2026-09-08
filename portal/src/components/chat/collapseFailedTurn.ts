// A failed turn that was retried should read as ONE turn. The stream hook
// appends a user message per sendMessage call and exposes no way to remove
// one, so after a retry the transcript holds the failed "you" bubble and the
// retried one back to back with nothing between them. Collapse the earlier
// copy — only when the two are adjacent in conversation order (no assistant
// reply in between), which is exactly the failed→retried shape.
interface TurnLike {
  role: 'user' | 'assistant';
  content: string;
}

export function collapseFailedTurn<T extends TurnLike>(
  messages: T[],
  failedText: string | null,
  retried: boolean,
): T[] {
  if (!retried || !failedText) return messages;
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content === failedText) { last = i; break; }
  }
  if (last < 0) return messages;
  for (let i = last - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant') break;
    if (m.role === 'user' && m.content === failedText) {
      return [...messages.slice(0, i), ...messages.slice(i + 1)];
    }
  }
  return messages;
}
