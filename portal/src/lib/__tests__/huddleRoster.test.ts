import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HuddleRequestError, HuddleRoster, createHuddleRosterReader, huddleChannel, readHuddleRoster,
  type HuddleRosterSnapshot, type HuddleScope } from '../huddleRoster.ts';
import { readCallChatPageReference } from '../callPages.ts';

const scope: HuddleScope = { callId: 'call-one', tenant: 'orgiq', actorId: 'u-vera', identityKey: 'orgiq|u-vera|real' };
const page = { kind: 'work-item' as const, id: 'wi-cookie' };
const available = { ...page, status: 'available' as const, title: 'Clear the legacy cookie',
  href: '/iq/projects/p-auth?tab=work&item=wi-cookie', project: { id: 'p-auth', title: 'Auth', href: '/iq/projects/p-auth' },
  breadcrumbs: [{ title: 'Initiatives', href: '/iq/projects' }, { title: 'Auth', href: '/iq/projects/p-auth' }] };
const snapshot = (extras: Partial<HuddleRosterSnapshot> = {}): HuddleRosterSnapshot => ({
  callId: scope.callId, channel: huddleChannel(scope.callId), revision: 1,
  participants: [{ userId: 'u-vera', displayName: 'Vera Green' }, { userId: 'u-nora', displayName: 'Simone Chang' }],
  canSend: true, historyFrom: '2026-10-03T10:00:00.000Z', ...extras,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function ready(read: (callId: string) => Promise<HuddleRosterSnapshot> = async () => snapshot()) {
  const roster = new HuddleRoster(read, []); roster.setScope(scope); await roster.refresh(); return roster;
}
const members = (revision: number, participants: unknown) => ({ type: 'call-chat', action: 'members', callId: scope.callId,
  channel: huddleChannel(scope.callId), revision, participants });

test('the resolver reader asks for the call channel and validates call/channel identity', async () => {
  let requested = '';
  const read = createHuddleRosterReader(async url => { requested = String(url); return new Response(JSON.stringify({ ...snapshot(), messages: [] })); });
  assert.equal((await read(scope.callId)).channel, 'orgiq:huddle:call-one');
  assert.equal(requested, '/api/calls/call-one/chat?limit=1');
  const wrong = createHuddleRosterReader(async () => new Response(JSON.stringify(snapshot({ channel: 'social:ch:other' }))));
  await assert.rejects(wrong(scope.callId), (error: unknown) => error instanceof HuddleRequestError && error.status === 502);
  const refused = createHuddleRosterReader(async () => new Response(JSON.stringify({ error: 'Join this call' }), { status: 403 }));
  await assert.rejects(refused(scope.callId), (error: unknown) => error instanceof HuddleRequestError && error.status === 403 && error.message === 'Join this call');
  assert.equal(readHuddleRoster({ ...snapshot(), participants: [{ userId: 'u-vera' }] }, scope.callId), null);
});

test('references accept only canonical internal page links and unavailable references reveal no stale titles', () => {
  assert.deepEqual(readCallChatPageReference(available), available);
  assert.equal(readCallChatPageReference({ ...available, href: 'javascript:alert(1)' }), null);
  assert.equal(readCallChatPageReference({ ...available, href: '/iq/projects/p-auth?tab=work&item=other' }), null);
  assert.equal(readCallChatPageReference({ ...available, href: '//forged.invalid' }), null);
  assert.deepEqual(readCallChatPageReference({ ...available, status: 'unavailable' }), { ...page, status: 'unavailable' });
  assert.equal(readCallChatPageReference(page), null);
});

test('an older roster reply cannot restore a removed member or send authority', async () => {
  const read = deferred<HuddleRosterSnapshot>();
  const roster = new HuddleRoster(async () => read.promise, []);
  roster.setScope(scope); const loading = roster.refresh();
  roster.receive(members(3, [{ userId: 'u-nora', displayName: 'Nora' }]));
  read.resolve(snapshot({ revision: 2 })); await loading;
  assert.equal(roster.getSnapshot().revision, 3); assert.equal(roster.getSnapshot().canSend, false);
  assert.deepEqual(roster.getSnapshot().participants.map(p => p.userId), ['u-nora']);
});

test('a terminal frame wins over a pending reply and later roster frames', async () => {
  const read = deferred<HuddleRosterSnapshot>();
  const roster = new HuddleRoster(async () => read.promise, []);
  roster.setScope(scope); const loading = roster.refresh();
  roster.receive({ type: 'call-chat', action: 'ended', callId: scope.callId, channel: huddleChannel(scope.callId), revision: 4 });
  read.resolve(snapshot({ revision: 9 })); assert.equal(await loading, false);
  roster.receive(members(10, [{ userId: 'u-vera', displayName: 'Vera' }]));
  assert.equal(roster.getSnapshot().ended, true); assert.equal(roster.getSnapshot().canSend, false);
  assert.deepEqual(roster.getSnapshot().participants, []); assert.equal(roster.getSnapshot().refreshing, false);
});

test('identity/call transitions fence old replies and frames; cross-call frames never apply', async () => {
  const read = deferred<HuddleRosterSnapshot>();
  const roster = new HuddleRoster(async () => read.promise, []);
  roster.setScope(scope); const loading = roster.refresh();
  roster.setScope({ ...scope, identityKey: 'orgiq|u-vera|masquerade' });
  read.resolve(snapshot({ revision: 5 })); assert.equal(await loading, false);
  assert.equal(roster.getSnapshot().loaded, false); assert.equal(roster.getSnapshot().revision, -1);
  roster.receive({ ...members(6, [{ userId: 'u-vera', displayName: 'Vera' }]), callId: 'other-call', channel: huddleChannel('other-call') });
  roster.receive({ ...members(6, [{ userId: 'u-vera', displayName: 'Vera' }]), channel: 'orgiq:huddle:other-call' });
  assert.equal(roster.getSnapshot().revision, -1);
  roster.setScope(scope); roster.setScope(scope);
  assert.equal(roster.getSnapshot().scopeKey, JSON.stringify(['orgiq', 'u-vera', 'call-one', 'orgiq|u-vera|real']));
});

test('a newer reply fences an older success; a refusal marks the reader denied and closes posting', async () => {
  const oldRead = deferred<HuddleRosterSnapshot>(); let count = 0;
  const roster = await ready(async () => ++count === 2 ? oldRead.promise : snapshot({ revision: count }));
  const first = roster.refresh(); await roster.refresh();
  oldRead.resolve(snapshot({ revision: 99, participants: [], canSend: false })); assert.equal(await first, false);
  assert.equal(roster.getSnapshot().revision, 3); assert.equal(roster.getSnapshot().canSend, true);
  const denied = await ready(); let fail = true;
  const refusing = new HuddleRoster(async () => { if (fail) throw new HuddleRequestError(403, 'No longer a call member'); return snapshot(); }, []);
  refusing.setScope(scope); assert.equal(await refusing.refresh(), false);
  assert.equal(refusing.getSnapshot().denied, true); assert.equal(refusing.getSnapshot().canSend, false);
  assert.equal(refusing.getSnapshot().error, 'No longer a call member');
  fail = false; assert.equal(await refusing.refresh(), true); assert.equal(refusing.getSnapshot().denied, false);
  assert.equal(denied.getSnapshot().loaded, true);
});

test('registration retries only cover the first load window for 403/404', async () => {
  let attempts = 0;
  const roster = new HuddleRoster(async () => { if (++attempts < 3) throw new HuddleRequestError(404, 'Not yet'); return snapshot(); }, [1, 1]);
  roster.setScope(scope); assert.equal(await roster.refresh({ retryRegistration: true }), true); assert.equal(attempts, 3);
  let later = 0;
  const strict = new HuddleRoster(async () => { later++; throw new HuddleRequestError(500, 'Down'); }, [1, 1]);
  strict.setScope(scope); assert.equal(await strict.refresh({ retryRegistration: true }), false); assert.equal(later, 1);
  assert.equal(strict.getSnapshot().denied, false);
});
