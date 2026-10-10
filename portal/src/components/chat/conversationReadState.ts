/** The native join acknowledgement precedes history; only history confirms
 * an empty discussion. Errors from other channels/services are unrelated. */
export type ConversationReadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; denied: boolean; message: string };

export function conversationReadFrame(frame: Record<string, unknown>, channel: string):
  { kind: 'joined' | 'history' } | { kind: 'error'; state: Extract<ConversationReadState, { phase: 'error' }> } | null {
  if (frame.type === 'chat' && frame.channel === channel) {
    if (frame.action === 'joined') return { kind: 'joined' };
    if (frame.action === 'history' && Array.isArray(frame.messages)) return { kind: 'history' };
    return null;
  }
  if (frame.type !== 'error') return null;
  const error = frame.error && typeof frame.error === 'object' ? frame.error as Record<string, unknown> : {};
  if ((frame.service ?? error.service) !== 'chat' || (frame.channel ?? error.channel) !== channel) return null;
  const code = frame.code ?? error.code;
  const accessKind = frame.kind ?? error.kind;
  const denied = code === 'not-a-member' || code === 'CHAT_DM_FORBIDDEN'
    || (code === 'AUTHZ_CHANNEL_DENIED' && accessKind === 'subscribe');
  // A publish/edit/reaction refusal must not hide a discussion one can read.
  if (!denied) return null;
  return { kind: 'error', state: { phase: 'error', denied: true,
    message: 'Your current access does not allow this discussion. Open the page to check access, or choose another conversation.' } };
}
