import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialTeamPreferences, saveTeamFavorite, type TeamsResponse } from '../socialTeamPreferences.ts';
import type { SocialTeam } from '../socialPlatform.ts';

const team = (id: string, favorite = false, role: SocialTeam['role'] = 'member'): SocialTeam => ({
  teamId: id, slug: id, name: id, visibility: 'org', createdBy: 'owner', role, favorite, channels: [],
});
const directory = (...teams: SocialTeam[]): TeamsResponse => ({ source: 'mock', teams, counts: { total: teams.length, channels: 0 } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
async function fixture(run: (model: SocialTeamPreferences) => Promise<void>) {
  const original = globalThis.fetch;
  const model = new SocialTeamPreferences('alice');
  try { await run(model); } finally { model.stop(); globalThis.fetch = original; }
}

test('favorite client sends only personal preference with session credentials', async () => fixture(async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/social/teams/team%2Fone/me');
    assert.equal(init?.method, 'PATCH');
    assert.equal(init?.credentials, 'include');
    assert.deepEqual(JSON.parse(init?.body as string), { favorite: true });
    return json({ member: { teamId: 'team/one', userId: 'alice', favorite: true } });
  };
  await saveTeamFavorite('team/one', 'alice', true);
}));

test('favorite client rejects missing, mismatched actor, team and value receipts', async () => fixture(async () => {
  for (const member of [undefined, { teamId: 'other', userId: 'alice', favorite: true },
    { teamId: 'a', userId: 'bob', favorite: true }, { teamId: 'a', userId: 'alice', favorite: false }]) {
    globalThis.fetch = async () => json({ member });
    await assert.rejects(saveTeamFavorite('a', 'alice', true), /could not be confirmed/);
  }
}));

test('backend and transport failures are surfaced without a successful receipt', async () => fixture(async () => {
  globalThis.fetch = async () => json({ error: 'Membership is required.' }, 403);
  await assert.rejects(saveTeamFavorite('a', 'alice', true), /Membership is required/);
  globalThis.fetch = async () => { throw new Error('Connection lost'); };
  await assert.rejects(saveTeamFavorite('a', 'alice', true), /Connection lost/);
}));

test('latest list read wins even when aborted fetch ignores cancellation', async () => fixture(async (model) => {
  const old = deferred<Response>();
  let reads = 0;
  globalThis.fetch = async () => ++reads === 1 ? old.promise : json(directory(team('new')));
  const first = model.refresh();
  await model.refresh();
  old.resolve(json(directory(team('old'))));
  await first;
  assert.equal(model.getSnapshot().data?.teams[0].teamId, 'new');
}));

test('saved favorite survives older and eventually consistent lists; later external changes flow through', async () => fixture(async (model) => {
  globalThis.fetch = async () => json(directory(team('a')));
  await model.refresh();
  const old = deferred<Response>();
  let list = directory(team('a'));
  globalThis.fetch = async (_url, init) => init?.method === 'PATCH'
    ? json({ member: { teamId: 'a', userId: 'alice', favorite: true } }) : old.promise;
  const earlier = model.refresh();
  await model.pin('a', true);
  old.resolve(json(list));
  await earlier;
  await tick();
  assert.equal(model.getSnapshot().data?.teams[0].favorite, true);
  globalThis.fetch = async () => json(list);
  await model.refresh();
  assert.equal(model.getSnapshot().data?.teams[0].favorite, true);
  list = directory(team('a', true));
  await model.refresh();
  list = directory(team('a', false));
  await model.refresh();
  assert.equal(model.getSnapshot().data?.teams[0].favorite, false);
}));

test('Pin waits for persistence; repeated Pin and Leave share one synchronous lock', async () => fixture(async (model) => {
  const receipt = deferred<Response>();
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PATCH') { writes++; return receipt.promise; }
    return json(directory(team('a')));
  };
  await model.refresh();
  const first = model.pin('a', true);
  assert.equal(model.getSnapshot().data?.teams[0].favorite, false);
  assert.equal(await model.pin('a', true), false);
  assert.equal(await model.changeMembership('a', async () => { assert.fail('must not leave during Pin'); }, true), false);
  assert.equal(writes, 1);
  receipt.resolve(json({ member: { teamId: 'a', userId: 'alice', favorite: true } }));
  assert.equal(await first, true);
  assert.equal(model.getSnapshot().data?.teams[0].favorite, true);
}));

test('failed save keeps confirmed value and permits retry with the same desired value', async () => fixture(async (model) => {
  let refused = true;
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PATCH') {
      writes++;
      return refused ? json({ error: 'Temporarily unavailable' }, 503)
        : json({ member: { teamId: 'a', userId: 'alice', favorite: true } });
    }
    return json(directory(team('a')));
  };
  await model.refresh();
  await assert.rejects(model.pin('a', true), /Temporarily unavailable/);
  assert.equal(model.getSnapshot().data?.teams[0].favorite, false);
  refused = false;
  await model.pin('a', true);
  assert.equal(writes, 2);
  assert.equal(model.getSnapshot().data?.teams[0].favorite, true);
}));

test('nonmember Pin cannot issue a write', async () => fixture(async (model) => {
  globalThis.fetch = async () => json(directory(team('a', false, null)));
  await model.refresh();
  globalThis.fetch = async () => { assert.fail('no request without membership'); };
  await assert.rejects(model.pin('a', true), /Join this team/);
}));

test('account disposal rejects late read and pin receipts, including restart lifecycle', async () => fixture(async (model) => {
  globalThis.fetch = async () => json(directory(team('a')));
  await model.refresh();
  const receipt = deferred<Response>();
  const old = deferred<Response>();
  globalThis.fetch = async (_url, init) => init?.method === 'PATCH' ? receipt.promise : old.promise;
  const read = model.refresh();
  const pin = model.pin('a', true);
  model.stop();
  model.start();
  receipt.resolve(json({ member: { teamId: 'a', userId: 'alice', favorite: true } }));
  old.resolve(json(directory(team('bob-team'))));
  await read;
  assert.equal(await pin, false);
  assert.equal(model.getSnapshot().data?.teams[0].teamId, 'a');
  assert.equal(model.getSnapshot().data?.teams[0].favorite, false);
}));

test('different teams may save independently without changing another actor model', async () => fixture(async (model) => {
  globalThis.fetch = async (_url, init) => init?.method === 'PATCH'
    ? json({ member: { teamId: String(_url).includes('/a/') ? 'a' : 'b', userId: 'alice', favorite: true } })
    : json(directory(team('a'), team('b')));
  const bob = new SocialTeamPreferences('bob');
  try {
    await model.refresh(); await bob.refresh();
    await Promise.all([model.pin('a', true), model.pin('b', true)]);
    assert.deepEqual(model.getSnapshot().data?.teams.map((row) => row.favorite), [true, true]);
    assert.deepEqual(bob.getSnapshot().data?.teams.map((row) => row.favorite), [false, false]);
  } finally { bob.stop(); }
}));

test('confirmed self-leave cannot be undone by old or eventually consistent membership reads', async () => fixture(async (model) => {
  let rows = directory(team('a', true), { ...team('private', true), visibility: 'private' });
  globalThis.fetch = async () => json(rows);
  await model.refresh();
  const leave = deferred<void>();
  const leaving = model.changeMembership('a', () => leave.promise, true);
  assert.equal(await model.pin('a', false), false);
  leave.resolve();
  await leaving;
  await model.changeMembership('private', async () => {}, true);
  await model.refresh();
  assert.equal(model.getSnapshot().data?.teams.some((row) => row.teamId === 'a'), false);
  assert.equal(model.getSnapshot().data?.teams.some((row) => row.teamId === 'private'), false);
  rows = directory(team('a', false, null));
  await model.refresh();
  rows = directory(team('a')); // A subsequent re-invitation may now be observed.
  await model.refresh();
  assert.equal(model.getSnapshot().data?.teams[0].role, 'member');
}));

test('failed list read retains confirmed teams and surfaces the backend reason', async () => fixture(async (model) => {
  globalThis.fetch = async () => json(directory(team('a')));
  await model.refresh();
  globalThis.fetch = async () => json({ error: 'Team directory unavailable' }, 503);
  await model.refresh();
  assert.equal(model.getSnapshot().data?.teams[0].teamId, 'a');
  assert.equal(model.getSnapshot().isLoading, false);
  assert.equal(model.getSnapshot().error, 'Team directory unavailable');
}));

test('reconciliation expires so another tab can change the same actor before a matching read', async () => fixture(async () => {
  let now = 0;
  const model = new SocialTeamPreferences('alice', () => now);
  globalThis.fetch = async (_url, init) => init?.method === 'PATCH'
    ? json({ member: { teamId: 'a', userId: 'alice', favorite: true } }) : json(directory(team('a')));
  try {
    await model.refresh();
    await model.pin('a', true);
    await model.refresh();
    assert.equal(model.getSnapshot().data?.teams[0].favorite, true);
    now = 30_000;
    await model.refresh();
    assert.equal(model.getSnapshot().data?.teams[0].favorite, false);
    await model.changeMembership('a', async () => {}, true);
    await model.refresh();
    assert.equal(model.getSnapshot().data?.teams.length, 0);
    now += 30_000;
    await model.refresh();
    assert.equal(model.getSnapshot().data?.teams[0].role, 'member');
  } finally { model.stop(); }
}));
