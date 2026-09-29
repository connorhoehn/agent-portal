// The raw frame slice of the gateway socket, for realtime-modules' call hooks
// (`useConversationCall` / `useIncomingConversationCalls` take
// `gateway: { send, onMessage, connectionState?, sessionEpoch? }`).
//
// The socket is the one OptionalGatewayProvider already mounts — the same
// GatewayContext the chat, presence and distillation hooks read — so a call
// rides the chat's connection rather than opening a second one.
//
// Why an adapter at all: with no VITE_GATEWAY_URL the provider mounts the
// inert `offlineGateway`, whose `send` THROWS for anything but a
// subscribe/join frame. The call hooks send a `call`/`status` discovery frame
// on mount, and fall back to the context when handed `null` — so passing the
// offline context (or null) would throw from an effect on every initiative
// page. Offline, this returns a gateway that drops frames and never delivers
// one, and says so through `configured: false`.

import { useContext, useMemo } from 'react';
import { GatewayContext } from '@connorhoehnslalom/realtime-modules/client';
import type { ConversationCallGateway } from '@connorhoehnslalom/realtime-modules/client/video';
import { offlineGateway } from '../components/OptionalGatewayProvider';

export interface GatewayFrames {
  gateway: ConversationCallGateway;
  /** A real socket is mounted (VITE_GATEWAY_URL set); it may still be connecting. */
  configured: boolean;
  /** The socket's own state: 'connected', 'connecting', 'reconnecting', 'disconnected'. */
  connectionState: string;
}

const drop = (): void => {};
const INERT: ConversationCallGateway = Object.freeze({
  send: drop,
  onMessage: () => drop,
  connectionState: 'disconnected',
});

export function useGatewayFrames(): GatewayFrames {
  const ctx = useContext(GatewayContext);
  const live = ctx && ctx !== offlineGateway ? ctx : null;
  const send = live?.send;
  const onMessage = live?.onMessage;
  const connectionState = live ? String(live.connectionState) : 'disconnected';
  const sessionEpoch = (live as { sessionEpoch?: number } | null)?.sessionEpoch;
  const gateway = useMemo<ConversationCallGateway>(() => (
    send && onMessage
      ? { send, onMessage, connectionState, ...(sessionEpoch !== undefined ? { sessionEpoch } : {}) }
      : INERT
  ), [send, onMessage, connectionState, sessionEpoch]);
  return { gateway, configured: !!live, connectionState };
}
