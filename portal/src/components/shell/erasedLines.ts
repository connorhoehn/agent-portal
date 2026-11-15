// After a meeting record is deleted or expires, the server leaves one of Milo's messages as the fixed line and soft-deletes the rest
// (middleware lib/meeting-assistant/chat.ts `eraseAssistantMessages`). A reader who had the chat open still holds the others, rewritten
// to the same line by the live update (the soft-delete mark is not sent to readers), so the chat would repeat the sentence. This keeps
// the line once: the newest of Milo's messages that read it. People's messages are never touched.
//
// The assistant's messages are known by their author id, never by a name: the line's other copies reach a reader with no assistant
// metadata left (the server strips every key but the soft-delete mark, which readers do not get). A message stored before the rename
// keeps the author id it was stored under, so both ids count.
import { ASSISTANT_NAME } from '../../lib/meetingAssistantModel.ts';

/** The server's fixed line (middleware lib/meeting-assistant/chat-types.ts `DELETED_RECORD_LINE`; change both together). */
export const DELETED_RECORD_LINE = `This record was deleted by the person who invited ${ASSISTANT_NAME}.`;
/** The same line as messages erased before the rename read it (chat-types.ts `LEGACY_DELETED_RECORD_LINES`). */
export const LEGACY_DELETED_RECORD_LINES: readonly string[] = ['This record was deleted by the person who invited Nova.'];
/** The assistant's author id in the call chat, and the one its messages were stored under before (chat-types.ts `ASSISTANT_USER_ID`, `LEGACY_ASSISTANT_USER_IDS`). */
export const ASSISTANT_USER_ID = 'agent:meeting-assistant';
export const ASSISTANT_USER_IDS: readonly string[] = [ASSISTANT_USER_ID, 'agent:nova'];

interface MessageLike { userId?: string; content: string }

const isErasedLine = (m: MessageLike): boolean =>
  !!m.userId && ASSISTANT_USER_IDS.includes(m.userId) && (m.content === DELETED_RECORD_LINE || LEGACY_DELETED_RECORD_LINES.includes(m.content));

export function oneErasedLine<T extends MessageLike>(messages: T[]): T[] {
  let last = -1;
  messages.forEach((m, i) => { if (isErasedLine(m)) last = i; });
  if (last < 0) return messages;
  return messages.filter((m, i) => !isErasedLine(m) || i === last);
}
