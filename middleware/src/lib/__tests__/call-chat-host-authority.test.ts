jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));

import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore, type ChatMessage } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { currentCallChatGrant } from '../call-access.js';
import { CallChatRuntime, callChatChannel } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';
import { lobbyGuard } from '../gateway/authority.js';
import type { Session } from '../session.js';
import { socialChat } from '../social-chat.js';

const CALL = 'host-only-call', LOBBY = 'orgiq:initiative:p-auth', CHANNEL = callChatChannel(CALL);
const session = (sub: string): Session => ({ sub, tenant: 'orgiq', role: 'member', epoch: 0,
  grants: { orgiq: ['member'] }, iat: 100 });
const alice = session('alice'), bob = session('bob');
const context = (actor: Session) => ({ userId: actor.sub, org: actor.tenant, role: actor.role,
  epoch: actor.epoch, sessionIat: actor.iat });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
let calls: InMemoryCallStateStore, state: MemoryCallChatStateStore, messages: InMemoryChatStore, runtime: CallChatRuntime;
let users: Map<string, UserInfo>, contexts: Map<string, Record<string, unknown>>, router: RealtimeRouter, sent: jest.Mock, clock: number;

beforeEach(async () => {
  clock = Date.parse('2026-10-10T12:00:00Z');
  users = new Map([alice, bob].map(actor => [actor.sub, { id: actor.sub, displayName: actor.sub, email: null,
    personId: null, epoch: 0, grants: structuredClone(actor.grants) }]));
  contexts = new Map([['a', context(alice)], ['b', context(bob)], ['b-unseated', context(bob)]]);
  jest.mocked(getUser).mockReset().mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(isAllowed).mockReset().mockImplementation(async (principal, action) => principal.tenant === 'assessment' && action === 'ViewAssessment');
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  calls = new InMemoryCallStateStore(); state = new MemoryCallChatStateStore(); messages = new InMemoryChatStore(); sent = jest.fn();
  router = { sendToClient: sent, sendToChannel: jest.fn(), isClientLive: id => contexts.has(id),
    getClientData: id => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() };
  runtime = new CallChatRuntime({ calls, state, messages, router, lobbyAllowed: lobbyGuard, maintenanceIntervalMs: 0, now: () => clock });
  for (const id of ['a', 'b']) { await calls.registerParticipant(CALL, id, 'alice', LOBBY, ['bob']); await runtime.registered(CALL, id); }
  clock += 1000; sent.mockClear();
});
afterEach(() => { runtime.dispose(); jest.restoreAllMocks(); });

it.each(['social:dm:alice:bob', 'social:room:journey'])('admits only seated Social participants of %s with current chat permissions', async lobbyName => {
  const socialAlice: Session = { ...alice, tenant: 'social', role: 'participant', grants: { social: ['participant'] } };
  const socialBob: Session = { ...socialAlice, sub: 'bob' };
  users.get('alice')!.grants = socialAlice.grants;
  users.get('bob')!.grants = socialBob.grants;
  contexts.set('a', context(socialAlice)); contexts.set('b', context(socialBob)); contexts.set('b-unseated', context(socialBob));
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.tenant === 'social' && ['ViewSocial', 'PostMessage'].includes(action));
  const callId = 'social-call';
  for (const id of ['a', 'b']) { await calls.registerParticipant(callId, id, 'alice', lobbyName, ['bob']); await runtime.registered(callId, id); }
  expect(await runtime.get(callId, socialBob)).toMatchObject({ canSend: true, participants: [{ userId: 'alice' }, { userId: 'bob' }] });
  await expect(runtime.assertSeat(callId, 'b', true)).resolves.toBeUndefined();
  await expect(runtime.assertSeat(callId, 'b-unseated', true)).rejects.toMatchObject({ status: 403 });
  jest.mocked(isAllowed).mockImplementation(async (_principal, action) => action === 'ViewSocial');
  expect((await runtime.get(callId, socialBob)).canSend).toBe(false);
  await expect(runtime.assertSeat(callId, 'b', true)).rejects.toMatchObject({ status: 403 });
  jest.mocked(isAllowed).mockResolvedValue(true);
  const members = socialChat().membershipStore;
  await members.putMember({ channel: lobbyName, userId: 'bob', role: 'member', addedBy: 'alice', addedAt: new Date(clock).toISOString(), historyFrom: null, removedAt: new Date(clock).toISOString() });
  try { await expect(runtime.get(callId, socialBob)).rejects.toMatchObject({ status: 403 }); }
  finally { await members.putMember({ channel: lobbyName, userId: 'bob', role: 'member', addedBy: 'alice', addedAt: new Date(clock).toISOString(), historyFrom: null, removedAt: null }); }
  users.get('bob')!.epoch = 1;
  await expect(runtime.get(callId, socialBob)).rejects.toMatchObject({ status: 401 });
});

it('uses the exact host family read and resource, never Social or page write permissions', async () => {
  expect(await currentCallChatGrant(alice, { displayName: 'Alice', grants: alice.grants }, 'PostMessage', LOBBY)).toBe(true);
  expect(isAllowed).not.toHaveBeenCalled();
  expect(pageResourceVisible).toHaveBeenCalledWith('orgiq-initiative', LOBBY);
  const assessment = { ...alice, tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } } as Session;
  expect(await currentCallChatGrant(assessment, { displayName: 'Alice', grants: assessment.grants }, 'PostMessage', 'assessment:team:TEAM-005')).toBe(true);
  expect(isAllowed).toHaveBeenCalledWith({ sub: 'alice', tenant: 'assessment', role: 'assessor' }, 'ViewAssessment');
  jest.mocked(isAllowed).mockResolvedValue(false);
  expect(await currentCallChatGrant(assessment, { displayName: 'Alice', grants: assessment.grants }, 'ViewSocial', 'assessment:team:TEAM-005')).toBe(false);
  jest.mocked(pageResourceVisible).mockResolvedValue(false);
  expect(await currentCallChatGrant(alice, { displayName: 'Alice', grants: alice.grants }, 'PostMessage', LOBBY)).toBe(false);
  for (const lobby of ['orgiq:unknown', 'orgiq:huddle:other', 'assessment:team:TEAM-005', 'social:dm:alice:bob', 'pipelines:run:r-1']) {
    expect(await currentCallChatGrant(alice, { displayName: 'Alice', grants: alice.grants }, 'ViewSocial', lobby)).toBe(false);
  }
});

it('allows read/write for an accepted Work-only seat while retaining exact-connection membership', async () => {
  const snapshot = await runtime.get(CALL, bob);
  expect(snapshot).toMatchObject({ channel: CHANNEL, canSend: true, participants: [{ userId: 'alice' }, { userId: 'bob' }] });
  await expect(runtime.assertSeat(CALL, 'b', true)).resolves.toBeUndefined();
  await expect(runtime.assertSeat(CALL, 'b-unseated', true)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.assertMember(CALL, session('not-joined'), true)).rejects.toMatchObject({ status: 401 });
  users.get('bob')!.grants.social = ['participant']; users.get('bob')!.grants.orgiq = [];
  await expect(runtime.assertSeat(CALL, 'b', true)).rejects.toMatchObject({ status: 401 });
});

it('refuses deleted lobby resources, lobbyGuard denial and identity outages without disclosing history', async () => {
  jest.mocked(pageResourceVisible).mockResolvedValue(false);
  await expect(runtime.get(CALL, bob)).rejects.toMatchObject({ status: 403 });
  jest.mocked(pageResourceVisible).mockResolvedValue(true);
  const call = (await calls.getCall(CALL))!;
  await calls.setCall(CALL, { ...call, lobbyName: 'orgiq:dm:alice:charlie' }, 14400);
  await expect(runtime.get(CALL, bob)).rejects.toMatchObject({ status: 403 });
  await calls.setCall(CALL, call, 14400);
  jest.mocked(getUser).mockRejectedValue(new Error('Directory unavailable'));
  await expect(runtime.get(CALL, bob)).rejects.toMatchObject({ status: 503 });
});

it('rechecks the signed host identity after a slow lobby-resource read', async () => {
  const started = deferred(), release = deferred();
  jest.mocked(pageResourceVisible).mockImplementationOnce(async () => { started.resolve(); await release.promise; return true; });
  const pending = runtime.assertSeat(CALL, 'b', true); await started.promise;
  users.get('bob')!.epoch = 1; release.resolve();
  await expect(pending).rejects.toMatchObject({ status: 401 });
});

it('rechecks identity after a distributed connection read and fences a concurrent leave', async () => {
  const started = deferred(), release = deferred(); let paused = false;
  router.resolveClientData = async id => {
    if (id === 'b' && !paused) { paused = true; started.resolve(); await release.promise; }
    return { userContext: contexts.get(id) };
  };
  const pending = runtime.assertMember(CALL, bob, true); await started.promise;
  users.get('bob')!.grants.orgiq = []; release.resolve();
  await expect(pending).rejects.toMatchObject({ status: 401 });
  users.get('bob')!.grants.orgiq = ['member'];
  const leaving = deferred(), left = deferred();
  jest.mocked(pageResourceVisible).mockImplementationOnce(async () => { leaving.resolve(); await left.promise; return true; });
  const late = runtime.assertSeat(CALL, 'b', true); await leaving.promise;
  runtime.invalidate(CALL, 'b'); await calls.removeParticipant(CALL, 'b'); left.resolve();
  await expect(late).rejects.toMatchObject({ status: 403 });
});

it('keeps join-boundary history and ended-call closure; terminal frames need the admitted provenance', async () => {
  const message: ChatMessage = { id: 'm-1', clientId: 'a', userId: 'alice', channel: CHANNEL, message: 'Work call note',
    timestamp: new Date(clock).toISOString() };
  await messages.putMessage(message);
  expect((await runtime.get(CALL, bob)).messages).toEqual([{ ...message, metadata: {} }]);
  runtime.invalidate(CALL, 'b'); await calls.removeParticipant(CALL, 'b'); await runtime.removed(CALL, 'b');
  await expect(runtime.get(CALL, bob)).rejects.toMatchObject({ status: 403 });
  clock += 1000; await calls.registerParticipant(CALL, 'b', 'alice', LOBBY, ['bob']); await runtime.registered(CALL, 'b');
  expect((await runtime.get(CALL, bob)).messages).toEqual([]);
  await runtime.finish(CALL, ['a', 'b']); await calls.forgetCall(CALL);
  expect(sent).toHaveBeenCalledWith('b', expect.objectContaining({ type: 'call-chat', action: 'ended', callId: CALL }));
  const terminal = { type: 'call-chat', action: 'ended', callId: CALL };
  expect(await runtime.filterFrame('b', terminal)).toMatchObject(terminal);
  expect(await runtime.filterFrame('b-unseated', terminal)).toBeNull();
  contexts.set('b', { ...context(bob), epoch: 1 }); users.get('bob')!.epoch = 1;
  expect(await runtime.filterFrame('b', terminal)).toBeNull();
  await expect(runtime.get(CALL, alice)).rejects.toMatchObject({ status: 404 });
  expect(await runtime.memberRows(CALL)).toEqual([expect.objectContaining({ userId: '', removedAt: expect.any(String) })]);
});
