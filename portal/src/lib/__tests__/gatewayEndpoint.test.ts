import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient, gatewayEndpoints } from '../gatewayEndpoint.ts';

test('blank and absent gateway configuration create no client or endpoint', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(gatewayEndpoints(value), null);
    assert.equal(createGatewayClient(value), null);
  }
});
test('HTTP and WS consumers share a configured endpoint and the HTTP client binds fetch', async () => {
  assert.deepEqual(gatewayEndpoints('wss://gateway.example.com/ws'), {
    http: 'https://gateway.example.com', websocket: 'wss://gateway.example.com/ws',
  });
  const priorFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (input) {
    assert.equal(this, globalThis);
    assert.equal(String(input), 'https://gateway.example.com/health');
    calls++;
    return new Response(JSON.stringify({ status: 'healthy' }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await createGatewayClient('https://gateway.example.com')!.getHealth();
    assert.equal(calls, 1);
  } finally { globalThis.fetch = priorFetch; }
});
