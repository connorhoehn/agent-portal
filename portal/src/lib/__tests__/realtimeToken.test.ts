import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTokenSource, realtimeEndpoints, REALTIME_TOKEN_URL, REFRESH_SKEW_MS } from '../realtimeToken.ts';

function harness(start = Date.parse('2026-09-28T12:00:00Z')) {
  let clock = start;
  let n = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let respond: () => Response = () => {
    n += 1;
    return new Response(JSON.stringify({
      token: `jwt-${n}`,
      expiresAt: new Date(clock + 10 * 60_000).toISOString(),
      gatewayUrl: 'ws://localhost:18080',
    }), { status: 200 });
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return respond(); }) as typeof fetch;
  const source = createRealtimeTokenSource({ fetchImpl, now: () => clock });
  return {
    source, calls,
    advance: (ms: number) => { clock += ms; },
    setRespond: (fn: () => Response) => { respond = fn; },
  };
}

test('fetches the BFF route with credentials and returns the token shape', async () => {
  const h = harness();
  const t = await h.source.get();
  assert.equal(t.token, 'jwt-1');
  assert.equal(t.gatewayUrl, 'ws://localhost:18080');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, REALTIME_TOKEN_URL);
  assert.equal(h.calls[0].init?.credentials, 'include');
});

test('reuses the cached token until REFRESH_SKEW_MS before expiry, then refetches', async () => {
  const h = harness();
  await h.source.get();
  h.advance(10 * 60_000 - REFRESH_SKEW_MS - 1);
  assert.equal((await h.source.get()).token, 'jwt-1');
  assert.equal(h.source.isFresh(), true);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(h.source.isFresh(), false);
  assert.equal(h.source.peek(), null);
  assert.equal((await h.source.get()).token, 'jwt-2');
  assert.equal(h.calls.length, 2);
});

test('force refreshes on demand even while fresh', async () => {
  const h = harness();
  await h.source.get();
  assert.equal((await h.source.get({ force: true })).token, 'jwt-2');
  assert.equal(h.source.peek()?.token, 'jwt-2');
});

test('concurrent callers share one request', async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([h.source.get(), h.source.get(), h.source.get()]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual([a.token, b.token, c.token], ['jwt-1', 'jwt-1', 'jwt-1']);
});

test('clear drops the cache and discards a request already in flight', async () => {
  const h = harness();
  await h.source.get();
  h.source.clear();
  assert.equal(h.source.peek(), null);
  const pending = h.source.get();
  h.source.clear(); // tenant switch lands mid-request
  await pending;
  assert.equal(h.source.peek(), null, 'a token for the previous identity must not repopulate the cache');
  assert.equal((await h.source.get()).token, 'jwt-3');
});

test('HTTP errors and malformed bodies reject without caching, and the next call retries', async () => {
  const h = harness();
  h.setRespond(() => new Response('{"error":"unauthenticated"}', { status: 401 }));
  await assert.rejects(h.source.get(), /HTTP 401/);
  h.setRespond(() => new Response('{"token":""}', { status: 200 }));
  await assert.rejects(h.source.get(), /malformed/);
  assert.equal(h.source.peek(), null);
  h.setRespond(() => new Response(JSON.stringify({ token: 'ok', expiresAt: '2099-01-01T00:00:00Z' })));
  assert.equal((await h.source.get()).token, 'ok');
  assert.equal(h.calls.length, 3);
});

test('an unparseable expiresAt is never treated as fresh', async () => {
  const h = harness();
  h.setRespond(() => new Response(JSON.stringify({ token: 'x', expiresAt: 'not-a-date' })));
  await h.source.get();
  assert.equal(h.source.isFresh(), false);
});

test('carries the browser endpoints from the response and drops blank ones', async () => {
  const h = harness();
  h.setRespond(() => new Response(JSON.stringify({
    token: 'jwt-e', expiresAt: '2099-01-01T00:00:00Z',
    gatewayUrl: 'wss://rt.example.com', platformApiUrl: 'https://platform.example.com', videoUrl: '  ',
  }), { status: 200 }));
  const t = await h.source.get();
  assert.equal(t.gatewayUrl, 'wss://rt.example.com');
  assert.equal(t.platformApiUrl, 'https://platform.example.com');
  assert.equal('videoUrl' in t, false);
});

test('realtimeEndpoints: a non-blank local override wins, else the token, else null', () => {
  const token = { gatewayUrl: 'wss://rt.example.com', platformApiUrl: 'https://platform.example.com', videoUrl: 'https://sfu.example.com' };
  assert.deepEqual(realtimeEndpoints(token), token);
  assert.deepEqual(realtimeEndpoints(token, { gatewayUrl: 'http://localhost:3001', platformApiUrl: ' ', videoUrl: undefined }), {
    gatewayUrl: 'http://localhost:3001', platformApiUrl: 'https://platform.example.com', videoUrl: 'https://sfu.example.com',
  });
  assert.deepEqual(realtimeEndpoints(null), { gatewayUrl: null, platformApiUrl: null, videoUrl: null });
});
