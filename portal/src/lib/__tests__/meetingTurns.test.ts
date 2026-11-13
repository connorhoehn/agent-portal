// The call assistant's turns in the asker's browser: what runs, what never runs, and that nothing runs twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SeenTurns, parseTurns, processTurns, runnable, type AssistantTurn } from '../meetingTurns.ts';
import { runCallTool } from '../voice/runCore.ts';
import { fakeFetch, route, toolContext } from '../voice/__tests__/voiceHarness.ts';

const NOW = 1_000_000;
const turn = (over: Partial<AssistantTurn> & { turnId: string }): AssistantTurn =>
  ({ kind: 'read', status: 'pending', tool: { name: 'search', args: { query: 'login' } }, expiresAt: NOW + 60_000, ...over });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } };
}

function harness(storage: Storage | null = memoryStorage()) {
  const ran: Array<{ name: string; write: boolean }> = [];
  const posted: Array<{ turnId: string; body: { ok: boolean; output?: unknown; error?: string } }> = [];
  const seen = new SeenTurns('k', () => storage);
  return {
    ran, posted, seen, storage,
    deps: {
      seen, now: () => NOW,
      run: async (name: string, _args: unknown, write: boolean) => { ran.push({ name, write }); return { ok: true, output: { say: 'ok' } }; },
      post: async (turnId: string, body: { ok: boolean; output?: unknown; error?: string }) => { posted.push({ turnId, body }); },
    },
  };
}

test('a pending read runs once and its result is posted; the same turn listed again does not run', async () => {
  const h = harness();
  const list = [turn({ turnId: 't-1' })];
  assert.equal(await processTurns(list, h.deps), 1);
  assert.equal(await processTurns(list, h.deps), 0);
  assert.deepEqual(h.ran, [{ name: 'search', write: false }]);
  assert.deepEqual(h.posted, [{ turnId: 't-1', body: { ok: true, output: { say: 'ok' } } }]);
});

test('a write that is still pending (its card not confirmed) never runs, and runs once it is running', async () => {
  const h = harness();
  const pending = turn({ turnId: 't-w', kind: 'write', status: 'pending', tool: { name: 'create', args: {} } });
  assert.equal(await processTurns([pending], h.deps), 0);
  assert.equal(h.ran.length, 0);
  assert.equal(await processTurns([{ ...pending, status: 'running' }], h.deps), 1);
  assert.deepEqual(h.ran, [{ name: 'create', write: true }]);
  assert.equal(await processTurns([{ ...pending, status: 'running' }], h.deps), 0);
});

test('a turn past its expiry is skipped, and so is anything neither pending nor running', async () => {
  const h = harness();
  assert.equal(await processTurns([turn({ turnId: 'a', expiresAt: NOW }), turn({ turnId: 'b', status: 'done' }), turn({ turnId: 'c', kind: 'write', status: 'declined' })], h.deps), 0);
  assert.equal(runnable(turn({ turnId: 'd', kind: 'private-read' }), NOW), true);
});

test('a reload (a new ledger on the same storage) does not run a taken turn again', async () => {
  const storage = memoryStorage();
  const first = harness(storage);
  await processTurns([turn({ turnId: 't-1' })], first.deps);
  const second = harness(storage);
  assert.equal(await processTurns([turn({ turnId: 't-1' })], second.deps), 0);
  assert.equal(second.ran.length, 0);
});

test('with storage blocked the in-memory ledger still holds', async () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
  const h = harness(blocked);
  await processTurns([turn({ turnId: 't-1' })], h.deps);
  assert.equal(await processTurns([turn({ turnId: 't-1' })], h.deps), 0);
});

test('a runner that throws still answers the turn, with a plain sentence', async () => {
  const h = harness();
  h.deps.run = async () => { throw new Error('boom'); };
  await processTurns([turn({ turnId: 't-1' })], h.deps);
  assert.equal(h.posted[0]!.body.ok, false);
  assert.match(h.posted[0]!.body.error!, /boom/);
});

test('parseTurns drops rows that are not turns', () => {
  const rows = parseTurns({ turns: [{ turnId: 'a', kind: 'read', status: 'pending', tool: { name: 'search', args: {} }, expiresAt: 5 }, { turnId: 'b' }, 'x', { turnId: 'c', kind: 'odd', tool: { name: 's' }, expiresAt: 1 }] });
  assert.deepEqual(rows.map((r) => r.turnId), ['a']);
  assert.deepEqual(parseTurns(null), []);
});

test('runCallTool runs a read through the executor with the person\'s own can(), and refuses what the executor refuses', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/search', 200, { results: [{ id: 'w-1', title: 'Login cookie bug', type: 'work-item' }], total: 1 })]);
  const ctx = toolContext({ fetch });
  const ok = await runCallTool('search', { query: 'login' }, ctx, { write: false });
  assert.equal(ok.ok, true);
  assert.ok(JSON.stringify(ok.output).length < 14_000);
  const dctx = toolContext({ deny: ['DispatchAgentRun'] });
  const denied = await runCallTool('create', { kind: 'work-item', fields: { title: 'x' } }, dctx, { write: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /.+/);
});

test('runCallTool refuses navigation, malformed arguments, and a write tool offered as a read', async () => {
  const ctx = toolContext();
  assert.equal((await runCallTool('open', { page: 'budgets' }, ctx, { write: false })).ok, false);
  assert.equal((await runCallTool('computer', {}, ctx, { write: true })).ok, false);
  const bad = await runCallTool('create', { kind: 'work-item', fields: { title: 'x', assignee: 'Priya' } }, ctx, { write: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /.+/);
  const asRead = await runCallTool('create', { kind: 'work-item', fields: { title: 'x' } }, ctx, { write: false });
  assert.equal(asRead.ok, false);
  assert.equal(ctx.navigations.length, 0);
});

test('a confirmed write runs through the voice planner and runner, and the result carries the line the card shows', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/graph/projects', 200, [{ id: 'p-auth', name: 'Auth Migration' }]),
    route('POST', '/api/graph/work-items', 200, { id: 'w-9', title: 'Login cookie bug' }),
  ]);
  const ctx = toolContext({ fetch, results: undefined });
  const out = await runCallTool('create', { kind: 'work-item', fields: { title: 'Login cookie bug', initiative: 'Auth Migration' } }, ctx, { write: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(typeof out.output!['say'], 'string');
  assert.equal(log.filter((r) => r.method === 'POST' && r.url.includes('/api/graph/work-items')).length, 1);
  // The same call again on the same ledger is not sent twice.
  await runCallTool('create', { kind: 'work-item', fields: { title: 'Login cookie bug', initiative: 'Auth Migration' } }, ctx, { write: true });
  assert.equal(log.filter((r) => r.method === 'POST' && r.url.includes('/api/graph/work-items')).length, 1);
});
