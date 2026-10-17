// A page's discussion, owned once by the page: the gateway thread
// (`orgiq:initiative:<id>`, `orgiq:work:<id>`). One `useChat` per channel — a
// second hook on the same channel would `leave` it for both when either
// unmounts — so the page mounts `ConversationOwner` beside its columns (its channel can
// change or be absent, which a hook at the page's top cannot) and hands the
// ONE runtime to the pane's thread, to the content column's composer and to the
// Discussion tab (WorkItemDetail `liveNotes`), which therefore list the same
// messages and share the `/summarize` cards.

import type { CommentListItem } from '@connorhoehnslalom/ui-components';
import type { useChat } from '@connorhoehn/realtime-modules/client';
import type { ConversationRuntime } from '../../components/chat/ConversationThread';

export type WorkThread = ConversationRuntime;

type ChatMessage = ReturnType<typeof useChat>['messages'][number];

/** The thread as the content column's comment list: every message the pane shows, oldest first. */
export function threadNotes(messages: readonly ChatMessage[]): CommentListItem[] {
  return messages.map((m) => {
    const name = typeof m.metadata?.['displayName'] === 'string' && m.metadata['displayName'] ? m.metadata['displayName'] as string : m.userId ?? 'Unknown';
    return {
      id: m.id ?? `${m.userId}-${m.timestamp}`,
      author: { id: m.userId ?? name, name },
      createdAt: m.timestamp ?? '',
      text: m.deletedAt || m.metadata?.['deleted'] ? 'Message deleted' : m.message,
    };
  });
}
