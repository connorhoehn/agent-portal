import { gatewayEndpoints } from '../lib/gatewayEndpoint.ts';
import { realtimeTokenSource, type RealtimeToken, type RealtimeTokenSource } from '../lib/realtimeToken.ts';
import { Fragment, createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { GatewaySocketProvider, useGateway } from '@connorhoehnslalom/realtime-modules/client/ws';
import { portalGatewayRest } from '../lib/gatewayRest.ts';

const noop = (): void => {};
const unavailable = (): never => {
  throw new Error('Realtime gateway is unavailable: the middleware returned no gatewayUrl (REALTIME_GATEWAY_URL) and VITE_GATEWAY_URL is unset');
};
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
    // Explicit public reconnect starts at `connecting`. An authority change
    // may have prefetched a new cached bearer before asking it to reconnect.
    // Consuming an unchanged token is a no-op in the owner's state setter.
    if (['connecting', 'reconnecting', 'disconnected'].includes(connectionState)) onDown();
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
  const rest = useMemo(() => portalGatewayRest(url, tokens), [url, tokens]);
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
    url, token: auth.token, httpBase: '', rest,
    children: createElement(Fragment, null, createElement(TokenRenewer, { onDown: renew }), children),
  });
}

/** How long the endpoint lookup may hold the app back before it goes offline. */
export const GATEWAY_RESOLVE_TIMEOUT_MS = 5_000;

export function tokenGatewayUrl(t: Pick<RealtimeToken, 'gatewayUrl'>): string | null {
  // A malformed URL from the server is an offline deployment, not a crash of
  // the whole tree (gatewayEndpoints throws on it).
  try { return gatewayWebSocketUrl(t.gatewayUrl); } catch { return null; }
}

type Resolution = { ready: false } | { ready: true; url: string | null };

/**
 * No build-time override: the gateway URL comes from the realtime-token
 * response (`gatewayUrl`, the middleware's REALTIME_GATEWAY_URL), so a
 * deployed bundle needs no VITE_GATEWAY_URL. Renders nothing until that
 * request settles, like AuthenticatedGatewaySocket: switching the provider
 * after first paint would remount the whole app. No gatewayUrl, a failed
 * request (signed out: every sign-in hard-navigates, so this re-runs after
 * it) or a timeout mounts the inert offline context.
 */
export function TokenResolvedGateway({ children, tokens = realtimeTokenSource, timeoutMs = GATEWAY_RESOLVE_TIMEOUT_MS }: {
  children: ReactNode; tokens?: RealtimeTokenSource; timeoutMs?: number;
}) {
  const [res, setRes] = useState<Resolution>(() => {
    const cached = tokens.peek();
    return cached ? { ready: true, url: tokenGatewayUrl(cached) } : { ready: false };
  });
  useEffect(() => {
    if (res.ready) return;
    let live = true;
    const settle = (url: string | null) => { if (live) { live = false; setRes({ ready: true, url }); } };
    const timer = setTimeout(() => settle(null), timeoutMs);
    tokens.get().then((t) => settle(tokenGatewayUrl(t)), () => settle(null)).finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); };
  }, [tokens, res.ready, timeoutMs]);
  if (!res.ready) return null;
  return res.url
    ? createElement(AuthenticatedGatewaySocket, { url: res.url, tokens, children })
    : createElement(GatewayContext.Provider, { value: offlineGateway, children });
}

/**
 * `url` is the local override (VITE_GATEWAY_URL); when set it wins. Unset or
 * blank, the endpoint is learned at run time from the realtime token.
 */
export function OptionalGatewayProvider({ url, children, tokens }: {
  url?: string; children: ReactNode; tokens?: RealtimeTokenSource;
}) {
  const override = gatewayWebSocketUrl(url);
  return override
    ? createElement(AuthenticatedGatewaySocket, { url: override, children, ...(tokens ? { tokens } : {}) })
    : createElement(TokenResolvedGateway, { children, ...(tokens ? { tokens } : {}) });
}
