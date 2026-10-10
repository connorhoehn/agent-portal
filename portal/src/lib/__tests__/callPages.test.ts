import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CallPageRequestError, CallPageSession, canonicalCallPageHref, canStopSharingCallPage, createCallPageClient,
  currentCallPage, readCallPageSnapshot, readCallChatPageReference, reconcileCallPage,
  type CallPageClient, type CallPageSnapshot, type SharedCallPage,
} from '../callPages.ts';

const page: SharedCallPage = {
  kind: 'work-item', id: 'wi-auth-cookie', title: 'Retire the legacy cookie',
  href: '/iq/projects/p-auth-migration?tab=work&item=wi-auth-cookie',
  project: { id: 'p-auth-migration', title: 'Auth Migration', href: '/iq/projects/p-auth-migration' },
  breadcrumbs: [{ title: 'Plan', href: '/iq/projects' }, { title: 'Auth Migration', href: '/iq/projects/p-auth-migration' }],
  presenter: { userId: 'u-vera', displayName: 'Vera Green' }, sharedAt: '2026-10-03T12:00:00.000Z',
};
const snapshot = (revision: number, sharedPage: SharedCallPage | null = page, callId = 'call-1'): CallPageSnapshot =>
  ({ type: 'call-page', callId, revision, page: sharedPage });
const scope = { callId: 'call-1', tenant: 'orgiq', actorId: 'u-vera' };
test('chat references preserve a valid public key and discard malformed display keys', () => {
  const resolved = readCallChatPageReference({ ...page, status: 'available', key: 'ORG-OBS-13' });
  assert.equal(resolved?.status === 'available' && resolved.key, 'ORG-OBS-13');
  const namespaced = readCallChatPageReference({ ...page, status: 'available', key: 'ORG-NEW-2-13' });
  assert.equal(namespaced?.status === 'available' && namespaced.key, 'ORG-NEW-2-13');
  const legacy = readCallChatPageReference({ ...page, status: 'available', key: 'wi-obs-e3-s1' });
  assert.equal(legacy?.status === 'available' && legacy.key, undefined);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('current route descriptors select the open record and omit transient list/view state', () => {
  assert.deepEqual(currentCallPage('/iq/projects/p-auth-migration', '?q=cookie&scope=mine'), { kind: 'initiative', id: 'p-auth-migration' });
  assert.deepEqual(currentCallPage('/iq/projects/p-auth-migration', '?item=wi-auth-cookie&view=comments'), { kind: 'work-item', id: 'wi-auth-cookie' });
  assert.deepEqual(currentCallPage('/iq/projects/p-auth-migration', '?tab=work&item=wi-auth-cookie&scope=mine'), { kind: 'work-item', id: 'wi-auth-cookie' });
  assert.deepEqual(currentCallPage('/iq/projects/p-auth-migration', '?tab=overview&item=wi-auth-cookie'), { kind: 'initiative', id: 'p-auth-migration' });
  assert.deepEqual(currentCallPage('/iq/projects/p-auth-migration', '?tab=invalid&item=wi-auth-cookie'), { kind: 'work-item', id: 'wi-auth-cookie' });
  assert.equal(currentCallPage('/iq/projects'), null);
  assert.equal(currentCallPage('/social/channels/general'), null);
  assert.equal(currentCallPage('/iq/projects/%2F%2Fevil.test'), null);
  assert.equal(currentCallPage('/iq/projects/p-auth-migration', '?item=../other'), null);
  assert.equal(canonicalCallPageHref({ kind: 'work-item', id: 'wi-auth-cookie' }, 'p-auth-migration'), page.href);
});

test('wire validation rejects mismatched projects, noncanonical navigation and malformed revisions', () => {
  assert.deepEqual(readCallPageSnapshot(snapshot(2)), snapshot(2));
  assert.deepEqual(readCallPageSnapshot(snapshot(3, null)), snapshot(3, null));
  assert.equal(readCallPageSnapshot({ ...snapshot(2), revision: -1 }), null);
  assert.equal(readCallPageSnapshot({ ...snapshot(2), revision: 1.5 }), null);
  assert.equal(readCallPageSnapshot(snapshot(2, { ...page, href: 'https://evil.test' })), null);
  assert.equal(readCallPageSnapshot(snapshot(2, { ...page, href: `${page.href}&view=comments` })), null);
  assert.equal(readCallPageSnapshot(snapshot(2, { ...page, kind: 'initiative' })), null);
  assert.equal(readCallPageSnapshot(snapshot(2, { ...page, sharedAt: 'invalid' })), null);
});

test('revisions reconcile peer replacement/clear and never restore an older pin', () => {
  const old = snapshot(2);
  const cleared = reconcileCallPage(old, snapshot(3, null), 'call-1');
  assert.deepEqual(cleared, snapshot(3, null));
  assert.equal(reconcileCallPage(cleared, old, 'call-1'), cleared);
  assert.equal(reconcileCallPage(cleared, snapshot(4, page, 'call-old'), 'call-1'), cleared);
  assert.equal(reconcileCallPage(cleared, snapshot(3), 'call-1'), cleared);
});

test('client sends only descriptor and revision with the session cookie, and reads conflict snapshots', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const responses = [new Response(JSON.stringify(snapshot(2, page, 'call/1')), { status: 200 }),
    new Response(JSON.stringify(snapshot(3, null)), { status: 200 }),
    new Response(JSON.stringify({ error: 'Shared page changed', snapshot: snapshot(4) }), { status: 409 })];
  const client = createCallPageClient((async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return responses.shift()!;
  }) as typeof fetch);
  await client.write('call/1', 1, { kind: page.kind, id: page.id });
  assert.equal(requests[0]!.url, '/api/calls/call%2F1/page');
  assert.equal(requests[0]!.init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { expectedRevision: 1, page: { kind: 'work-item', id: 'wi-auth-cookie' } });
  await client.write('call-1', 2, null);
  assert.equal(requests[1]!.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { expectedRevision: 2 });
  await assert.rejects(client.write('call-1', 3, { kind: page.kind, id: page.id }), (error: unknown) => {
    assert.ok(error instanceof CallPageRequestError);
    assert.equal(error.status, 409);
    assert.deepEqual(error.snapshot, snapshot(4));
    return true;
  });
});

test('client refuses successful responses for another call or an unsafe link', async () => {
  const client = createCallPageClient((async () => new Response(JSON.stringify(snapshot(2, page, 'call-other')), { status: 200 })) as typeof fetch);
  await assert.rejects(client.read('call-1'), /response was invalid/);
});

test('a pin survives current-route navigation; only an explicit write replaces it', async () => {
  let writes = 0;
  const client: CallPageClient = { read: async () => snapshot(1), write: async (_callId, revision, descriptor) => {
    writes++;
    assert.equal(revision, 1);
    assert.deepEqual(descriptor, { kind: 'initiative', id: 'p-soc2' });
    return snapshot(2, { ...page, kind: 'initiative', id: 'p-soc2', title: 'SOC2',
      href: '/iq/projects/p-soc2', project: { id: 'p-soc2', title: 'SOC2', href: '/iq/projects/p-soc2' } });
  } };
  const session = new CallPageSession(client);
  session.setScope(scope);
  await session.refresh();
  const nextRoute = currentCallPage('/iq/projects/p-soc2');
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(1));
  assert.equal(writes, 0);
  await session.share(nextRoute);
  assert.equal(writes, 1);
  assert.equal(session.getSnapshot().snapshot?.page?.id, 'p-soc2');
});

test('failed saves keep the acknowledged snapshot and surface the error', async () => {
  const session = new CallPageSession({ read: async () => snapshot(2), write: async () => { throw new Error('Redis unavailable'); } });
  session.setScope(scope);
  await session.refresh();
  await session.share(null);
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(2));
  assert.equal(session.getSnapshot().error, 'Redis unavailable');
  assert.equal(session.getSnapshot().pending, false);
});

test('a 409 reconciles the authoritative peer update and requires another explicit write', async () => {
  let writes = 0;
  const session = new CallPageSession({ read: async () => snapshot(2), write: async () => {
    writes++;
    throw new CallPageRequestError(409, 'Shared page changed', snapshot(3, null));
  } });
  session.setScope(scope);
  await session.refresh();
  await session.share({ kind: page.kind, id: page.id });
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(3, null));
  assert.equal(session.getSnapshot().error, 'Shared page changed');
  assert.equal(writes, 1);
});

test('delayed read/write responses and errors cannot leak into a new call or actor', async () => {
  const read = deferred<CallPageSnapshot>();
  const write = deferred<CallPageSnapshot>();
  const session = new CallPageSession({ read: () => read.promise, write: () => write.promise });
  session.setScope(scope);
  const reading = session.refresh();
  session.receive(snapshot(1));
  const writing = session.share(null);
  session.setScope({ ...scope, callId: 'call-2', actorId: 'u-nora' });
  read.resolve(snapshot(2));
  write.reject(new Error('old actor cannot save'));
  await Promise.all([reading, writing]);
  assert.equal(session.getSnapshot().snapshot, null);
  assert.equal(session.getSnapshot().error, null);
  assert.equal(session.getSnapshot().pending, false);
});

test('peer updates beat a delayed replay and old read failures', async () => {
  const read = deferred<CallPageSnapshot>();
  const session = new CallPageSession({ read: () => read.promise, write: async () => snapshot(1) });
  session.setScope(scope);
  const reading = session.refresh();
  session.receive(snapshot(5, null));
  read.resolve(snapshot(4));
  await reading;
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(5, null));
  const failure = deferred<CallPageSnapshot>();
  const other = new CallPageSession({ read: () => failure.promise, write: async () => snapshot(1) });
  other.setScope(scope);
  const failing = other.refresh();
  other.receive(snapshot(6));
  failure.reject(new Error('stale request failed'));
  await failing;
  assert.equal(other.getSnapshot().error, null);
});

test('registration replay retries a raced 403/404 and then enables writes', async () => {
  let reads = 0;
  const session = new CallPageSession({ read: async () => {
    reads++;
    if (reads === 1) throw new CallPageRequestError(403, 'Not a call participant');
    if (reads === 2) throw new CallPageRequestError(404, 'Call not found');
    return snapshot(0, null);
  }, write: async () => snapshot(1) }, [0, 0]);
  session.setScope(scope);
  await session.refresh({ retryRegistration: true });
  assert.equal(reads, 3);
  assert.equal(session.getSnapshot().loaded, true);
  assert.equal(session.getSnapshot().error, null);
  await session.share({ kind: page.kind, id: page.id });
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(1));
});

test('in-flight writes serialize and cannot overwrite a newer live update', async () => {
  const write = deferred<CallPageSnapshot>();
  let writes = 0;
  const session = new CallPageSession({ read: async () => snapshot(2), write: () => { writes++; return write.promise; } });
  session.setScope(scope);
  await session.refresh();
  const saving = session.share(null);
  await session.share(null);
  session.receive(snapshot(4));
  write.resolve(snapshot(3, null));
  await saving;
  assert.equal(writes, 1);
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(4));
});

test('same-user masquerade provenance changes fence pending receipts', async () => {
  const read = deferred<CallPageSnapshot>();
  const session = new CallPageSession({ read: () => read.promise, write: async () => snapshot(1) });
  session.setScope({ ...scope, identityKey: 'actor:a:epoch:1' });
  const loading = session.refresh();
  session.setScope({ ...scope, identityKey: 'actor:b:epoch:2' });
  read.resolve(snapshot(3));
  await loading;
  assert.equal(session.getSnapshot().snapshot, null);
  assert.equal(session.getSnapshot().error, null);
});

test('only the presenter or caller gets the Stop sharing control', () => {
  assert.equal(canStopSharingCallPage(page, 'u-vera', 'u-host'), true);
  assert.equal(canStopSharingCallPage(page, 'u-host', 'u-host'), true);
  assert.equal(canStopSharingCallPage(page, 'u-peer', 'u-host'), false);
  assert.equal(canStopSharingCallPage(page, null, 'u-host'), false);
  assert.equal(canStopSharingCallPage(null, 'u-host', 'u-host'), false);
});

test('an older replay cannot erase a failed save explanation', async () => {
  const read = deferred<CallPageSnapshot>();
  const session = new CallPageSession({ read: () => read.promise, write: async () => { throw new Error('Could not save'); } });
  session.setScope(scope);
  session.receive(snapshot(2));
  const loading = session.refresh();
  await session.share(null);
  read.resolve(snapshot(2));
  await loading;
  assert.equal(session.getSnapshot().error, 'Could not save');
  assert.deepEqual(session.getSnapshot().snapshot, snapshot(2));
});
