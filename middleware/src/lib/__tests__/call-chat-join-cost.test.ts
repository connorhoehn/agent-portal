jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));

// What one join costs. On Aurora every authority read is a Data API round
// trip, and the huddle chat's reconciliation is awaited inside the call
// store's seat write, so its chain of reads was the ~10 s between Join and an
// accepted call seat in AWS (docs/aws-deploy-open-items-2026-10-27.md item 1).
// These pin the repeats that were removed, without dropping a check.
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { CallChatRuntime } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';
import { observeCallPageLifecycle, type RecoverableCallStateStore } from '../call-pages.js';
import { getLivePrincipal, handOffLiveSession, sessionGatewayContext } from '../live-principal.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import type { Session } from '../session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob';
const alice: Session = { sub: 'alice', tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'] }, iat: 100 };
const bob: Session = { ...alice, sub: 'bob' };
const context = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, epoch: s.epoch ?? 0, sessionIat: s.iat });
let calls: InMemoryCallStateStore; let observed: RecoverableCallStateStore; let runtime: CallChatRuntime;
let contexts: Map<string, Record<string, unknown>>; let state: MemoryCallChatStateStore;
const users = new Map<string, UserInfo>([alice, bob].map(s => [s.sub, { id: s.sub, displayName: `${s.sub} Directory`, email: null,
  personId: null, epoch: 0, externalSub: null, grants: structuredClone(s.grants) }]));
const reads = () => jest.mocked(getUser).mock.calls.length;

beforeEach(() => {
  jest.mocked(getUser).mockReset();
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  contexts = new Map([['a', context(alice)], ['b', context(bob)]]);
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id),
    getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  calls = new InMemoryCallStateStore(); state = new MemoryCallChatStateStore();
  runtime = new CallChatRuntime({ calls, state, messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0,
    lobbyAllowed: (auth, lobby) => lobby.split(':').includes(String(auth.userId)) });
  observed = observeCallPageLifecycle(calls, () => null, () => runtime);
});
afterEach(() => { runtime.dispose(); state.dispose(); });

it('one seat registration checks the seat once: five directory reads, not the old three passes', async () => {
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob']);
  // activeCallParticipant twice (read, I/O, re-read) plus the final authority
  // read, once for the seat: the gate, the seats() pass and the per-seat
  // re-check before the join used to run it three times.
  expect(reads()).toBe(5);
  expect((await state.get(CALL)).members['alice']?.active).toBe(true);
});

it('the claim right after a first registration does not reconcile again; a departure in between makes it', async () => {
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob']);
  const before = reads();
  await runtime.registered(CALL, 'a', true);
  expect(reads()).toBe(before);
  // Anything that moves the generation (here bob's seat leaving) means a full pass.
  runtime.invalidate(CALL, 'b');
  await runtime.registered(CALL, 'a', true);
  expect(reads()).toBeGreaterThan(before);
  // An explicit join (history not preserved) is never skipped.
  const again = reads();
  await runtime.registered(CALL, 'a', false);
  expect(reads()).toBeGreaterThan(again);
});

it('a revoked seat found by the single check is not joined and its person leaves', async () => {
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob']);
  await observed.registerParticipant(CALL, 'b', 'alice', LOBBY, ['bob']);
  expect((await state.get(CALL)).members['bob']?.active).toBe(true);
  users.set('bob', { ...users.get('bob')!, epoch: 1 });
  await runtime.registered(CALL, 'a', false);
  expect((await state.get(CALL)).members['bob']?.active).toBe(false);
  expect((await state.get(CALL)).members['alice']?.active).toBe(true);
  users.set('bob', { ...users.get('bob')!, epoch: 0 });
});

describe('the one-turn principal handoff', () => {
  const ctx = () => sessionGatewayContext(alice);
  it('answers the next load of that context only, then every load reads', async () => {
    const c = ctx();
    handOffLiveSession(c, { ...alice, name: 'alice Directory' });
    expect((await getLivePrincipal(c)).session.name).toBe('alice Directory');
    expect(reads()).toBe(0);
    await getLivePrincipal(c);
    expect(reads()).toBe(1);
  });
  it('is gone once the event loop turns, so it never outlives I/O', async () => {
    const c = ctx();
    handOffLiveSession(c, alice);
    await new Promise(resolve => setImmediate(resolve));
    await getLivePrincipal(c);
    expect(reads()).toBe(1);
  });
  it('refuses a handed-off session that is not the context’s identity', async () => {
    const c = ctx();
    handOffLiveSession(c, { ...alice, epoch: 3 });
    await expect(getLivePrincipal(c)).rejects.toThrow();
    const d = ctx();
    handOffLiveSession(d, { ...alice, grants: { orgiq: ['sme'] } });
    await expect(getLivePrincipal(d)).rejects.toThrow();
  });
});
