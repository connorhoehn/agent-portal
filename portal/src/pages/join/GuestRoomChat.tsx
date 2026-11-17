// The candidate's call chat (docs/interviews-tenant-plan.md decision 3: the guest reaches the interview's call chat;
// row I2.4). The call's chat is the huddle chat every page lobby's call has (`orgiq:huddle:<callId>`); the gateway
// admits the guest to it only while it holds a seat in that call (middleware lib/gateway/authority.ts guestChannel,
// the huddle runtime's seat check on top).
//
// The shell's huddle chat (components/shell/HuddleChat.tsx) cannot mount here: it needs the router, the staff
// session and the staff roster route. So this is the library's chat panel straight on `useChat(channel)`, in the
// library's side-panel frame: no pins, no uploads, no page references, no reactions. A huddle send must carry a
// delivery id (middleware lib/call-chat-send.ts), so each send gets a fresh one.
import { useMemo } from 'react';
import { useChat } from '@connorhoehn/realtime-modules/client';
import { ChatSidePanelFrame } from '@connorhoehn/ui-components';
import { WrappedChatPanel } from '@connorhoehn/ui-components/integrations/realtime';

const newDeliveryId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function GuestRoomChat({ callId, self, onClose }: { callId: string; self: { userId: string; displayName: string }; onClose(): void }) {
  return <ChatSidePanelFrame title="Messages" subtitle="Everyone in the call reads these" onClose={onClose} closeLabel="Hide messages"
    className="w-80 shrink-0 border-l border-border bg-surface" data-testid="join-room-chat">
    <GuestRoomChatBody callId={callId} self={self} />
  </ChatSidePanelFrame>;
}

/** The chat alone, for a pane that has its own frame (a technical round's Chat tab, beside the pad). */
export function GuestRoomChatBody({ callId, self }: { callId: string; self: { userId: string; displayName: string } }) {
  const chat = useChat(`orgiq:huddle:${callId}`);
  const sendable = useMemo(() => ({
    ...chat,
    sendMessage: (text: string, metadata?: Record<string, unknown>) => chat.sendMessage(text, { ...metadata, clientDeliveryId: newDeliveryId() }),
  }), [chat]);
  return <WrappedChatPanel chat={sendable} currentUserId={self.userId} displayName={self.displayName} fill showHeader={false} />;
}
