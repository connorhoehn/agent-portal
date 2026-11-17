// The candidate's realtime token source (pages/join/guestRealtime.ts; row I2.4, the candidate's side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_REALTIME_TOKEN_URL, GuestRealtimeOff, createGuestTokenSource } from '../guestRealtime.ts';

const MIN = 60_000;
function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift() ?? { status: 500 };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const tokenAt = (t: string, expiresMs: number, extra: Record<string, string> = {}) => ({ status: 200, body: { token: t, expiresAt: new Date(expiresMs).toISOString(), ...extra } });

test('reads only the guest\'s own route, on its cookie, with no Referer and nothing cached by the browser', async () => {
  const now = 0;
  const f = fakeFetch([tokenAt('t1', now + 10 * MIN)]);
  await createGuestTokenSource({ fetchImpl: f.impl, now: () => now }).get();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, GUEST_REALTIME_TOKEN_URL);
  assert.equal(f.calls[0]!.url, '/api/interview-invite/realtime-token');
  assert.equal(f.calls[0]!.init?.credentials, 'same-origin');
  assert.equal(f.calls[0]!.init?.referrerPolicy, 'no-referrer');
  assert.equal(f.calls[0]!.init?.cache, 'no-store');
});

test('cached until a minute before it expires, then refreshed; concurrent callers share one request; the endpoints ride along', async () => {
  let now = 0;
  const f = fakeFetch([tokenAt('t1', 10 * MIN, { gatewayUrl: 'http://gw.test', videoUrl: ' ' }), tokenAt('t2', 20 * MIN)]);
  const source = createGuestTokenSource({ fetchImpl: f.impl, now: () => now });
  const [a, b] = await Promise.all([source.get(), source.get()]);
  assert.equal(a.token, 't1');
  assert.equal(b, a);
  assert.equal(a.gatewayUrl, 'http://gw.test');
  assert.equal(a.videoUrl, undefined);
  now = 8 * MIN;
  assert.equal((await source.get()).token, 't1');
  assert.equal(source.peek()?.token, 't1');
  now = 9 * MIN + 1;
  assert.equal(source.peek(), null);
  assert.equal((await source.get()).token, 't2');
  assert.equal(f.calls.length, 2);
});

test('clear drops the token; an answer already on its way is not kept', async () => {
  const now = 0;
  const f = fakeFetch([tokenAt('t1', 10 * MIN), tokenAt('t2', 10 * MIN)]);
  const source = createGuestTokenSource({ fetchImpl: f.impl, now: () => now });
  const pending = source.get();
  source.clear();
  assert.equal((await pending).token, 't1');
  assert.equal(source.peek(), null);
  assert.equal((await source.get()).token, 't2');
  source.clear();
  assert.equal(source.isFresh(), false);
});

test('not-found (guest realtime off, or the link died) is GuestRealtimeOff and drops the cached token; other failures are plain errors', async () => {
  let now = 0;
  const f = fakeFetch([tokenAt('t1', 10 * MIN), { status: 404 }, { status: 503 }]);
  const source = createGuestTokenSource({ fetchImpl: f.impl, now: () => now });
  await source.get();
  now = 9.5 * MIN;
  await assert.rejects(source.get(), (e: unknown) => e instanceof GuestRealtimeOff);
  assert.equal(source.peek(), null);
  await assert.rejects(source.get(), (e: unknown) => e instanceof Error && !(e instanceof GuestRealtimeOff));
});
