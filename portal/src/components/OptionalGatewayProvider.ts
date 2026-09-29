import { gatewayEndpoints } from '../lib/gatewayEndpoint.ts';
import { realtimeTokenSource, type RealtimeTokenSource } from '../lib/realtimeToken.ts';
import { Fragment, createElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { GatewaySocketProvider, useGateway } from '@connorhoehnslalom/realtime-modules/client/ws';

const noop = (): void => {};
const unavailable = (): never => { throw new Error('Realtime gateway is unavailable: configure VITE_GATEWAY_URL'); };
// Feature hooks in the pinned library register these subscriptions on mount,
// even when disconnected. Registration is inert; publishing is never successful.
function offlineSend(frame: Record<string, unknown>): void {
  if ((['presence', 'activity', 'reaction'].includes(String(frame.service)) &&
       ['subscribe', 'unsubscribe'].includes(String(frame.action))) ||
      (frame.service === 'chat' && ['join', 'leave'].includes(String(frame.action)))) return;
  unavailable();
}
export const offlineGateway: GatewayContextValue = Object.freeze({
  connectionState: 'disconnected', lastError: null, sessionToken: null,
  clientId: null, currentChannel: '',
  switchChannel: noop, subscribe: noop, unsubscribe: noop, disconnect: noop,
  onMessage: () => noop,
  reconnect: unavailable, send: offlineSend, sendMessage: unavailable, publish: unavailable,
});

export function gatewayWebSocketUrl(configuredUrl?: string): string | null {
  return gatewayEndpoints(configuredUrl)?.websocket ?? null;
}

// Asks for a fresh token whenever the socket is down. The library's
// useWebSocket re-runs its connect effect when `authToken` changes, so the
// token is deliberately NOT swapped while connected (that would drop and
// reopen the socket every ~9 minutes); the gateway checks it at handshake.
// A drop after expiry retries with the stale token, this fires, and the new
// token prop reconnects with a valid one.
function TokenRenewer({ onDown }: { onDown: () => void }) {
  const { connectionState } = useGateway();
  useEffect(() => {
    if (connectionState === 'reconnecting' || connectionState === 'disconnected') onDown();
  }, [connectionState, onDown]);
  return null;
}

type TokenState = { ready: false } | { ready: true; token?: string };

/**
 * The library socket, authenticated with the BFF's realtime token
 * (`Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`). Renders nothing until
 * the first token request settles so the socket never opens anonymously and
 * then reconnects; a failed request (signed out, signing unavailable) mounts
 * the socket without a token — a gateway running with auth disabled accepts
 * that, and one that doesn't reports it through the connection state.
 */
export function AuthenticatedGatewaySocket({ url, children, tokens = realtimeTokenSource }: {
  url: string; children: ReactNode; tokens?: RealtimeTokenSource;
}) {
  const [auth, setAuth] = useState<TokenState>(() => {
    const cached = tokens.peek();
    return cached ? { ready: true, token: cached.token } : { ready: false };
  });
  useEffect(() => {
    if (auth.ready) return;
    let live = true;
    tokens.get().then(
      (t) => { if (live) setAuth({ ready: true, token: t.token }); },
      () => { if (live) setAuth({ ready: true }); },
    );
    return () => { live = false; };
  }, [tokens, auth.ready]);
  const renew = useCallback(() => {
    // Served from cache while fresh; only a stale token costs a request.
    tokens.get().then(
      (t) => setAuth((prev) => (prev.ready && prev.token === t.token ? prev : { ready: true, token: t.token })),
      () => { /* keep the current token; the next drop asks again */ },
    );
  }, [tokens]);
  if (!auth.ready) return null;
  return createElement(GatewaySocketProvider, {
    url, token: auth.token,
    children: createElement(Fragment, null, createElement(TokenRenewer, { onDown: renew }), children),
  });
}

export function OptionalGatewayProvider({ url, children }: { url?: string; children: ReactNode }) {
  const endpoint = gatewayWebSocketUrl(url);
  return endpoint
    ? createElement(AuthenticatedGatewaySocket, { url: endpoint, children })
    : createElement(GatewayContext.Provider, { value: offlineGateway, children });
}
