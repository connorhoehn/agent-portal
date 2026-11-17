// Hardening lane H2 (O-072, the page's half): a token refresh after the interview ended. The server answers not-found and drops the
// guest cookie (middleware routes/__tests__/interviews-invite.H2.test.ts); here the page's token source must hand the socket nothing
// stale after that answer, whoever asked and however.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestRealtimeOff, createGuestTokenSource } from '../guestRealtime.ts';

const MIN = 60_000;
function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    const a = answers.shift() ?? { status: 500 };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}
const tokenAt = (t: string, expiresMs: number) => ({ status: 200, body: { token: t, expiresAt: new Date(expiresMs).toISOString() } });

test('after the end a forced refresh of a still-fresh token asks the server, and its not-found drops the token at once', async () => {
  const f = fakeFetch([tokenAt('t1', 30 * MIN), { status: 404 }]);
  const source = createGuestTokenSource({ fetchImpl: f.impl, now: () => 0 });
  assert.equal((await source.get()).token, 't1');
  assert.equal(source.peek()?.token, 't1');
  await assert.rejects(source.get({ force: true }), (e: unknown) => e instanceof GuestRealtimeOff);
  assert.equal(f.calls(), 2);
  assert.equal(source.peek(), null);
  assert.equal(source.isFresh(), false);
});

test('every caller waiting on that refresh is told the same, and the next ask goes to the server again (no stale token served)', async () => {
  const f = fakeFetch([tokenAt('t1', 2 * MIN), { status: 404 }, { status: 404 }]);
  let now = 0;
  const source = createGuestTokenSource({ fetchImpl: f.impl, now: () => now });
  await source.get();
  now = 1.5 * MIN; // inside the refresh skew: the token is due
  const both = await Promise.allSettled([source.get(), source.get()]);
  assert.deepEqual(both.map((r) => r.status), ['rejected', 'rejected']);
  assert.ok(both.every((r) => r.status === 'rejected' && r.reason instanceof GuestRealtimeOff));
  assert.equal(f.calls(), 2); // the two callers shared one request
  await assert.rejects(source.get(), (e: unknown) => e instanceof GuestRealtimeOff);
  assert.equal(f.calls(), 3);
  assert.equal(source.peek(), null);
});

test('the room clearing the source while the refresh is on its way keeps nothing the late answer brings', async () => {
  let release: (v: Response) => void = () => undefined;
  const impl = (async () => new Promise<Response>((r) => { release = r; })) as unknown as typeof fetch;
  const source = createGuestTokenSource({ fetchImpl: impl, now: () => 0 });
  const pending = source.get();
  source.clear();
  release({ ok: true, status: 200, json: async () => ({ token: 'late', expiresAt: new Date(30 * MIN).toISOString() }) } as Response);
  assert.equal((await pending).token, 'late'); // the caller that asked gets its answer
  assert.equal(source.peek(), null); // but the source keeps nothing after the clear
});
