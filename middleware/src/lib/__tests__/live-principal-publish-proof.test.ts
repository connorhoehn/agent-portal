// realtime-modules 0.109 publish proofs (capacity-0109). One send asks the
// sender-side publish authority once per (socket, channel); the host must drop
// that proof when its membership store observes a write or a peer hint during
// the operation, so the send's next publish recheck asks the directory and
// membership again. Recipient (subscribe) checks are never shared.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { createAuthorityScope, LocalRealtimeRouter, baseChannel } from '@connorhoehn/realtime-modules/server';
import type { ChatMember, ChatMembershipStore } from '@connorhoehn/realtime-modules/chat';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';

import { channelGuard, publishProofMaxAgeMs } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, MirroredMembershipStore, setSocialChatBackend } from '../social-chat.js';
import { admitChannel } from '../gateway/authority.js';

const CH = 'social:ch:private';
const member = (userId: string, removedAt: string | null = null): ChatMember =>
  ({ channel: CH, userId, role: 'member', addedBy: 'alice', addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt });
const ctx = (userId: string) => ({ userId, org: 'social', role: 'participant', epoch: 1, sessionIat: 100, tenants: ['social'], displayName: userId });
const guards = { guard: channelGuard, baseChannel };

let durable: ChatMember[]; let mirror: ChatMember[]; let store: MirroredMembershipStore; let directoryReads: number;
let router: LocalRealtimeRouter; const contexts = new Map<string, Record<string, unknown>>();
beforeEach(() => {
  durable = [member('alice'), member('bob')];
  mirror = structuredClone(durable);
  directoryReads = 0;
  const persist: ChatMembershipStore = {
    listMembers: async (channel: string) => structuredClone(durable.filter(row => row.channel === channel)),
    getMember: async (channel, userId) => durable.find(row => row.channel === channel && row.userId === userId) ?? null,
    putMember: async (row) => { durable = durable.filter(r => !(r.channel === row.channel && r.userId === row.userId)).concat(structuredClone(row)); },
  };
  store = new MirroredMembershipStore(() => mirror, persist);
  setSocialChatBackend({ ...createMemorySocialChatBackend({ fixtures: false }), membershipStore: store });
  const users = new Map<string, UserInfo>(['alice', 'bob'].map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 1,
    grants: { social: ['participant'] } }]));
  jest.mocked(getUser).mockImplementation(async id => { directoryReads++; return structuredClone(users.get(id) ?? null); });
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && ['ViewSocial', 'PostMessage'].includes(action));
  contexts.clear(); contexts.set('alice-socket', ctx('alice')); contexts.set('bob-socket', ctx('bob'));
  router = new LocalRealtimeRouter({ publishProofMaxAgeMs: 2000, authorize: args => admitChannel(args) });
  router._setHandle({ getClientContext: (id: string) => contexts.get(id) ?? null, sendToClient: () => true, listClients: () => [...contexts.keys()] } as never);
});
afterEach(() => { setSocialChatBackend(null); jest.clearAllMocks(); });

const publish = (scope: ReturnType<typeof createAuthorityScope>) =>
  router.checkChannel('publish', 'alice-socket', CH, { scope, silent: true });

describe('0.109 publish proofs against the live directory and Social membership', () => {
  it('one send asks the directory for its publish authority once, then reuses it', async () => {
    const scope = createAuthorityScope('chat.send');
    expect(await publish(scope)).toBe(true);
    const afterFirst = directoryReads;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await publish(scope)).toBe(true);
    expect(await publish(scope)).toBe(true);
    expect(directoryReads).toBe(afterFirst);
    scope.close();
    // Not a settled cache: the next send asks again.
    const next = createAuthorityScope('chat.send');
    expect(await publish(next)).toBe(true);
    expect(directoryReads).toBe(afterFirst * 2);
    next.close();
  });

  it('a committed membership write during the send drops the proof; the recheck asks fresh and denies', async () => {
    const scope = createAuthorityScope('chat.send');
    expect(await publish(scope)).toBe(true);
    await store.putMember(member('alice', '2026-10-06T00:00:00.000Z'));
    expect(await publish(scope)).toBe(false);
    scope.close();
  });

  it('a peer invalidation hint during the send drops the proof as well', async () => {
    const scope = createAuthorityScope('chat.send');
    expect(await publish(scope)).toBe(true);
    durable = durable.map(r => r.userId === 'alice' ? { ...r, removedAt: '2026-10-06T00:00:00.000Z' } : r);
    const before = directoryReads;
    store.invalidate(CH); // what the gateway's social:membership peer event does
    expect(await publish(scope)).toBe(false);
    expect(directoryReads).toBeGreaterThan(before);
    scope.close();
  });

  it('recipient checks are never shared', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await router.checkChannel('subscribe', 'bob-socket', CH, { scope, silent: true })).toBe(true);
    const before = directoryReads;
    expect(await router.checkChannel('subscribe', 'bob-socket', CH, { scope, silent: true })).toBe(true);
    expect(directoryReads).toBeGreaterThan(before);
    scope.close();
  });

  it('REALTIME_PUBLISH_PROOF_MAX_AGE_MS: default 2000, 0 disables, bad values refuse to start', () => {
    expect(publishProofMaxAgeMs({})).toBe(2000);
    expect(publishProofMaxAgeMs({ REALTIME_PUBLISH_PROOF_MAX_AGE_MS: '0' })).toBe(0);
    expect(publishProofMaxAgeMs({ REALTIME_PUBLISH_PROOF_MAX_AGE_MS: '750' })).toBe(750);
    for (const bad of ['-1', '1.5', 'x', '10001']) expect(() => publishProofMaxAgeMs({ REALTIME_PUBLISH_PROOF_MAX_AGE_MS: bad })).toThrow();
  });
});
