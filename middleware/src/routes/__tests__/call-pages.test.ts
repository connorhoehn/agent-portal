jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import type { RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { callPagesRouter } from '../call-pages.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallPageRuntime, MemoryCallPageStore, observeCallPageLifecycle, setCallPageRuntime, canonicalCallPage, type RecoverableCallStateStore } from '../../lib/call-pages.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import { getWorkItem } from '../../providers/work-items.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1';
const descriptor = { kind: 'work-item', id: 'wi-auth' };
const alice: Session = { sub: 'alice', name: 'Forged cookie name', tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'] }, iat: 100 };
const bob: Session = { ...alice, sub: 'bob' };
const charlie: Session = { ...alice, sub: 'charlie' };
let users: Map<string, UserInfo>;
let sessions: Map<string, Session>;
let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore;
let pages: MemoryCallPageStore;
let runtime: CallPageRuntime;
let sent: jest.Mock;
let router: RealtimeRouter;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/calls', callPagesRouter); app.use(errorHandler);
const http = (user: string, method: 'get' | 'put' | 'delete' = 'get', callId = CALL) => request(app)[method](`/api/calls/${callId}/page`).set('x-user', user);
const context = (session: Session) => ({ userId: session.sub, displayName: session.name, org: session.tenant, role: session.role,
  epoch: session.epoch ?? 0, sessionIat: session.iat, ...(session.act ? { act: { sub: session.act.sub, epoch: session.act.epoch ?? 0 } } : {}) });
function buildRuntime(canonical?: typeof canonicalCallPage, presenterGraceMs?: number) {
  return new CallPageRuntime({ calls, pages, router, lobbyAllowed: (auth, lobby) => lobby.startsWith('orgiq:') && String(lobby).split(':').includes(String(auth.userId)), canonical, presenterGraceMs });
}
beforeEach(async () => {
  users = new Map([alice, bob, charlie].map(s => [s.sub, { id: s.sub, displayName: `${s.sub} Directory`, email: null, personId: null, grants: s.grants, epoch: 0 }]));
  sessions = new Map([alice, bob, charlie].map(s => [s.sub, { ...s }]));
  contexts = new Map([['a', context(alice)], ['b', context(bob)], ['c', context(charlie)], ['unrelated', context(bob)]]);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(getProject).mockImplementation(async id => id === 'p-auth' ? { id, name: 'Auth Migration' } as Awaited<ReturnType<typeof getProject>> : null);
  jest.mocked(getWorkItem).mockImplementation(async id => id === 'wi-auth' ? { id, title: 'Cutover runbook', projectId: 'p-auth' } as Awaited<ReturnType<typeof getWorkItem>> : null);
  calls = new InMemoryCallStateStore(); pages = new MemoryCallPageStore(); sent = jest.fn();
  router = { sendToClient: sent, sendToChannel: jest.fn(), isClientLive: id => contexts.has(id), getClientData: id => ({ userContext: contexts.get(id) }) };
  await calls.registerParticipant(CALL, 'a', 'alice', 'orgiq:dm:alice:bob:charlie', ['bob', 'charlie']);
  await calls.registerParticipant(CALL, 'b', 'alice', 'orgiq:dm:alice:bob:charlie', ['bob', 'charlie']);
  runtime = buildRuntime(); setCallPageRuntime(runtime);
  await runtime.captureCaller(CALL, 'a');
});
afterEach(() => { runtime.dispose(); setCallPageRuntime(null); jest.restoreAllMocks(); });

it('shares canonical metadata with registered participants only and replays the pinned page', async () => {
  expect((await request(app).get('/api/calls/call-1/page').set('x-user', 'alice')).body).toEqual({ type: 'call-page', callId: CALL, revision: 0, page: null });
  const response = await request(app).put('/api/calls/call-1/page').set('x-user', 'alice').send({ expectedRevision: 0, page: descriptor });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ type: 'call-page', callId: CALL, revision: 1, page: { ...descriptor, title: 'Cutover runbook',
    href: '/iq/projects/p-auth?tab=work&item=wi-auth', project: { id: 'p-auth', title: 'Auth Migration', href: '/iq/projects/p-auth' },
    presenter: { userId: 'alice', displayName: 'alice Directory' } } });
  expect(Number.isNaN(Date.parse(response.body.page.sharedAt))).toBe(false);
  expect(response.body.caller).toBeUndefined(); expect(response.body.page.provenance).toBeUndefined();
  expect(sent.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
  expect((await http('bob')).body).toEqual(response.body);
  expect((await http('charlie')).status).toBe(403);
  sent.mockClear();
  await runtime.replay(CALL, 'b');
  expect(sent).toHaveBeenCalledWith('b', response.body);
  expect(getUser).toHaveBeenCalledWith('alice', { authoritative: true });
});

it('one simultaneous expected revision wins; conflicts return the current page without overwriting it', async () => {
  const responses = await Promise.all([http('alice', 'put').send({ expectedRevision: 0, page: descriptor }),
    http('bob', 'put').send({ expectedRevision: 0, page: { kind: 'initiative', id: 'p-auth' } })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = responses.find(r => r.status === 200)!;
  expect(responses.find(r => r.status === 409)!.body.snapshot).toEqual(winner.body);
  expect((await http('alice')).body).toEqual(winner.body);
  expect(sent).toHaveBeenCalledTimes(2);
});

it('only presenter or caller can clear and clear keeps a monotonic null tombstone', async () => {
  await http('alice', 'put').send({ expectedRevision: 0, page: descriptor });
  expect((await http('bob', 'delete').send({ expectedRevision: 1 })).status).toBe(403);
  const clear = await request(app).delete('/api/calls/call-1/page').set('x-user', 'alice').send({ expectedRevision: 1 });
  expect(clear.body).toEqual({ type: 'call-page', callId: CALL, revision: 2, page: null });
  const stale = await http('bob', 'put').send({ expectedRevision: 1, page: descriptor });
  expect(stale.status).toBe(409); expect(stale.body.snapshot).toEqual(clear.body);
  expect((await http('bob', 'put').send({ expectedRevision: 2, page: descriptor })).body.revision).toBe(3);
  expect((await http('alice', 'delete').send({ expectedRevision: 3 })).body.revision).toBe(4);
});

it('proves caller from the first authenticated registration, so an unsolicited accept cannot nominate a different Stop-sharing owner', async () => {
  const id = 'unsolicited-accept';
  const observed = observeCallPageLifecycle(calls, () => runtime);
  // Mirrors the installed service's unsolicited accepted path: callerId can
  // differ from the authenticated first connection. It is not our proof.
  await observed.registerParticipant(id, 'b', 'alice', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  await observed.registerParticipant(id, 'a', 'alice', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  await observed.registerParticipant(id, 'c', 'alice', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  expect((await calls.getCall(id))?.callerId).toBe('alice');
  expect(await pages.get(id)).toMatchObject({ revision: 0, page: null, caller: { userId: 'bob' } });
  await http('charlie', 'put', id).send({ expectedRevision: 0, page: descriptor });
  expect((await http('alice', 'delete', id).send({ expectedRevision: 1 })).status).toBe(403);
  expect((await http('bob', 'delete', id).send({ expectedRevision: 1 })).status).toBe(200);
});

it('caller proof survives zero-seat grace and a runtime restart before any page was shared', async () => {
  expect(await pages.get(CALL)).toMatchObject({ revision: 0, page: null, caller: { userId: 'alice' } });
  await calls.removeParticipant(CALL, 'a'); await calls.removeParticipant(CALL, 'b');
  runtime.dispose(); runtime = buildRuntime(); setCallPageRuntime(runtime);
  const observed = observeCallPageLifecycle(calls, () => runtime);
  await observed.registerParticipant(CALL, 'b', 'bob', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  await observed.registerParticipant(CALL, 'a', 'bob', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  await observed.registerParticipant(CALL, 'c', 'bob', 'orgiq:dm:alice:bob:charlie', ['alice', 'charlie']);
  await http('charlie', 'put').send({ expectedRevision: 0, page: descriptor });
  expect((await http('bob', 'delete').send({ expectedRevision: 1 })).status).toBe(403);
  expect((await http('alice', 'delete').send({ expectedRevision: 1 })).status).toBe(200);
});

it('atomic resume replays the existing pin and cancels presenter absence without recapturing caller proof', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  const original = await pages.get(CALL);
  await calls.removeParticipant(CALL, 'a'); contexts.delete('a'); await runtime.checkPresenter(CALL);
  runtime.dispose(); runtime = buildRuntime(); setCallPageRuntime(runtime); // Cold gateway with durable page/caller state.
  contexts.set('a-new', context(alice));
  const resume = jest.fn().mockImplementation(async (callId: string, clientId: string) => {
    const current = await calls.getCall(callId);
    await calls.setCall(callId, { ...current!, participantClientIds: [...current!.participantClientIds, clientId] }, 14400);
    return true;
  });
  const store = Object.assign(calls, { resumeParticipant: resume }) as RecoverableCallStateStore;
  const claim = jest.spyOn(pages, 'claimCaller'); const capture = jest.spyOn(runtime, 'captureCaller');
  const replay = jest.spyOn(runtime, 'replay'); sent.mockClear();
  const observed = observeCallPageLifecycle(store, () => runtime);
  expect(await observed.resumeParticipant!(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie', ['a'])).toBe(true);
  for (let i = 0; i < 60; i++) await Promise.resolve();
  expect(resume).toHaveBeenCalledWith(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie', ['a']);
  expect(replay).toHaveBeenCalledWith(CALL, 'a-new');
  expect(sent).toHaveBeenCalledWith('a-new', expect.objectContaining({ revision: 1, page: expect.objectContaining({ id: 'wi-auth' }) }));
  expect(claim).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  expect(await pages.get(CALL)).toEqual(original);
});

it('false atomic resume has no page, membership-read, replay, or caller-claim effects', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  const original = await pages.get(CALL); sent.mockClear();
  const resume = jest.fn().mockResolvedValue(false);
  const store = Object.assign(calls, { resumeParticipant: resume }) as RecoverableCallStateStore;
  const replay = jest.spyOn(runtime, 'replay'); const capture = jest.spyOn(runtime, 'captureCaller');
  const read = jest.spyOn(calls, 'getCall');
  const observed = observeCallPageLifecycle(store, () => runtime);
  expect(await observed.resumeParticipant!(CALL, 'unrelated', 'bob', 'orgiq:dm:alice:bob:charlie')).toBe(false);
  expect(read).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled(); expect(await pages.get(CALL)).toEqual(original);
});

it('a successful resume with an already departed authoritative roster does not replay metadata', async () => {
  const resume = jest.fn().mockResolvedValue(true);
  const store = Object.assign(calls, { resumeParticipant: resume }) as RecoverableCallStateStore;
  const replay = jest.spyOn(runtime, 'replay'); const read = jest.spyOn(calls, 'getCall');
  const observed = observeCallPageLifecycle(store, () => runtime);
  expect(await observed.resumeParticipant!(CALL, 'not-in-roster', 'alice', 'orgiq:dm:alice:bob:charlie')).toBe(true);
  expect(read).toHaveBeenCalledWith(CALL); expect(replay).not.toHaveBeenCalled();
});

it('replay tracks a restored revision-zero caller proof for maintenance, without renewing records whose call is gone', async () => {
  runtime.dispose(); jest.useFakeTimers();
  try {
    runtime = buildRuntime(); setCallPageRuntime(runtime);
    const claim = jest.spyOn(pages, 'claimCaller');
    await runtime.replay(CALL, 'b');
    const read = jest.spyOn(pages, 'get');
    jest.advanceTimersByTime(60000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(read).toHaveBeenCalledWith(CALL); expect(claim).not.toHaveBeenCalled();
    await calls.forgetCall(CALL); read.mockClear();
    jest.advanceTimersByTime(60000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('successful conditional prune clears the page only after the authoritative store commits it', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string }); sent.mockClear();
  const expected = (await calls.getCall(CALL))!;
  const prune = jest.fn().mockImplementation(async (callId: string) => { await calls.forgetCall(callId); return true; });
  const store = Object.assign(calls, { forgetCallIfUnchanged: prune }) as RecoverableCallStateStore;
  const finish = jest.spyOn(runtime, 'finish');
  const observed = observeCallPageLifecycle(store, () => runtime);
  expect(await observed.forgetCallIfUnchanged!(CALL, expected)).toBe(true);
  expect(prune).toHaveBeenCalledWith(CALL, expected); expect(finish).toHaveBeenCalledWith(CALL, expected.participantClientIds);
  expect(sent).toHaveBeenCalledWith('b', { type: 'call-page', callId: CALL, revision: 2, page: null });
  expect(await pages.get(CALL)).toEqual({ revision: 0, page: null });
  await expect(runtime.get(CALL, bob)).rejects.toMatchObject({ status: 404 });
});

it('false conditional prune leaves the original pin and active call usable', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string }); sent.mockClear();
  const original = await pages.get(CALL); const expected = (await calls.getCall(CALL))!;
  const prune = jest.fn().mockResolvedValue(false);
  const store = Object.assign(calls, { forgetCallIfUnchanged: prune }) as RecoverableCallStateStore;
  const finish = jest.spyOn(runtime, 'finish'); const forget = jest.spyOn(pages, 'forget');
  const observed = observeCallPageLifecycle(store, () => runtime);
  expect(await observed.forgetCallIfUnchanged!(CALL, expected)).toBe(false);
  expect(finish).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  expect(await pages.get(CALL)).toEqual(original); expect((await runtime.get(CALL, alice)).revision).toBe(1);
});

it.each(['resumeParticipant', 'forgetCallIfUnchanged'] as const)('a failed atomic %s operation does not change the page lifecycle', async key => {
  const method = jest.fn().mockRejectedValue(new Error('Redis unavailable'));
  const store = Object.assign(calls, { [key]: method }) as RecoverableCallStateStore;
  const finish = jest.spyOn(runtime, 'finish'); const replay = jest.spyOn(runtime, 'replay'); const capture = jest.spyOn(runtime, 'captureCaller');
  const observed = observeCallPageLifecycle(store, () => runtime);
  const request = key === 'resumeParticipant'
    ? observed.resumeParticipant!(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie')
    : observed.forgetCallIfUnchanged!(CALL, (await calls.getCall(CALL))!);
  await expect(request).rejects.toThrow('Redis unavailable');
  expect(finish).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
});

it('rejects arbitrary URLs, titles, actors, kinds, and malformed revisions without changing the reference', async () => {
  for (const input of [
    { expectedRevision: 0, page: { ...descriptor, href: 'https://attacker.invalid' } },
    { expectedRevision: 0, page: descriptor, presenter: 'bob' },
    { expectedRevision: -1, page: descriptor }, { expectedRevision: 0.2, page: descriptor },
    { expectedRevision: 0, page: { kind: 'url', id: 'p-auth' } },
  ]) expect((await http('alice', 'put').send(input)).status).toBe(400);
  expect((await pages.get(CALL)).revision).toBe(0); expect(sent).not.toHaveBeenCalled();
  expect((await http('alice', 'put').send({ expectedRevision: 0, page: { kind: 'initiative', id: 'missing' } })).status).toBe(404);
});

it('does not reuse another tab or tenant, role, epoch, or masquerade provenance as call membership', async () => {
  for (const change of [{ tenant: 'social', role: 'participant' }, { role: 'sme' }, { epoch: 1 },
    { act: { sub: 'operator', epoch: 0, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } }]) {
    const s = { ...alice, ...change } as Session;
    sessions.set('alice', s); users.get('alice')!.epoch = s.epoch ?? 0;
    users.get('alice')!.grants = { orgiq: ['member', 'sme'], social: ['participant'] };
    users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 0, grants: { orgiq: ['admin'] } });
    expect((await http('alice', 'put').send({ expectedRevision: 0, page: descriptor })).status).toBe(403);
  }
  expect((await pages.get(CALL)).revision).toBe(0); expect(sent).not.toHaveBeenCalled();
});

it('checks current effective and actor authority, fails closed on outages, and filters revoked recipients', async () => {
  users.get('bob')!.grants = {};
  expect((await http('alice', 'put').send({ expectedRevision: 0, page: descriptor })).status).toBe(200);
  expect(sent.mock.calls.map(([id]) => id)).toEqual(['a']);
  expect((await http('bob')).status).toBe(401);
  users.get('alice')!.epoch = 1;
  expect((await http('alice')).status).toBe(401);
  users.get('alice')!.epoch = 0;
  jest.mocked(getUser).mockRejectedValue(new Error('database unavailable'));
  expect((await http('alice', 'put').send({ expectedRevision: 1, page: descriptor })).status).toBe(503);
  expect((await pages.get(CALL)).revision).toBe(1);
});

it('masquerade participant must still have a current administrator actor', async () => {
  const act: NonNullable<Session['act']> = { sub: 'operator', role: 'admin', tenant: 'orgiq', epoch: 7, grants: { orgiq: ['admin'] } };
  const s = { ...alice, act }; sessions.set('alice', s); contexts.set('a', context(s));
  users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 7, grants: { orgiq: ['admin'] } });
  expect((await http('alice', 'put').send({ expectedRevision: 0, page: descriptor })).status).toBe(200);
  users.get('operator')!.grants = { orgiq: ['member'] };
  expect((await http('alice')).status).toBe(401);
  expect(sent.mock.calls.some(([, snapshot]) => snapshot.page?.presenter.userId === 'operator')).toBe(false);
});

it('late canonical reads cannot recreate an ended call or publish to a participant who left', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  runtime.dispose(); runtime = buildRuntime(async page => { started(); await barrier; return canonicalCallPage(page); }); setCallPageRuntime(runtime);
  const write = runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  await ready;
  const ending = runtime.finish(CALL);
  release();
  await expect(write).rejects.toMatchObject({ status: 404 }); await ending;
  expect((await pages.get(CALL)).revision).toBe(0); expect(sent).not.toHaveBeenCalled();
  expect((await http('alice')).status).toBe(404);
});

it('rechecks membership after a slow recipient resource read', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  runtime.dispose(); runtime = buildRuntime(async page => { if (++reads === 3) { started(); await barrier; } return canonicalCallPage(page); }); setCallPageRuntime(runtime);
  const write = runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  await ready; await calls.removeParticipant(CALL, 'b'); release(); await write;
  expect(sent.mock.calls.map(([id]) => id)).toEqual(['a']);
});

it('rechecks directory authority after a slow recipient resource read even when socket and roster stay connected', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  runtime.dispose(); runtime = buildRuntime(async page => { if (++reads === 3) { started(); await barrier; } return canonicalCallPage(page); }); setCallPageRuntime(runtime);
  const write = runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  await ready; users.get('bob')!.grants = {}; release(); await write;
  expect(sent.mock.calls.map(([id]) => id)).toEqual(['a']);
});

it('departure during a delayed CAS restores the previous page with a newer revision and never publishes the departed actor’s pin', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string }); sent.mockClear();
  const compare = pages.compareAndSet.bind(pages);
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(pages, 'compareAndSet').mockImplementationOnce(async (...args) => { started(); await barrier; return compare(...args); });
  const write = runtime.put(CALL, bob, 1, { kind: 'initiative', id: 'p-auth' });
  await ready; await calls.removeParticipant(CALL, 'b'); contexts.delete('b'); release();
  await expect(write).rejects.toMatchObject({ status: 403 });
  const stored = await pages.get(CALL);
  expect(stored.revision).toBe(3); expect(stored.page?.presenter.userId).toBe('alice');
  expect(sent.mock.calls).toEqual([['a', expect.objectContaining({ revision: 3, page: expect.objectContaining({ kind: 'work-item', presenter: { userId: 'alice', displayName: 'alice Directory' } }) })]]);
});

it('does not return a conflict page after its requester leaves during canonical resolution', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  let release!: () => void; let started!: () => void; let reads = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  runtime.dispose(); runtime = buildRuntime(async page => { if (++reads === 2) { started(); await barrier; } return canonicalCallPage(page); }); setCallPageRuntime(runtime);
  const write = runtime.put(CALL, bob, 0, { kind: 'initiative', id: 'p-auth' });
  await ready; await calls.removeParticipant(CALL, 'b'); contexts.delete('b'); release();
  await expect(write).rejects.toMatchObject({ status: 403 });
  expect((await pages.get(CALL)).revision).toBe(1);
});

it('zero connected seats during rejoin grace does not terminally fence a returning participant', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  const observed = observeCallPageLifecycle(calls, () => runtime);
  await observed.removeParticipant(CALL, 'a'); contexts.delete('a');
  await observed.removeParticipant(CALL, 'b'); contexts.delete('b');
  contexts.set('a-new', context(alice));
  await observed.registerParticipant(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie', ['bob']);
  expect((await runtime.get(CALL, alice)).revision).toBe(1);
});

it('revoked or changed-provenance presenter sockets do not cancel the absence grace', async () => {
  jest.useFakeTimers();
  try {
    runtime.dispose(); runtime = buildRuntime(undefined, 1000); setCallPageRuntime(runtime);
    await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
    users.get('alice')!.epoch = 1; // Still connected, but no longer authoritative.
    await runtime.checkPresenter(CALL); jest.advanceTimersByTime(1000);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(await pages.get(CALL)).toMatchObject({ revision: 2, page: null });
    expect(sent.mock.calls.some(([id, snapshot]) => id === 'b' && snapshot.revision === 2)).toBe(true);
  } finally { jest.useRealTimers(); }
});

it('decorated registration replays and forget cleans up the page with a final tombstone', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string }); sent.mockClear();
  const observed = observeCallPageLifecycle(calls, () => runtime);
  contexts.set('a-new', context(alice));
  await observed.registerParticipant(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie', ['bob', 'charlie']);
  await runtime.replay(CALL, 'a-new');
  expect(sent).toHaveBeenCalledWith('a-new', expect.objectContaining({ revision: 1 })); sent.mockClear();
  await observed.forgetCall(CALL);
  expect(sent).toHaveBeenCalledWith('b', { type: 'call-page', callId: CALL, revision: 2, page: null });
  expect(await calls.getCall(CALL)).toBeNull(); expect(await pages.get(CALL)).toEqual({ revision: 0, page: null });
});

it('presenter reconnect preserves the page through grace; prolonged absence clears it', async () => {
  jest.useFakeTimers();
  try {
    runtime.dispose(); runtime = buildRuntime(undefined, 1000); setCallPageRuntime(runtime);
    await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
    await calls.removeParticipant(CALL, 'a'); contexts.delete('a'); await runtime.checkPresenter(CALL);
    jest.advanceTimersByTime(500);
    contexts.set('a-new', context(alice)); await calls.registerParticipant(CALL, 'a-new', 'alice', 'orgiq:dm:alice:bob:charlie', ['bob']);
    await runtime.replay(CALL, 'a-new'); jest.advanceTimersByTime(600); expect((await pages.get(CALL)).revision).toBe(1);
    await calls.removeParticipant(CALL, 'a-new'); contexts.delete('a-new'); await runtime.checkPresenter(CALL);
    jest.advanceTimersByTime(1000);
    // Flush the async timer's authoritative reads/fanout, not a wall-clock wait.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(await pages.get(CALL)).toMatchObject({ revision: 2, page: null });
  } finally { jest.useRealTimers(); }
});

it('GET refreshes canonical metadata and gateway disposal reports unavailable', async () => {
  await runtime.put(CALL, alice, 0, descriptor as { kind: 'work-item'; id: string });
  jest.mocked(getWorkItem).mockResolvedValue({ id: 'wi-auth', projectId: 'p-auth', title: 'Updated canonical title' } as Awaited<ReturnType<typeof getWorkItem>>);
  expect((await http('bob')).body.page.title).toBe('Updated canonical title');
  setCallPageRuntime(null); expect((await http('alice')).status).toBe(503);
});
