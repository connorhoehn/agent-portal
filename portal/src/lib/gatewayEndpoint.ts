import { GatewayProxyClient } from '@connorhoehnslalom/realtime-modules/proxy-client';

export function gatewayEndpoints(configuredUrl?: string): { http: string; websocket: string } | null {
  const value = configuredUrl?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('VITE_GATEWAY_URL must be an HTTP(S) or WS(S) gateway URL without credentials');
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\/ws$/, '') || '/';
  url.protocol = secure ? 'https:' : 'http:';
  const http = url.href.replace(/\/$/, '');
  url.protocol = secure ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  return { http, websocket: url.href };
}

export function createGatewayClient(configuredUrl?: string): GatewayProxyClient | null {
  const endpoint = gatewayEndpoints(configuredUrl);
  return endpoint ? new GatewayProxyClient({ gatewayUrl: endpoint.http, fetch: globalThis.fetch.bind(globalThis) }) : null;
}
