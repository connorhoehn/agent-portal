import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalGatewayRest } from '../gatewayRest.ts';
import { createRealtimeTokenSource } from '../realtimeToken.ts';
import type { createGatewayRest } from '@connorhoehnslalom/realtime-modules/client';

test('HTTP pins refresh an expired handshake bearer without replacing the socket token', async () => {
  let now = 0;
  let minted = 0;
  const tokens = createRealtimeTokenSource({ now: () => now, fetchImpl: async () =>
    new Response(JSON.stringify({ token: `jwt-${++minted}`, expiresAt: new Date(now + 600_000).toISOString() })) });
  const handshake = (await tokens.get()).token;
  const used: Array<[string, string | undefined, string | undefined]> = [];
  const factory: typeof createGatewayRest = (url, token, base) => {
    used.push([url, token, base]);
    return { listPins: async () => [] };
  };
  const rest = portalGatewayRest('ws://localhost:3001/ws', tokens, factory);
  await rest.listPins!('orgiq:initiative:p-observability');
  now = 600_001;
  await rest.listPins!('orgiq:initiative:p-observability');
  assert.equal(handshake, 'jwt-1');
  assert.deepEqual(used.map(row => row.slice(1)), [['jwt-1', ''], ['jwt-2', '']]);
});

test('401 refreshes once; membership refusals and a second 401 remain visible', async () => {
  let minted = 0;
  const tokens = createRealtimeTokenSource({ fetchImpl: async () => new Response(JSON.stringify({
    token: `jwt-${++minted}`, expiresAt: '2099-01-01T00:00:00Z',
  })) });
  const used: string[] = [];
  let status = 401;
  const factory: typeof createGatewayRest = (_url, token) => ({ listPins: async () => {
    used.push(token!);
    throw Object.assign(new Error('Refused'), { status });
  } });
  const rest = portalGatewayRest('ws://localhost:3001/ws', tokens, factory);
  await assert.rejects(rest.listPins!('orgiq:huddle:call-1'), { status: 401 });
  assert.deepEqual(used, ['jwt-1', 'jwt-2']);
  status = 403;
  await assert.rejects(rest.listPins!('orgiq:huddle:call-1'), { status: 403 });
  assert.equal(used.length, 3);
  assert.equal(minted, 2);
});
