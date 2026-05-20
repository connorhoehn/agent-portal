import { createContext, useContext, useMemo, useRef, useCallback } from 'react';
import { useWebSocket } from '@connorhoehn/realtime-modules/client';
import type {
  ConnectionState,
  GatewayMessage,
  UseWebSocketHookReturn,
} from '@connorhoehn/realtime-modules/client';

// ---------------------------------------------------------------------------
// URL derivation
// ---------------------------------------------------------------------------

/** Convert an HTTP(S) gateway URL to a WS(S) WebSocket URL. */
function deriveWsUrl(gatewayUrl: string): string {
  // Replace http:// → ws:// and https:// → wss://
  let wsUrl = gatewayUrl
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');

  // Append /ws if the path doesn't already end with it
  if (!wsUrl.endsWith('/ws')) {
    wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
  }
  return wsUrl;
}

const RAW_GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

const WS_URL = deriveWsUrl(RAW_GATEWAY_URL);

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

/** Listener registered via `addMessageListener`. */
export type GatewayMessageListener = (message: GatewayMessage) => void;

/**
 * Subset of UseWebSocketHookReturn exposed via context.
 * Consumers can call send/subscribe/unsubscribe directly; presence
 * subscriptions are wired by individual feature hooks.
 *
 * `addMessageListener` / `removeMessageListener` provide a lightweight
 * pub-sub surface so multiple feature hooks can react to inbound WS frames
 * without each needing their own `onMessage` prop.
 */
export interface GatewaySocketContextValue {
  connectionState: ConnectionState;
  sessionToken: string | null;
  clientId: string | null;
  send: UseWebSocketHookReturn['send'];
  subscribe: UseWebSocketHookReturn['subscribe'];
  unsubscribe: UseWebSocketHookReturn['unsubscribe'];
  addMessageListener: (listener: GatewayMessageListener) => void;
  removeMessageListener: (listener: GatewayMessageListener) => void;
}

const GatewaySocketContext = createContext<GatewaySocketContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface GatewaySocketProviderProps {
  children: React.ReactNode;
}

/**
 * Mounts a single persistent WebSocket connection to the gateway for the
 * lifetime of the app session. Exposes connection state + send/subscribe
 * helpers via `useGatewaySocket()`.
 *
 * URL: VITE_GATEWAY_URL with http(s) → ws(s) substitution + /ws suffix.
 * Session persistence: window.sessionStorage (survives page reload, clears
 * on tab close).
 *
 * The gateway may not be reachable in all environments — the hook handles
 * reconnect with exponential backoff automatically.
 */
export function GatewaySocketProvider({ children }: GatewaySocketProviderProps) {
  // Stable set of message listeners — mutated without re-render.
  const listenersRef = useRef<Set<GatewayMessageListener>>(new Set());

  const handleMessage = useCallback((message: GatewayMessage) => {
    for (const listener of listenersRef.current) {
      try {
        listener(message);
      } catch {
        // User listener errors must not break the fan-out loop.
      }
    }
  }, []);

  const ws = useWebSocket({
    url: WS_URL,
    persist: { storage: window.sessionStorage },
    autoResubscribe: true,
    onMessage: handleMessage,
  });

  const addMessageListener = useCallback((listener: GatewayMessageListener) => {
    listenersRef.current.add(listener);
  }, []);

  const removeMessageListener = useCallback((listener: GatewayMessageListener) => {
    listenersRef.current.delete(listener);
  }, []);

  const value = useMemo<GatewaySocketContextValue>(
    () => ({
      connectionState: ws.connectionState,
      sessionToken: ws.sessionToken,
      clientId: ws.clientId,
      send: ws.send,
      subscribe: ws.subscribe,
      unsubscribe: ws.unsubscribe,
      addMessageListener,
      removeMessageListener,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.connectionState, ws.sessionToken, ws.clientId, ws.send, ws.subscribe, ws.unsubscribe, addMessageListener, removeMessageListener],
  );

  return (
    <GatewaySocketContext.Provider value={value}>
      {children}
    </GatewaySocketContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

/**
 * Access the persistent gateway WebSocket connection established by
 * `GatewaySocketProvider`. Throws if called outside the provider tree.
 *
 * @example
 * const { connectionState, subscribe, unsubscribe } = useGatewaySocket();
 */
export function useGatewaySocket(): GatewaySocketContextValue {
  const ctx = useContext(GatewaySocketContext);
  if (ctx === null) {
    throw new Error('useGatewaySocket must be used within a GatewaySocketProvider');
  }
  return ctx;
}
