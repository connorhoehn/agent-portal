jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async (p: { tenant: string; role: string }, action: string) => p.tenant === 'social'
    && p.role === 'participant' && ['ViewSocial', 'PostMessage'].includes(action)) }));

// The resolver (GET /api/calls/:callId/chat) and the membership mirror behind
// the gateway's huddle chat. Messages here are written the way the chat service
// writes them (its ChatStore, on the call's channel); the socket contracts —
// subscribe/publish/history/typing/reactions/pins refusals — are in
// lib/__tests__/call-chat-gateway.test.ts.
import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { InMemoryChatStore, MemoryChatMembershipStore, type ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { callChatRouter } from '../call-chat.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, huddleMembershipStore, inCallChatNamespace, setCallChatRuntime } from '../../lib/call-chat.js';
import { huddleSendInput, REFERENCE_ONLY_BODY } from '../../lib/call-chat-send.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { canonicalCallPage, observeCallPageLifecycle, type RecoverableCallStateStore } from '../../lib/call-pages.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import { getWorkItem } from '../../providers/work-items.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:charlie'; const CHANNEL = callChatChannel(CALL);
const page = { kind: 'work-item' as const, id: 'wi-auth' };
const base: Session = { sub: 'alice', name: 'Forged cookie label', tenant: 'orgiq', role: 'member', epoch: 0,
  grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 };
const bob: Session = { ...base, sub: 'bob' }; const charlie: Session = { ...base, sub: 'charlie' };
let users: Map<string, UserInfo>; let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let observed: RecoverableCallStateStore;
let messages: InMemoryChatStore; let state: MemoryCallChatStateStore; let runtime: CallChatRuntime;
let sent: jest.Mock; let router: RealtimeRouter; let clock: number;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/calls', callChatRouter); app.use(errorHandler);
const get = (user = 'alice') => request(app).get('/api/calls/call-1/chat').set('x-user', user);
const context = (session: Session) => ({ userId: session.sub, org: session.tenant, role: session.role,
  displayName: 'Forged socket label', epoch: session.epoch ?? 0, sessionIat: session.iat,
  ...(session.act ? { act: { sub: session.act.sub, epoch: session.act.epoch ?? 0 } } : {}) });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
/** What the chat service stores for a send on the call's channel. */
let sequence = 0;
async function say(user: string, text: string, extra: Record<string, unknown> = {}, at = clock): Promise<ChatMessage> {
  const message: ChatMessage = { id: `m-${++sequence}`, clientId: user[0]!, userId: user, channel: CHANNEL, message: text,
    timestamp: new Date(at).toISOString(), metadata: { displayName: `${user} Directory`, clientDeliveryId: `d-${sequence}`, ...extra } };
  await messages.putMessage(message);
  return message;
}
function makeRuntime(canonical?: typeof canonicalCallPage) {
  return new CallChatRuntime({ calls, state, messages, router, canonical, maintenanceIntervalMs: 0, now: () => clock,
    lobbyAllowed: (auth, lobby) => lobby.startsWith('orgiq:') && lobby.split(':').includes(String(auth.userId)) });
}
beforeEach(async () => {
  clock = Date.parse('2026-10-06T12:00:00.000Z');
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && p.role === 'participant' && ['ViewSocial', 'PostMessage'].includes(action));
  users = new Map([base, bob, charlie].map(s => [s.sub, { id: s.sub, displayName: `${s.sub} Directory`, email: null,
    personId: null, epoch: 0, grants: structuredClone(s.grants) }]));
  sessions = new Map([base, bob, charlie].map(s => [s.sub, { ...s }]));
  contexts = new Map([['a', context(base)], ['b', context(bob)], ['c', context(charlie)], ['unrelated-tab', context(bob)]]);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(getProject).mockImplementation(async id => id === 'p-auth' ? { id, name: 'Auth Migration' } as Awaited<ReturnType<typeof getProject>> : null);
  jest.mocked(getWorkItem).mockImplementation(async id => id === 'wi-auth' ? { id, projectId: 'p-auth', title: 'Cutover runbook' } as Awaited<ReturnType<typeof getWorkItem>> : null);
  calls = new InMemoryCallStateStore(); messages = new InMemoryChatStore(); state = new MemoryCallChatStateStore(); sent = jest.fn();
  router = { sendToClient: sent, sendToChannel: jest.fn(), isClientLive: id => contexts.has(id),
    getClientData: id => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() };
  runtime = makeRuntime(); setCallChatRuntime(runtime);
  observed = observeCallPageLifecycle(calls, () => null, () => runtime);
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob', 'charlie']);
  await observed.registerParticipant(CALL, 'b', 'alice', LOBBY, ['bob', 'charlie']); sent.mockClear();
  clock += 1000;
});
afterEach(() => { runtime.dispose(); setCallChatRuntime(null); jest.restoreAllMocks(); });

it('resolves the actual huddle channel, audience and replay, rendering canonical references and dropping private metadata', async () => {
  const stored = await say('alice', 'Hello huddle', { pageReference: page, _requestHash: 'private', html: '<b>x</b>' });
  const initial = await get();
  expect(initial.status).toBe(200);
  expect(initial.body).toMatchObject({ callId: CALL, channel: CHANNEL, revision: 2, canSend: true,
    participants: [{ userId: 'alice', displayName: 'alice Directory' }, { userId: 'bob', displayName: 'bob Directory' }] });
  expect(initial.body.messages).toEqual([{ id: stored.id, clientId: 'a', userId: 'alice', channel: CHANNEL, message: 'Hello huddle',
    timestamp: stored.timestamp, metadata: { displayName: 'alice Directory', clientDeliveryId: stored.metadata!['clientDeliveryId'],
      pageReference: { status: 'available', ...page, title: 'Cutover runbook', href: '/iq/projects/p-auth?tab=work&item=wi-auth',
        project: expect.objectContaining({ id: 'p-auth' }), breadcrumbs: expect.any(Array) } } }]);
  expect((await get('bob')).body.messages).toEqual(initial.body.messages);
  expect((await get('charlie')).status).toBe(403);
  expect((await request(app).get('/api/calls/call-1/chat')).status).toBe(401);
  for (const limit of ['0', '101', '-1', 'abc', '1.5']) expect((await get().query({ limit })).status).toBe(400);
  expect(inCallChatNamespace('orgiq:huddle')).toBe(true); expect(inCallChatNamespace(CHANNEL)).toBe(true);
  // The HTTP send and typing routes are gone: both ride the gateway channel.
  expect((await request(app).post('/api/calls/call-1/chat/messages').set('x-user', 'alice').send({ text: 'x', clientDeliveryId: 'id' })).status).toBe(404);
  expect((await request(app).post('/api/calls/call-1/chat/typing').set('x-user', 'alice').send({ typing: true })).status).toBe(404);
});

it('cancels superseded lifecycle reconciliation without reviving a removed member or hiding provider failures', async () => {
  const started = deferred(), release = deferred();
  const alice = users.get('alice')!;
  jest.mocked(getUser).mockImplementationOnce(async () => { started.resolve(); await release.promise; return alice; });
  const prior = runtime.restored(CALL, (await calls.getCall(CALL))!);
  await started.promise;
  await observed.removeParticipant(CALL, 'b');
  await runtime.restored(CALL, (await calls.getCall(CALL))!);
  release.resolve(); await expect(prior).resolves.toBeUndefined();
  expect((await state.get(CALL)).members.bob?.active).toBe(false);
  const peers = sent.mock.calls.filter(([, frame]) => frame.type === 'call-chat' && frame.action === 'members');
  expect(peers.length).toBeGreaterThan(0);
  expect(peers.at(-1)?.[1].participants).toEqual([{ userId: 'alice', displayName: 'alice Directory' }]);
  jest.mocked(getUser).mockRejectedValueOnce(new Error('Directory outage'));
  await expect(runtime.restored(CALL, (await calls.getCall(CALL))!)).rejects.toMatchObject({ status: 503 });
});

it('new participants start at their join boundary, even for a message in the same millisecond; resume preserves the prior floor', async () => {
  const first = await say('alice', 'Before Charlie joined');
  await observed.registerParticipant(CALL, 'c', 'alice', LOBBY, ['bob', 'charlie']);
  // Stamped the same millisecond as the join: strictly-after hides it.
  await say('alice', 'Same instant as the join');
  expect((await get('charlie')).body.messages).toEqual([]);
  clock += 1;
  const second = await say('alice', 'After Charlie joined');
  expect((await get('charlie')).body.messages.map((m: { id: string }) => m.id)).toEqual([second.id]);
  expect(await runtime.memberFloor(CALL, 'charlie')).toBe(clock - 1);
  const floor = (await state.get(CALL)).members.bob!;
  await observed.removeParticipant(CALL, 'b'); contexts.delete('b'); contexts.set('b-new', context(bob));
  const store = Object.assign(calls, { resumeParticipant: jest.fn(async (id: string, clientId: string) => {
    const current = await calls.getCall(id); await calls.setCall(id, { ...current!, participantClientIds: [...current!.participantClientIds, clientId] }, 14400); return true;
  }) });
  const recovering = observeCallPageLifecycle(store, () => null, () => runtime);
  expect(await recovering.resumeParticipant!(CALL, 'b-new', 'bob', LOBBY, ['b'])).toBe(true);
  expect((await state.get(CALL)).members.bob).toEqual(floor);
  expect((await get('bob')).body.messages.map((m: { id: string }) => m.id)).toContain(first.id);
});

it('admits only actual seats, coalesces users, and immediately revokes and unsubscribes departed seats', async () => {
  contexts.set('a-second', context(base)); await observed.registerParticipant(CALL, 'a-second', 'alice', LOBBY, ['bob']);
  expect((await get()).body.participants).toHaveLength(2);
  for (const seat of ['a', 'a-second', 'b']) await expect(runtime.assertSeat(CALL, seat, true)).resolves.toBeUndefined();
  // Bob's other tab is the same person, but not a seat of this call.
  await expect(runtime.assertSeat(CALL, 'unrelated-tab')).rejects.toMatchObject({ status: 403 });
  await expect(runtime.assertSeat(CALL, 'c')).rejects.toMatchObject({ status: 403 });
  await observed.removeParticipant(CALL, 'a');
  await expect(runtime.assertSeat(CALL, 'a')).rejects.toMatchObject({ status: 403 });
  await expect(runtime.assertSeat(CALL, 'a-second', true)).resolves.toBeUndefined();
  expect(router.unsubscribeFromChannel).toHaveBeenCalledWith('a', CHANNEL);
  expect(router.unsubscribeFromChannel).toHaveBeenCalledWith('a', `reactions:${CHANNEL}`);
  await observed.removeParticipant(CALL, 'a-second');
  expect((await get()).status).toBe(403);
  expect(await runtime.memberRows(CALL)).toEqual(expect.arrayContaining([
    expect.objectContaining({ userId: 'alice', removedAt: expect.any(String) }), expect.objectContaining({ userId: 'bob', removedAt: null })]));
});

it('a delayed seat check cannot restore access after Leave, and a REST label asks for the session seat instead', async () => {
  const started = deferred(), release = deferred();
  jest.mocked(getUser).mockImplementationOnce(async id => { started.resolve(); await release.promise; return users.get(id) ?? null; });
  const pending = runtime.assertSeat(CALL, 'b');
  await started.promise;
  runtime.invalidate(CALL, 'b'); await calls.removeParticipant(CALL, 'b'); release.resolve();
  await expect(pending).rejects.toMatchObject({ status: 403 });
  await expect(runtime.assertChannelAccess(CALL, 'http', base, true)).resolves.toBeUndefined();
  await expect(runtime.assertChannelAccess(CALL, 'rest:pins', bob, false)).rejects.toMatchObject({ status: 403 });
  // A connection id is never read as some other session's seat.
  await expect(runtime.assertChannelAccess(CALL, 'a', bob, false)).rejects.toMatchObject({ status: 403 });
});

it('repeated registration and another actual seat preserve a current participant history floor', async () => {
  const first = await say('alice', 'Kept'); const floor = (await state.get(CALL)).members.alice;
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob']);
  contexts.set('a-other', context(base)); await observed.registerParticipant(CALL, 'a-other', 'alice', LOBBY, ['bob']);
  expect((await state.get(CALL)).members.alice).toEqual(floor);
  expect((await get()).body.messages.map((m: { id: string }) => m.id)).toEqual([first.id]);
});

it('admits a current Work seat without Social grants or work dispatch permission, and revokes a retired Work grant', async () => {
  users.get('bob')!.grants.social = [];
  users.get('alice')!.grants.social = [];
  jest.mocked(isAllowed).mockResolvedValue(false);
  expect((await get('bob')).body).toMatchObject({ channel: CHANNEL, canSend: true });
  await expect(runtime.assertSeat(CALL, 'b', true)).resolves.toBeUndefined();
  expect(isAllowed).not.toHaveBeenCalledWith(expect.objectContaining({ tenant: 'social' }), expect.anything());
  expect(isAllowed).not.toHaveBeenCalledWith(expect.anything(), 'DispatchAgentRun');
  users.get('bob')!.grants.orgiq = [];
  expect((await get('bob')).status).toBe(401);
  await expect(runtime.assertSeat(CALL, 'b', true)).rejects.toMatchObject({ status: 401 });
});

it('replaces a deleted reference with an unavailable marker on replay', async () => {
  await say('alice', 'Shared a page', { pageReference: page });
  jest.mocked(getWorkItem).mockResolvedValue(null);
  expect((await get('bob')).body.messages[0].metadata.pageReference).toEqual({ status: 'unavailable', ...page });
});

it('does not cross calls, tenants, roles, epochs or masquerade provenance', async () => {
  await say('alice', 'Only this call');
  await observed.registerParticipant('other-call', 'a', 'alice', LOBBY, ['bob']);
  expect((await request(app).get('/api/calls/other-call/chat').set('x-user', 'alice')).body.messages).toEqual([]);
  for (const change of [{ tenant: 'social', role: 'participant' }, { role: 'sme' }, { epoch: 1 },
    { act: { sub: 'operator', epoch: 0, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } }]) {
    const session = { ...base, ...change } as Session; sessions.set('alice', session);
    users.get('alice')!.epoch = session.epoch ?? 0; users.get('alice')!.grants = { orgiq: ['member', 'sme'], social: ['participant'] };
    users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 0, grants: { orgiq: ['admin'] } });
    expect([401, 403]).toContain((await get()).status);
  }
});

it('slow history canonical reads cannot disclose contents after the requesting actor is revoked', async () => {
  await say('alice', 'Protected', { pageReference: page }); const started = deferred(); const release = deferred();
  runtime.dispose(); runtime = makeRuntime(async input => { started.resolve(); await release.promise; return canonicalCallPage(input); }); setCallChatRuntime(runtime);
  const pending = get('bob').then(value => value); await started.promise;
  users.get('bob')!.epoch += 1; release.resolve();
  const response = await pending; expect(response.status).toBe(401); expect(response.body.messages).toBeUndefined();
});

it('false resume/prune operations do not change chat membership or revision, while true prune is terminal and closes the namespace', async () => {
  const before = await state.get(CALL);
  const store = Object.assign(calls, { resumeParticipant: jest.fn().mockResolvedValue(false), forgetCallIfUnchanged: jest.fn().mockResolvedValue(false) });
  const recovering = observeCallPageLifecycle(store, () => null, () => runtime);
  expect(await recovering.resumeParticipant!(CALL, 'new', 'alice', LOBBY)).toBe(false);
  expect(await recovering.forgetCallIfUnchanged!(CALL, (await calls.getCall(CALL))!)).toBe(false);
  expect(await state.get(CALL)).toEqual(before);
  store.forgetCallIfUnchanged.mockImplementation(async id => { await calls.forgetCall(id); return true; });
  expect(await recovering.forgetCallIfUnchanged!(CALL, (await calls.getCall(CALL))!)).toBe(true);
  expect((await get()).status).toBe(404);
  await expect(runtime.assertSeat(CALL, 'a')).rejects.toMatchObject({ status: 404 });
  expect(await runtime.memberRows(CALL)).toEqual([expect.objectContaining({ userId: '', removedAt: expect.any(String) })]);
  expect(sent).toHaveBeenCalledWith('b', expect.objectContaining({ type: 'call-chat', action: 'ended', callId: CALL, revision: before.revision + 1 }));
  expect(router.unsubscribeFromChannel).toHaveBeenCalledWith('b', CHANNEL);
});

it('a delayed membership reconciliation cannot restore a departed seat or an ended call', async () => {
  const started = deferred(); const release = deferred();
  jest.mocked(getUser).mockImplementation(async id => { if (id === 'bob') { started.resolve(); await release.promise; } return users.get(id) ?? null; });
  const pending = get().then(value => value); await started.promise;
  runtime.invalidate(CALL, 'b'); await calls.removeParticipant(CALL, 'b'); release.resolve();
  expect((await pending).status).toBe(409);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  expect((await get()).body.participants).toEqual([{ userId: 'alice', displayName: 'alice Directory' }]);
  await runtime.finish(CALL, ['a']); await calls.forgetCall(CALL);
  await expect(runtime.registered(CALL, 'b')).rejects.toMatchObject({ status: 404 });
  expect((await state.get(CALL)).ended).toBe(true);
});

it('an explicit rejoin resets history even after a delayed reconciliation restores the old active flag', async () => {
  await say('alice', 'Before departure');
  const started = deferred(); const release = deferred(); const original = state.join.bind(state); let paused = false;
  jest.spyOn(state, 'join').mockImplementation(async (callId, userId, now, preserve) => {
    if (userId === 'bob' && preserve && !paused) { paused = true; started.resolve(); await release.promise; }
    return original(callId, userId, now, preserve);
  });
  const pending = get().then(value => value); await started.promise;
  await observed.removeParticipant(CALL, 'b'); contexts.delete('b');
  clock += 1000; await say('alice', 'While Bob was away'); clock += 1000;
  release.resolve(); expect((await pending).status).toBe(409);
  contexts.set('b-new', context(bob)); await observed.registerParticipant(CALL, 'b-new', 'alice', LOBBY, ['bob']);
  expect((await get('bob')).body.messages).toEqual([]);
});

it('membership rows close the namespace when there is no roster or the mirror fails, and refuse writes through the chat service', async () => {
  const base = new MemoryChatMembershipStore();
  const store = huddleMembershipStore(base, () => runtime);
  expect(await store.listMembers('orgiq:huddle:unknown')).toEqual([expect.objectContaining({ userId: '', removedAt: expect.any(String) })]);
  expect(await store.listMembers('orgiq:huddle')).toEqual([expect.objectContaining({ userId: '' })]);
  expect(await store.getMember(CHANNEL, 'alice')).toMatchObject({ userId: 'alice', removedAt: null });
  expect(await store.getMember(CHANNEL, 'charlie')).toBeNull();
  jest.spyOn(state, 'get').mockRejectedValueOnce(new Error('Redis down'));
  expect(await store.listMembers(CHANNEL)).toEqual([expect.objectContaining({ userId: '' })]);
  await expect(store.putMember({ channel: CHANNEL, userId: 'charlie', role: 'member', addedBy: 'alice', addedAt: '', historyFrom: null, removedAt: null }))
    .rejects.toMatchObject({ status: 403 });
  // Other channels are the wrapped store's.
  await store.putMember({ channel: 'social:ch:x', userId: 'charlie', role: 'member', addedBy: 'alice', addedAt: '', historyFrom: null, removedAt: null });
  expect(await base.getMember('social:ch:x', 'charlie')).toMatchObject({ userId: 'charlie' });
  expect(await huddleMembershipStore(base, () => null).listMembers(CHANNEL)).toEqual([expect.objectContaining({ userId: '' })]);
});

it('delivers huddle chat frames with page references resolved per reader, and none to a departed or ended seat', async () => {
  const stored = await say('alice', 'Look here', { pageReference: page });
  const frame = { type: 'chat', action: 'message', channel: CHANNEL, message: stored };
  expect(await runtime.filterFrame('b', frame)).toEqual({ ...frame, message: expect.objectContaining({ id: stored.id,
    metadata: expect.objectContaining({ pageReference: expect.objectContaining({ status: 'available', title: 'Cutover runbook' }) }) }) });
  const history = await runtime.filterFrame('b', { type: 'chat', action: 'history', channel: CHANNEL, messages: [stored] }) as { messages: ChatMessage[] };
  expect(history.messages[0]!.metadata?.['pageReference']).toMatchObject({ status: 'available' });
  expect(await runtime.filterFrame('b', { type: 'chat', action: 'message', channel: 'orgiq:huddle', message: stored })).toBeNull();
  runtime.invalidate(CALL, 'b');
  expect(await runtime.filterFrame('b', frame)).toBeNull();
  await runtime.finish(CALL, ['a']);
  expect(await runtime.filterFrame('a', frame)).toBeNull();
});

it('accepts only a delivery id, an exact page descriptor and allowlisted metadata on a huddle send', () => {
  expect(huddleSendInput({ message: 'Hi', metadata: { clientDeliveryId: 'd-1', pageReference: page, displayName: 'Forged',
    userId: 'bob', html: '<b>x</b>', replyTo: { messageId: 'm-1' } } })).toEqual({ text: 'Hi', deliveryId: 'd-1', page,
    metadata: { clientDeliveryId: 'd-1', pageReference: page, replyTo: { messageId: 'm-1' } } });
  for (const metadata of [undefined, {}, { clientDeliveryId: '' }, { clientDeliveryId: 'a:b' },
    { clientDeliveryId: 'd', pageReference: { ...page, href: 'https://evil.invalid' } }, { clientDeliveryId: 'd', pageReference: { kind: 'url', id: 'x' } }]) {
    expect(typeof huddleSendInput({ message: 'Hi', metadata })).toBe('string');
  }
});

it('stores a reference-only huddle send with a blank body, never invented text, and keeps the exact-descriptor check', () => {
  const sent = huddleSendInput({ message: '', metadata: { clientDeliveryId: 'd-2', pageReference: page } });
  expect(sent).toMatchObject({ text: REFERENCE_ONLY_BODY, page, metadata: { pageReference: page } });
  expect(REFERENCE_ONLY_BODY.trim()).toBe('');
  expect(typeof huddleSendInput({ message: '', metadata: { clientDeliveryId: 'd-2', pageReference: { ...page, href: 'https://evil.invalid' } } })).toBe('string');
  expect(huddleSendInput({ message: '', metadata: { clientDeliveryId: 'd-2' } })).toMatchObject({ text: '', page: null });
});
