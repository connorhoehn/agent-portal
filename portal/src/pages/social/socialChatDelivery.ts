type ChatFrame = Record<string, unknown>;

/**
 * Why a post did not land (voice G46/G47), a closed vocabulary: the socket was down, the gateway refused the
 * conversation's join because the sender is not a member, it refused the send, the persisted receipt never came,
 * or the conversation never opened.
 */
export type SocialSendFailure = 'not-connected' | 'not-a-member' | 'rejected' | 'receipt-timeout' | 'timeout';

/** An Error that says which of the failures it is (the composer reads only `message`; the voice reads `code`). */
export class SocialSendError extends Error {
  readonly code: SocialSendFailure;
  constructor(message: string, code: SocialSendFailure) { super(message); this.name = 'SocialSendError'; this.code = code; }
}

/** The failure code of an error a post threw: the error's own, else `rejected`. */
export function socialSendFailure(err: unknown): SocialSendFailure {
  return err instanceof SocialSendError ? err.code : 'rejected';
}

/** The code of a chat error frame for this channel: `not-a-member` when the gateway said so, else `rejected`. */
export function socialChatErrorCode(frame: ChatFrame): SocialSendFailure {
  const error = frame.error as { code?: unknown } | null | undefined;
  return error && typeof error === 'object' && error.code === 'not-a-member' ? 'not-a-member' : 'rejected';
}

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
    const aborted = () => finish(new SocialSendError('The conversation changed before the message was confirmed.', 'rejected'));
    const timer = setTimeout(() => finish(new SocialSendError('The message receipt was not confirmed. Check the conversation before retrying.', 'receipt-timeout')), options.timeoutMs ?? 10_000);
    unsubscribe = options.listen(frame => {
      const error = socialChatError(frame, options.channel);
      if (error) { finish(new SocialSendError(error, socialChatErrorCode(frame))); return; }
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
    try { options.send(); } catch (cause) { finish(new SocialSendError(cause instanceof Error ? cause.message : 'The message could not be sent.', 'rejected')); }
  });
}
