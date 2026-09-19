import { gatewayEndpoints } from '../lib/gatewayEndpoint.ts';
import { createElement, type ReactNode } from 'react';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { GatewaySocketProvider } from '@connorhoehnslalom/realtime-modules/client/ws';

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

export function OptionalGatewayProvider({ url, children }: { url?: string; children: ReactNode }) {
  const endpoint = gatewayWebSocketUrl(url);
  return endpoint
    ? createElement(GatewaySocketProvider, { url: endpoint, children })
    : createElement(GatewayContext.Provider, { value: offlineGateway, children });
}
