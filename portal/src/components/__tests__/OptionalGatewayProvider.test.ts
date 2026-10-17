import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GatewayContext, useGateway } from '@connorhoehn/realtime-modules/client';
import { useGateway as useSocketGateway } from '@connorhoehn/realtime-modules/client/ws';
import { AuthenticatedGatewaySocket, OptionalGatewayProvider, TokenResolvedGateway, offlineGateway, tokenGatewayUrl, gatewayWebSocketUrl } from '../OptionalGatewayProvider.ts';
import type { RealtimeTokenSource } from '../../lib/realtimeToken.ts';

test('no override and no gatewayUrl in the token renders an honest disconnected context without a socket provider', () => {
  function Probe() {
    const gateway = useGateway();
    assert.equal(gateway, offlineGateway);
    assert.equal(gateway.connectionState, 'disconnected');
    assert.equal(gateway.clientId, null);
    return createElement('span', null, gateway.connectionState);
  }
  for (const url of [undefined, '', '  ']) {
    assert.equal(OptionalGatewayProvider({ url, children: null }).type, TokenResolvedGateway);
    // A cached token without a gatewayUrl: resolved at first render, offline.
    const tokens = stubSource('jwt-no-gateway');
    assert.equal(renderToStaticMarkup(createElement(OptionalGatewayProvider, { url, tokens, children: createElement(Probe) })), '<span>disconnected</span>');
  }
});
test('configured gateways mount the authenticated library socket and normalize the WS path once', () => {
  for (const [input, expected] of [
    ['https://gateway.example.com', 'wss://gateway.example.com/ws'],
    ['http://localhost:8080/', 'ws://localhost:8080/ws'],
    ['wss://gateway.example.com/ws', 'wss://gateway.example.com/ws'],
  ]) {
    const result = OptionalGatewayProvider({ url: input, children: null });
    assert.equal(result.type, AuthenticatedGatewaySocket);
    assert.equal('url' in result.props ? result.props.url : undefined, expected);
  }
  assert.throws(() => gatewayWebSocketUrl('file:///tmp/socket'));
  assert.throws(() => gatewayWebSocketUrl('https://user:secret@example.com'));
});
test('library lifecycle registration is inert, while real outbound work fails explicitly', () => {
  const unsubscribe = offlineGateway.onMessage(() => assert.fail('offline provider emitted a frame'));
  unsubscribe();
  for (const service of ['presence', 'activity', 'reaction']) {
    for (const action of ['subscribe', 'unsubscribe']) {
      assert.doesNotThrow(() => offlineGateway.send({ service, action, channel: 'doc-1' }));
    }
  }
  for (const action of ['join', 'leave']) assert.doesNotThrow(() => offlineGateway.send({ service: 'chat', action, channel: 'doc-1' }));
  for (const frame of [{ service: 'chat', action: 'send' }, { service: 'presence', action: 'set' }, { service: 'reaction', action: 'add' }, { service: 'unknown', action: 'subscribe' }]) {
    assert.throws(() => offlineGateway.send(frame), /gateway is unavailable/);
  }
  assert.throws(() => offlineGateway.publish('doc-1', {}), /gateway is unavailable/);
  assert.throws(() => offlineGateway.sendMessage({}), /gateway is unavailable/);
  assert.throws(() => offlineGateway.reconnect(), /gateway is unavailable/);
});

function stubSource(token: string | null, extra: { gatewayUrl?: string } = {}): RealtimeTokenSource & { gets: number } {
  const t = token ? { token, expiresAt: '2099-01-01T00:00:00Z', ...extra } : null;
  return {
    gets: 0,
    get() { this.gets += 1; return t ? Promise.resolve(t) : new Promise(() => {}); },
    peek: () => t, isFresh: () => !!t, clear: noopFn,
  };
}
function noopFn(): void {}

test('a cached realtime token reaches the library socket as its auth token', () => {
  function Probe() { return createElement('i', null, useSocketGateway().authToken ?? 'none'); }
  const html = renderToStaticMarkup(createElement(AuthenticatedGatewaySocket, {
    url: 'ws://localhost:18080/ws', tokens: stubSource('jwt-abc'), children: createElement(Probe),
  }));
  assert.equal(html, '<i>jwt-abc</i>');
});

test('the socket is not mounted until the first token request settles', () => {
  const tokens = stubSource(null);
  const html = renderToStaticMarkup(createElement(AuthenticatedGatewaySocket, {
    url: 'ws://localhost:18080/ws', tokens, children: createElement('b', null, 'app'),
  }));
  assert.equal(html, '', 'no anonymous socket, no children rendered against it');
});

test('without an override the socket URL comes from the realtime token', () => {
  function Probe() { return createElement('i', null, useSocketGateway().authToken ?? 'none'); }
  assert.equal(tokenGatewayUrl({ gatewayUrl: 'https://rt.example.com' }), 'wss://rt.example.com/ws');
  assert.equal(tokenGatewayUrl({ gatewayUrl: 'http://localhost:3001' }), 'ws://localhost:3001/ws');
  assert.equal(tokenGatewayUrl({}), null);
  const tokens = stubSource('jwt-from-bff', { gatewayUrl: 'https://rt.example.com' });
  // The library socket is mounted (its context carries the token) without a
  // VITE_GATEWAY_URL; the e2e spec asserts the handshake URL itself.
  assert.equal(renderToStaticMarkup(createElement(OptionalGatewayProvider, { tokens, children: createElement(Probe) })), '<i>jwt-from-bff</i>');
});

test('a VITE_GATEWAY_URL override wins over the token gatewayUrl', () => {
  const tokens = stubSource('jwt', { gatewayUrl: 'https://rt.example.com' });
  const el = OptionalGatewayProvider({ url: 'http://localhost:3001', tokens, children: null });
  assert.equal(el.type, AuthenticatedGatewaySocket);
  assert.equal((el.props as { url?: string }).url, 'ws://localhost:3001/ws');
});

test('a malformed token gatewayUrl goes offline instead of throwing', () => {
  function Probe() { return createElement('span', null, useGateway() === offlineGateway ? 'offline' : 'live'); }
  assert.equal(tokenGatewayUrl({ gatewayUrl: 'file:///tmp/socket' }), null);
  const tokens = stubSource('jwt', { gatewayUrl: 'file:///tmp/socket' });
  assert.equal(renderToStaticMarkup(createElement(TokenResolvedGateway, { tokens, children: createElement(Probe) })), '<span>offline</span>');
});

test('nothing renders until the token request settles when no override is set', () => {
  const tokens = stubSource(null);
  const html = renderToStaticMarkup(createElement(OptionalGatewayProvider, { tokens, children: createElement('b', null, 'app') }));
  assert.equal(html, '');
});
