import { useEffect, useRef, useState } from 'react';
import { useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { conversationReadFrame, type ConversationReadState } from './conversationReadState';

/** Observe the existing gateway protocol; useChat still owns join, history
 * and messages. An explicit native history request includes an empty result. */
export function useConversationReadState(channel: string, enabled: boolean, loadHistory: () => void) {
  const gateway = useGatewayOptional();
  const listen = gateway?.onMessage;
  const epoch = gateway?.sessionEpoch;
  const connected = gateway?.connectionState === 'connected';
  const requestedChannel = useRef<string | null>(null);
  const [receipt, setReceipt] = useState<{ channel: string; epoch: number | undefined; state: ConversationReadState } | null>(null);
  useEffect(() => {
    if (!enabled || !listen || !connected) return;
    let waiting = true;
    let requested = false;
    let denied = false;
    const store = (state: ConversationReadState) => setReceipt({ channel, epoch, state });
    store({ phase: 'loading' });
    const timer = window.setTimeout(() => {
      if (waiting) store({ phase: 'error', denied: false,
        message: 'The discussion has not finished loading. Reconnect to try again.' });
    }, 10_000);
    const unsubscribe = listen(frame => {
      const event = conversationReadFrame(frame, channel);
      if (denied) return;
      if (event?.kind === 'joined' && !requested) {
        requested = true;
        // useChat restores its requested history depth on a new native
        // session. Ask only on this channel's first join, avoiding a second
        // history read and preserving that depth on reconnect.
        if (requestedChannel.current === channel) return;
        requestedChannel.current = channel;
        try { loadHistory(); }
        catch {
          waiting = false;
          window.clearTimeout(timer);
          store({ phase: 'error', denied: false, message: 'The discussion could not be loaded. Reconnect to try again.' });
        }
      } else if (event?.kind === 'history') {
        waiting = false;
        window.clearTimeout(timer);
        store({ phase: 'ready' });
      } else if (event?.kind === 'error') {
        denied = event.state.denied;
        waiting = false;
        window.clearTimeout(timer);
        store(event.state);
      }
    });
    return () => { waiting = false; window.clearTimeout(timer); unsubscribe(); };
  }, [channel, enabled, listen, connected, epoch, loadHistory]);
  return enabled && connected
    ? receipt?.channel === channel && receipt.epoch === epoch ? receipt.state : { phase: 'loading' } as const
    : undefined;
}
