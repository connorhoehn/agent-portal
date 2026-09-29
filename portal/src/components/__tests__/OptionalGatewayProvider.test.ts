import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GatewayContext, useGateway } from '@connorhoehnslalom/realtime-modules/client';
import { useGateway as useSocketGateway } from '@connorhoehnslalom/realtime-modules/client/ws';
import { AuthenticatedGatewaySocket, OptionalGatewayProvider, offlineGateway, gatewayWebSocketUrl } from '../OptionalGatewayProvider.ts';
import type { RealtimeTokenSource } from '../../lib/realtimeToken.ts';

test('missing/blank gateway renders an honest disconnected context without a socket provider', () => {
  function Probe() {
    const gateway = useGateway();
    assert.equal(gateway, offlineGateway);
    assert.equal(gateway.connectionState, 'disconnected');
    assert.equal(gateway.clientId, null);
    return createElement('span', null, gateway.connectionState);
  }
  for (const url of [undefined, '', '  ']) {
    assert.equal(OptionalGatewayProvider({ url, children: null }).type, GatewayContext.Provider);
    assert.equal(renderToStaticMarkup(createElement(OptionalGatewayProvider, { url, children: createElement(Probe) })), '<span>disconnected</span>');
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

function stubSource(token: string | null): RealtimeTokenSource & { gets: number } {
  const t = token ? { token, expiresAt: '2099-01-01T00:00:00Z' } : null;
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

test('BFF-only mode never touches the token source', () => {
  // OptionalGatewayProvider with no URL returns the offline context directly;
  // AuthenticatedGatewaySocket (the only fetcher) is not in the tree.
  for (const url of [undefined, '']) {
    const el = OptionalGatewayProvider({ url, children: null });
    assert.notEqual(el.type, AuthenticatedGatewaySocket);
  }
});
