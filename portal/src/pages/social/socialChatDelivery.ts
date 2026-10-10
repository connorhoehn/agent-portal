type ChatFrame = Record<string, unknown>;

/** Chat errors can omit their channel, but always identify their service. */
export function socialChatError(frame: ChatFrame, channel: string): string | null {
  if (frame.type !== 'error' || frame.service !== 'chat' || (frame.channel && frame.channel !== channel)) return null;
  if (typeof frame.error === 'string') return frame.error;
  const error = frame.error as { message?: unknown } | null;
  return typeof error?.message === 'string' ? error.message : 'The conversation could not complete this request.';
}

/** Keep the composer draft until this connection receives a persisted send acknowledgement. */
export function sendAndWaitForSocialChatAck(options: {
  channel: string;
  deliveryId: string;
  userId: string;
  send: () => void;
  listen: (handler: (frame: ChatFrame) => void) => () => void;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const delivered = new Set<string>();
    const acknowledged = new Set<string>();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); unsubscribe(); options.signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(new Error('The conversation changed before the message was confirmed.'));
    const timer = setTimeout(() => finish(new Error('The message receipt was not confirmed. Check the conversation before retrying.')), options.timeoutMs ?? 10_000);
    unsubscribe = options.listen(frame => {
      const error = socialChatError(frame, options.channel);
      if (error) { finish(new Error(error)); return; }
      if (frame.type !== 'chat' || frame.channel !== options.channel) return;
      if (frame.action === 'sent' && typeof frame.messageId === 'string') {
        acknowledged.add(frame.messageId);
        if (delivered.has(frame.messageId)) finish();
      } else if (frame.action === 'message' && frame.message && typeof frame.message === 'object') {
        const message = frame.message as ChatFrame;
        const metadata = message.metadata as ChatFrame | undefined;
        if (message.channel === options.channel && message.userId === options.userId
          && metadata?.clientDeliveryId === options.deliveryId && typeof message.id === 'string' && message.id) {
          delivered.add(message.id);
          if (acknowledged.has(message.id)) finish();
        }
      }
    });
    options.signal.addEventListener('abort', aborted, { once: true });
    if (options.signal.aborted) { aborted(); return; }
    try { options.send(); } catch (cause) { finish(cause instanceof Error ? cause : new Error('The message could not be sent.')); }
  });
}
