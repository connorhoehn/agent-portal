import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishToChannel } from '../gatewayProxyFetch.ts';

test('publishing surfaces retired or unavailable gateway responses', async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'retired' }), { status: 410 });
  try {
    await assert.rejects(publishToChannel('private-room', { message: 'hello' }), /publishToChannel failed: 410/);
  } finally { globalThis.fetch = prior; }
});
