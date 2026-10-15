// realtime-modules 0.107 AuthorityScope adoption (capacity-authority-scope).
// One library operation (a chat action, one fan-out) may share ONE durable
// Social membership read per channel. These are the adversarial contracts:
// the scope lives for one operation only, nothing settles into a positive
// cache, a removal / peer hint during the operation denies the recipients
// still waiting, and directory, actor and policy checks still gate every
// check individually. The 2026-10-05 reverted attempt
// (capacity-fanout-proof/live-principal.patched.ts) started proofs early and
// concurrently with the directory; these tests also pin the order.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { createAuthorityScope, type AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import type { ChatMember, ChatMembershipStore } from '@connorhoehnslalom/realtime-modules/chat';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';

import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { channelGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, MirroredMembershipStore, setSocialChatBackend } from '../social-chat.js';
import { admitChannel } from '../gateway/authority.js';

const DM = 'social:dm:alice:bob:carol';
const CH = 'social:ch:private';
const member = (channel: string, userId: string, removedAt: string | null = null): ChatMember =>
  ({ channel, userId, role: 'member', addedBy: 'alice', addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt });
const ctx = (userId: string, epoch = 1, act?: { sub: string; epoch: number }) => ({ userId, org: 'social', role: 'participant',
  epoch, sessionIat: 100, tenants: ['social'], displayName: userId, ...(act ? { act } : {}) });
const guards = { guard: channelGuard, baseChannel };
const check = (userId: string, scope?: AuthorityScope, channel = DM, kind: 'subscribe' | 'publish' = 'subscribe', c = ctx(userId)) =>
  admitChannel({ kind, clientId: `${userId}-socket`, channel, ctx: c, ...(scope ? { scope } : {}) });

let durable: ChatMember[]; let mirror: ChatMember[]; let reads: number; let gate: Promise<void> | null;
let fail: Error | null; let store: MirroredMembershipStore; let users: Map<string, UserInfo>; let order: string[];
beforeEach(() => {
  durable = [member(DM, 'alice'), member(DM, 'bob'), member(DM, 'carol'), member(CH, 'alice'), member(CH, 'bob')];
  mirror = [member(CH, 'alice'), member(CH, 'bob')];
  reads = 0; gate = null; fail = null; order = [];
  const persist: ChatMembershipStore = {
    listMembers: async (channel: string) => {
      reads++; order.push(`read:${channel}`);
      if (gate) await gate;
      if (fail) throw fail;
      return structuredClone(durable.filter(row => row.channel === channel));
    },
    getMember: async (channel, userId) => durable.find(row => row.channel === channel && row.userId === userId) ?? null,
    putMember: async (row) => { durable = durable.filter(r => !(r.channel === row.channel && r.userId === row.userId)).concat(structuredClone(row)); },
  };
  store = new MirroredMembershipStore(() => mirror, persist);
  setSocialChatBackend({ ...createMemorySocialChatBackend({ fixtures: false }), membershipStore: store });
  users = new Map(['alice', 'bob', 'carol', 'dave'].map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 1,
    grants: { social: ['participant'] } }]));
  users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 5, grants: { orgiq: ['admin'] } });
  jest.mocked(getUser).mockImplementation(async id => { order.push(`directory:${id}`); return structuredClone(users.get(id) ?? null); });
  jest.mocked(isAllowed).mockImplementation(async (p, action) => { order.push(`policy:${action}`);
    return p.tenant === 'social' && p.role === 'participant' && ['ViewSocial', 'PostMessage'].includes(action); });
});
afterEach(() => { setSocialChatBackend(null); jest.clearAllMocks(); });

describe('baseChannel replaces the local service-prefix strip (fails closed on retired prefixes)', () => {
  it('admits a chat:-wrapped tenant DM lobby for its members only', async () => {
    expect(baseChannel('chat:social:dm:alice:bob:carol')).toBe(DM);
    expect(await check('alice', undefined, `chat:${DM}`)).toBe(true);
    expect(await check('bob', undefined, `presence:${DM}`)).toBe(true);
    expect(await check('dave', undefined, `chat:${DM}`)).toBe(false);
  });
  it('refuses activity:broadcast and the typing:/pins:/activity:/chat: names nothing produces', async () => {
    for (const channel of ['activity:broadcast', `typing:${DM}`, `pins:${DM}`, `activity:${DM}`, `chat:${CH}`, 'chat:orgiq:initiative:p-1']) {
      expect(baseChannel(channel)).toBe(channel);
      expect(channelGuard({ userId: 'alice', org: 'social', tenants: ['social', 'orgiq'] }, channel)).toBe(false);
      expect(await check('alice', undefined, channel)).toBe(false);
    }
    expect(reads).toBe(0);
  });
});

describe('one operation shares one membership read', () => {
  it('a fan-out of many recipient checks makes one durable read, and only within the operation', async () => {
    const scope = createAuthorityScope('fanout');
    // Sequential on purpose: concurrent reads could also coalesce before
    // dispatch (MirroredMembershipStore's queue); a scope shares across time.
    const results: boolean[] = [];
    for (const user of ['alice', 'bob', 'carol', 'alice', 'bob', 'dave']) results.push(await check(user, scope));
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(reads).toBe(1);
    scope.close();
    // Closed: every later check reads fresh. Nothing settled into a cache.
    expect(await check('alice', scope)).toBe(true); expect(await check('bob', scope)).toBe(true);
    expect(reads).toBe(3);
    const next = createAuthorityScope('fanout');
    expect(await check('alice', next)).toBe(true); expect(reads).toBe(4); next.close();
  });

  it('the chat service listMembers(channel, { scope }) and channel authority share the same read', async () => {
    const scope = createAuthorityScope('chat.send');
    expect(await check('alice', scope, DM, 'publish')).toBe(true);
    const rows = await store.listMembers(DM, { scope });
    expect(rows.map(r => r.userId).sort()).toEqual(['alice', 'bob', 'carol']);
    rows[0]!.removedAt = 'mutated by a caller';
    expect((await store.listMembers(DM, { scope }))[0]!.removedAt).toBeNull();
    expect(await check('bob', scope)).toBe(true);
    expect(reads).toBe(1);
    scope.close();
  });

  it('directory, actor and policy are asked for every check, never shared', async () => {
    const scope = createAuthorityScope('fanout');
    await check('alice', scope); await check('bob', scope); await check('carol', scope);
    expect(reads).toBe(1);
    expect(jest.mocked(getUser).mock.calls.filter(([id]) => id === 'bob')).toHaveLength(2);
    expect(jest.mocked(isAllowed)).toHaveBeenCalledTimes(3);
    scope.close();
  });

  it('keeps the order: directory → policy → membership → directory (no early proof)', async () => {
    const scope = createAuthorityScope('fanout');
    await check('alice', scope);
    expect(order).toEqual(['directory:alice', 'policy:ViewSocial', `read:${DM}`, 'directory:alice']);
    order = []; await check('bob', scope);
    expect(order).toEqual(['directory:bob', 'policy:ViewSocial', 'directory:bob']);
    scope.close();
  });
});

describe('revocation during the operation denies the remaining recipients', () => {
  it('a committed removal mid-fan-out denies every later check on the channel in that operation', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    await store.putMember(member(DM, 'carol', '2026-10-05T01:00:00.000Z'));
    expect(await check('bob', scope)).toBe(false);
    expect(await check('carol', scope)).toBe(false);
    expect(reads).toBe(1);
    scope.close();
    // The next operation reads fresh: bob is still a member, carol is not.
    const next = createAuthorityScope('fanout');
    expect(await check('bob', next)).toBe(true); expect(await check('carol', next)).toBe(false);
    next.close();
  });

  it('a removal that lands while the shared read is still in flight denies all of its waiters', async () => {
    let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; });
    const scope = createAuthorityScope('fanout');
    const pending = ['alice', 'bob'].map(user => check(user, scope));
    while (reads === 0) await new Promise(resolve => setImmediate(resolve));
    await store.putMember(member(DM, 'carol', '2026-10-05T01:00:00.000Z'));
    gate = null; release();
    expect(await Promise.all(pending)).toEqual([false, false]);
    scope.close();
  });

  it('a peer invalidation hint (no payload trusted) denies the rest of the operation', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    store.invalidate(DM);
    expect(await check('bob', scope)).toBe(false);
    // Rows are data, not a decision: the chat service gets a fresh read.
    expect((await store.listMembers(DM, { scope })).length).toBe(3);
    expect(reads).toBe(2);
    expect(await check('carol', scope)).toBe(false);
    scope.close();
  });

  it('an epoch bump during the operation denies that user even though the membership proof is shared', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    users.get('bob')!.epoch = 2;
    expect(await check('bob', scope)).toBe(false);
    expect(await check('carol', scope)).toBe(true);
    scope.close();
  });

  it('an epoch bump that lands between the shared read and the recheck denies', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    let calls = 0;
    jest.mocked(getUser).mockImplementation(async id => {
      const user = structuredClone(users.get(id) ?? null);
      if (id === 'bob' && ++calls === 2 && user) user.epoch = 9; // the post-membership reload
      return user;
    });
    expect(await check('bob', scope)).toBe(false);
    scope.close();
  });

  it('a revoked Social grant or policy denial during the operation denies', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    users.get('bob')!.grants = { social: [] };
    expect(await check('bob', scope)).toBe(false);
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect(await check('carol', scope)).toBe(false);
    scope.close();
  });

  it('masquerade actor epoch and admin authority still gate each check', async () => {
    const scope = createAuthorityScope('fanout');
    const act = { sub: 'operator', epoch: 5 };
    expect(await check('bob', scope, DM, 'subscribe', ctx('bob', 1, act))).toBe(true);
    users.get('operator')!.epoch = 6;
    expect(await check('bob', scope, DM, 'subscribe', ctx('bob', 1, act))).toBe(false);
    users.get('operator')!.epoch = 5; users.get('operator')!.grants = { orgiq: ['member'] };
    expect(await check('bob', scope, DM, 'subscribe', ctx('bob', 1, act))).toBe(false);
    expect(reads).toBe(1);
    scope.close();
  });

  it('a check still in flight when the scope closes keeps its own fence', async () => {
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope)).toBe(true);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(isAllowed).mockImplementationOnce(async () => { await hold; return true; });
    const pending = check('bob', scope);
    await new Promise(resolve => setImmediate(resolve));
    scope.close(); // the shared observer is disposed here
    // The policy is still pending, so bob has not reached the shared proof:
    // after close it reads fresh, and a removal before that read is seen.
    await store.putMember(member(DM, 'bob', '2026-10-05T01:00:00.000Z'));
    release();
    expect(await pending).toBe(false);
  });
});

describe('failure and channel isolation', () => {
  it('a failed shared read denies, is dropped from the scope, and the next check retries', async () => {
    const scope = createAuthorityScope('fanout');
    fail = new Error('DynamoDB unavailable');
    expect(await check('alice', scope)).toBe(false);
    fail = null;
    expect(await check('alice', scope)).toBe(true);
    expect(reads).toBe(2);
    scope.close();
  });

  it('a hint on another channel does not deny, and each channel has its own read', async () => {
    const scope = createAuthorityScope('chat.send');
    expect(await check('alice', scope)).toBe(true);
    expect(await check('alice', scope, CH)).toBe(true);
    store.invalidate(CH);
    expect(await check('bob', scope)).toBe(true);
    expect(await check('bob', scope, CH)).toBe(false);
    expect(reads).toBe(2);
    scope.close();
  });

  it('removed members of a mirrored channel are denied from the shared read', async () => {
    durable = durable.map(row => row.channel === CH && row.userId === 'bob' ? { ...row, removedAt: 'gone' } : row);
    const scope = createAuthorityScope('fanout');
    expect(await check('alice', scope, CH)).toBe(true);
    expect(await check('bob', scope, CH)).toBe(false);
    expect(reads).toBe(1);
    scope.close();
  });
});
