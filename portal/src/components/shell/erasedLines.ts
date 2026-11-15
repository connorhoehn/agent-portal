// After a meeting record is deleted or expires, the server leaves one of Nova's messages as the fixed line and soft-deletes the rest
// (middleware lib/meeting-assistant/chat.ts `eraseAssistantMessages`). A reader who had the chat open still holds the others, rewritten
// to the same line by the live update (the soft-delete mark is not sent to readers), so the chat would repeat the sentence. This keeps
// the line once: the newest of Nova's messages that read it. People's messages are never touched.

/** The server's fixed line (middleware lib/meeting-assistant/chat-types.ts `DELETED_RECORD_LINE`; change both together). */
export const DELETED_RECORD_LINE = 'This record was deleted by the person who invited Nova.';
/** Nova's fixed identity in the call chat (middleware chat-types.ts `NOVA_USER_ID`). */
export const NOVA_USER_ID = 'agent:nova';

interface MessageLike { userId?: string; content: string }

export function oneErasedLine<T extends MessageLike>(messages: T[]): T[] {
  const erased = (m: T) => m.userId === NOVA_USER_ID && m.content === DELETED_RECORD_LINE;
  let last = -1;
  messages.forEach((m, i) => { if (erased(m)) last = i; });
  if (last < 0) return messages;
  return messages.filter((m, i) => !erased(m) || i === last);
}
