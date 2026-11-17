// The candidate's call chat (docs/interviews-tenant-plan.md decision 3: the guest reaches the interview's call chat;
// row I2.4). The call's chat is the huddle chat every page lobby's call has (`orgiq:huddle:<callId>`); the gateway
// admits the guest to it only while it holds a seat in that call (middleware lib/gateway/authority.ts guestChannel,
// the huddle runtime's seat check on top).
//
// The shell's huddle chat (components/shell/HuddleChat.tsx) cannot mount here: it needs the router, the staff
// session and the staff roster route. So this is the library's chat panel straight on `useChat(channel)`, in the
// room's one pane (GuestRoomPane): no pins, no uploads, no page references, no reactions. A huddle send must carry a
// delivery id (middleware lib/call-chat-send.ts), so each send gets a fresh one.
import { useMemo } from 'react';
import { useChat } from '@connorhoehn/realtime-modules/client';
import { WrappedChatPanel } from '@connorhoehn/ui-components/integrations/realtime';

const newDeliveryId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** The chat alone, for the room's pane (its Chat tab, or the whole pane in a behavioural round). */
export function GuestRoomChatBody({ callId, self }: { callId: string; self: { userId: string; displayName: string } }) {
  const chat = useChat(`orgiq:huddle:${callId}`);
  const sendable = useMemo(() => ({
    ...chat,
    sendMessage: (text: string, metadata?: Record<string, unknown>) => chat.sendMessage(text, { ...metadata, clientDeliveryId: newDeliveryId() }),
  }), [chat]);
  return <WrappedChatPanel chat={sendable} currentUserId={self.userId} displayName={self.displayName} fill showHeader={false} />;
}
