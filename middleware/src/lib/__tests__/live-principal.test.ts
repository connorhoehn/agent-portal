jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { currentLiveSession, getLivePrincipal } from '../live-principal.js';
import { currentSocialActionSession } from '../social-authority.js';
import { channelGuard, lobbyGuard } from '../realtime-gateway.js';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import type { Session } from '../session.js';
import type { ChatMember, ChatMembershipStore } from '@connorhoehnslalom/realtime-modules/chat';
import { createMemorySocialChatBackend, MirroredMembershipStore, setSocialChatBackend, socialChat } from '../social-chat.js';
import { admitCall, admitCallRecipient, admitChannel } from '../gateway/authority.js';

const session: Session = { sub: 'alice', tenant: 'orgiq', role: 'member', epoch: 2, iat: 100,
  grants: { orgiq: ['member'], social: ['participant'] } };
const context = (value: Session = session) => ({ userId: value.sub, org: value.tenant, role: value.role,
  epoch: value.epoch, sessionIat: value.iat, tenants: ['orgiq', 'social', 'assessment'], displayName: 'Old token label',
  ...(value.act ? { act: { sub: value.act.sub, epoch: value.act.epoch } } : {}) });
const guards = { guard: channelGuard, baseChannel };
const authorize = (channel = 'social:dm:alice:bob', kind: 'subscribe' | 'publish' = 'subscribe', ctx = context()) =>
  admitChannel({ kind, clientId: 'socket-a', channel, ctx });
let users: Map<string, UserInfo>;
beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([['alice', { id: 'alice', displayName: 'Alice Directory', email: null, personId: null,
    epoch: 2, grants: structuredClone(session.grants) }]]);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && p.role === 'participant'
    && ['ViewSocial', 'PostMessage', 'StartCall'].includes(action));
});
afterEach(() => jest.clearAllMocks());

it('refreshes directory presentation and actual tenant grant keys without trusting captured token or cookie grants', async () => {
  users.get('alice')!.grants = { orgiq: ['member'], social: [] };
  const current = await getLivePrincipal(context());
  expect(current.auth).toMatchObject({ userId: 'alice', displayName: 'Alice Directory', org: 'orgiq', role: 'member', tenants: ['orgiq'], epoch: 2 });
  expect(current.session.grants).toEqual({ orgiq: ['member'], social: [] });
  expect(await authorize()).toBe(false);
  expect(getUser).toHaveBeenCalledWith('alice', { authoritative: true });
  users.get('alice')!.grants.orgiq!.push('sme');
  expect(current.session.grants.orgiq).toEqual(['member']);
});

it('denies missing identities, retired epochs and source roles rather than selecting another current role', async () => {
  users.get('alice')!.grants.orgiq = ['sme'];
  await expect(currentLiveSession(session)).rejects.toMatchObject({ status: 401 });
  users.get('alice')!.grants.orgiq = ['member']; users.get('alice')!.epoch = 3;
  expect(await authorize()).toBe(false);
  users.delete('alice'); await expect(currentLiveSession(session)).rejects.toMatchObject({ status: 401 });
});

it.each([
  ['social', 'participant'], ['assessment', 'assessor'], ['pipelines', 'author'],
] as const)('validates the original %s source role while embedding Social', async (tenant, role) => {
  const source = { ...session, tenant, role } as Session;
  users.get('alice')!.grants = { [tenant]: [role], social: ['participant'] };
  const current = await getLivePrincipal(context(source));
  expect(current.session).toMatchObject({ sub: 'alice', tenant, role });
  expect(await authorize('social:dm:alice:bob', 'publish', context(source))).toBe(true);
});

it('evaluates Social read and write actions against actual Social roles while retaining the source identity', async () => {
  expect(await authorize()).toBe(true); expect(await authorize('chat:social:dm:alice:bob', 'publish')).toBe(true);
  expect(isAllowed).toHaveBeenCalledWith({ sub: 'alice', tenant: 'social', role: 'participant' }, 'ViewSocial');
  expect(isAllowed).toHaveBeenCalledWith({ sub: 'alice', tenant: 'social', role: 'participant' }, 'PostMessage');
  const current = await currentSocialActionSession(session, 'PostMessage');
  expect(current.tenant).toBe('orgiq'); expect(current.role).toBe('member');
  jest.mocked(isAllowed).mockImplementation(async (_p, action) => action === 'ViewSocial');
  expect(await authorize()).toBe(true); expect(await authorize('social:dm:alice:bob', 'publish')).toBe(false);
});

it('checks real actor epoch and current admin authority independently from the effective user', async () => {
  users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 7, grants: { orgiq: ['admin'] } });
  const masquerade: Session = { ...session, act: { sub: 'operator', epoch: 7, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } };
  expect((await getLivePrincipal(context(masquerade))).session.sub).toBe('alice');
  users.get('operator')!.epoch = 8; expect(await authorize('social:dm:alice:bob', 'subscribe', context(masquerade))).toBe(false);
  users.get('operator')!.epoch = 7; users.get('operator')!.grants = { orgiq: ['member'] };
  await expect(currentLiveSession(masquerade)).rejects.toMatchObject({ status: 401 });
});

it('rechecks grants and provenance after a delayed policy decision', async () => {
  let started!: () => void; let release!: () => void;
  const pendingPolicy = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  jest.mocked(isAllowed).mockImplementation(async () => { started(); await pendingPolicy; return true; });
  const pending = authorize(); await waiting;
  users.get('alice')!.grants.social = []; release(); expect(await pending).toBe(false);
  users.get('alice')!.grants.social = ['participant'];
  jest.mocked(isAllowed).mockImplementation(async () => { users.get('alice')!.epoch += 1; return true; });
  await expect(currentSocialActionSession(session, 'PostMessage')).rejects.toMatchObject({ status: 401 });
});

it.each(['social:dm:alice:bob', 'social:team:example:general'])('rejects %s membership removal while the final identity read is pending', async channel => {
  const store = socialChat().membershipStore;
  const aliceRow = { channel, userId: 'alice', role: 'member' as const, addedBy: 'bob',
    addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt: null };
  await store.putMember(aliceRow);
  let startMembership!: () => void; let releaseMembership!: () => void;
  const membershipStarted = new Promise<void>(resolve => { startMembership = resolve; });
  const membershipWait = new Promise<void>(resolve => { releaseMembership = resolve; });
  const original = store.listMembers.bind(store);
  const read = jest.spyOn(store, 'listMembers').mockImplementationOnce(async target => {
    const prior = await original(target); startMembership(); await membershipWait; return prior;
  });
  let startIdentity!: () => void; let releaseIdentity!: () => void; let count = 0;
  const identityStarted = new Promise<void>(resolve => { startIdentity = resolve; });
  const identityWait = new Promise<void>(resolve => { releaseIdentity = resolve; });
  jest.mocked(getUser).mockImplementation(async id => { if (++count === 2) { startIdentity(); await identityWait; } return users.get(id) ?? null; });
  const pending = admitChannel({ kind: 'subscribe', clientId: 'a', channel, ctx: context() });
  await membershipStarted; releaseMembership(); await identityStarted;
  await store.putMember({ ...aliceRow, removedAt: '2026-10-03T01:00:00.000Z' }); releaseIdentity();
  expect(await pending).toBe(false); read.mockRestore();
  expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel, ctx: context() })).toBe(false);
});

it('preserves resource guards, server-only distillation and the reserved huddle namespace', async () => {
  expect(await authorize('social:dm:bob:charlie')).toBe(false);
  expect(await authorize('orgiq:dm:alice:bob')).toBe(true);
  expect(await authorize('orgiq:huddle:call-1')).toBe(false);
  expect(await authorize('presence:orgiq:huddle:call-1', 'publish')).toBe(false);
  expect(await authorize('orgiq:distill:jobs')).toBe(true);
  expect(await authorize('orgiq:distill:jobs', 'publish')).toBe(false);
  expect(await authorize('presence:orgiq:distill:jobs')).toBe(false);
  const source = { ...session, tenant: 'assessment', role: 'assessor' } as Session;
  users.get('alice')!.grants.assessment = ['assessor'];
  expect(await authorize('orgiq:distill:jobs', 'subscribe', context(source))).toBe(false);
  // The name's resource rule (the Social channel's membership) is asked, and refuses a non-member.
  const resource = jest.spyOn(socialChat().membershipStore, 'isActiveMember');
  expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel: 'social:ch:private', ctx: context() })).toBe(false);
  expect(resource).toHaveBeenCalledWith('social:ch:private', 'alice');
});

it('fails closed on authoritative directory or policy outages without reusing previous authority', async () => {
  expect(await authorize()).toBe(true);
  jest.mocked(getUser).mockRejectedValueOnce(new Error('Aurora unavailable'));
  await expect(currentLiveSession(session)).rejects.toMatchObject({ status: 503 });
  jest.mocked(getUser).mockRejectedValueOnce(new Error('Aurora unavailable')); expect(await authorize()).toBe(false);
  jest.mocked(isAllowed).mockRejectedValueOnce(new Error('AVP unavailable')); expect(await authorize()).toBe(false);
});

it('a later action cannot reuse an older pending directory snapshot after remote revocation', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(getUser).mockImplementationOnce(async id => {
    const captured = structuredClone(users.get(id) ?? null); await waiting; return captured;
  });
  const first = getLivePrincipal(context());
  users.get('alice')!.grants.orgiq = ['sme'];
  try {
    await expect(getLivePrincipal(context())).rejects.toMatchObject({ status: 401 });
    expect(getUser).toHaveBeenCalledTimes(2);
  } finally { release(); await first; }
  await expect(getLivePrincipal(context())).rejects.toMatchObject({ status: 401 });
  expect(getUser).toHaveBeenCalledTimes(3);
});

it('retains local demo distillation while ignoring forged Social tenants and captured grants', async () => {
  const demo = { ...session, sub: 'demo-user', epoch: 0 };
  const current = await getLivePrincipal(context(demo)); expect(current.auth.tenants).not.toContain('social');
  expect(await authorize('orgiq:distill:jobs', 'subscribe', context(demo))).toBe(true);
  expect(await authorize('social:dm:bob:demo-user', 'subscribe', context(demo))).toBe(false);
});

it('preserves narrowed demo personas while retaining initial and admin demo grants', async () => {
  const source = { ...session, sub: 'demo-user', epoch: 0, role: 'sme' as const, grants: { orgiq: ['sme'] } };
  expect((await currentLiveSession(source)).grants).toEqual({ orgiq: ['sme'] });
  expect((await getLivePrincipal({ ...context(source), tenants: ['orgiq', 'assessment', 'social'] })).auth.tenants).toEqual(['orgiq']);
  const initial = { ...source, role: 'member' as const, grants: { orgiq: ['member'], assessment: ['assessor'] } };
  expect((await currentLiveSession(initial)).grants.assessment).toContain('assessor');
  expect((await getLivePrincipal(context(initial))).auth.tenants).toEqual(['orgiq', 'assessment']);
  const admin = { ...source, role: 'admin' as const };
  expect((await currentLiveSession(admin)).grants.assessment).toContain('admin');
  expect((await currentLiveSession(admin)).grants.social).toBeUndefined();
});

it('fresh call admission binds flat/nested invite callers and refuses stale provenance before signaling', async () => {
  const callGuards = { guard: lobbyGuard, getLobby: jest.fn(async () => 'orgiq:dm:alice:bob') };
  const invite = { callId: 'call', lobbyName: 'orgiq:dm:alice:bob', callerId: 'alice', targetUserIds: ['bob'] };
  expect(await admitCall(context(), 'invite', invite, callGuards)).toBe(true);
  expect(await admitCall(context(), 'invite', { data: invite }, callGuards)).toBe(true);
  expect(await admitCall(context(), 'invite', { ...invite, callerId: 'bob' }, callGuards)).toBe(false);
  users.get('alice')!.epoch += 1;
  expect(await admitCall(context(), 'participant-state', { callId: 'call' }, callGuards)).toBe(false);
  expect(await admitCall(context(), 'discover', {}, callGuards)).toBe(false);
});

it('resolves missing call lobbies from public state and applies current Social StartCall authority', async () => {
  const callGuards = { guard: lobbyGuard, getLobby: jest.fn(async () => 'social:dm:alice:bob') };
  expect(await admitCall(context(), 'accepted', { callId: 'call' }, callGuards)).toBe(true);
  expect(callGuards.getLobby).toHaveBeenCalledWith('call');
  expect(isAllowed).toHaveBeenCalledWith({ sub: 'alice', tenant: 'social', role: 'participant' }, 'StartCall');
  jest.mocked(isAllowed).mockImplementation(async (_p, action) => action === 'ViewSocial');
  expect(await admitCall(context(), 'accepted', { callId: 'call' }, callGuards)).toBe(false);
  users.get('alice')!.grants.social = [];
  expect(await admitCall(context(), 'accepted', { callId: 'call' }, callGuards)).toBe(false);
});

it('refuses a forged explicit lobby that renames an existing Social call into OrgIQ', async () => {
  const callGuards = { guard: lobbyGuard, getLobby: jest.fn(async () => 'social:dm:alice:bob') };
  users.get('alice')!.grants.social = [];
  expect(await admitCall(context(), 'participant-state', { callId: 'call', lobbyName: 'orgiq:dm:alice:bob' }, callGuards)).toBe(false);
  expect(callGuards.getLobby).toHaveBeenCalledWith('call');
});

it.each([null, {}, { ...context(), epoch: -1 }, { ...context(), act: [] }, { ...context(), act: { sub: 'operator', epoch: -1 } },
  { ...context(), org: 'unknown' }, { ...context(), sessionIat: 'invalid' }])('rejects malformed socket provenance %#', async ctx => {
  await expect(getLivePrincipal(ctx)).rejects.toMatchObject({ status: 401 });
});

describe('membership authority still respects directory, actor and policy denials', () => {
  const member = (channel: string, userId: string, removedAt: string | null = null): ChatMember => ({ channel, userId, role: 'member',
    addedBy: 'owner', addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt });
  const userIds = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'];
  let durable: ChatMember[]; let store: MirroredMembershipStore; let queries: jest.Mock;
  beforeEach(() => {
    durable = [];
    queries = jest.fn(async (channel: string) => structuredClone(durable.filter(row => row.channel === channel)));
    const persist: ChatMembershipStore = { listMembers: queries, getMember: async () => null,
      putMember: async row => { durable = durable.filter(r => !(r.channel === row.channel && r.userId === row.userId)).concat(structuredClone(row)); } };
    const mirror: ChatMember[] = [];
    store = new MirroredMembershipStore(() => mirror, persist);
    setSocialChatBackend({ ...createMemorySocialChatBackend({ fixtures: false }), membershipStore: store });
    for (const id of userIds) users.set(id, { id, displayName: id, email: null, personId: null, epoch: 2, grants: structuredClone(session.grants) });
  });
  const as = (id: string) => context({ ...session, sub: id });
  const allowAll = { ...guards, guard: () => true };

  it('directory, actor, policy and resource denials still deny when membership allows', async () => {
    const channel = 'social:ch:private';
    durable = [member(channel, 'alice')];
    const check = () => admitChannel({ kind: 'subscribe', clientId: 'a', channel, ctx: as('alice') });
    expect(await check()).toBe(true);
    users.get('alice')!.epoch = 3; expect(await check()).toBe(false);
    users.get('alice')!.epoch = 2; users.get('alice')!.grants.social = []; expect(await check()).toBe(false);
    users.get('alice')!.grants.social = ['participant'];
    users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 8, grants: { orgiq: ['admin'] } });
    const masquerade = context({ ...session, act: { sub: 'operator', epoch: 7, role: 'admin', tenant: 'orgiq', grants: {} } });
    expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel, ctx: masquerade })).toBe(false);
    jest.mocked(isAllowed).mockResolvedValueOnce(false); expect(await check()).toBe(false);
    // The name's resource rule refusing while the membership proof allows.
    jest.spyOn(store, 'isActiveMember').mockReturnValueOnce(false); expect(await check()).toBe(false);
    // The epoch bump lands while the early proof is outstanding.
    jest.mocked(getUser).mockImplementationOnce(async id => { const user = structuredClone(users.get(id)!); user.epoch = 9; return user; });
    expect(await check()).toBe(false);
    const lobby = 'social:dm:alice:bob'; durable.push(member(lobby, 'alice'));
    users.get('alice')!.epoch = 4;
    expect(await admitCallRecipient(as('alice'), { callId: 'call' }, { guard: () => true, getLobby: async () => lobby })).toBe(false);
    expect(queries.mock.calls.length).toBeGreaterThan(0);
  });

  it('a failed early proof abandoned on a denial path neither crashes nor leaks an observer', async () => {
    const rejections: unknown[] = []; const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      queries.mockImplementation(async () => { throw new Error('Dynamo unavailable'); });
      jest.mocked(getUser).mockRejectedValueOnce(new Error('Aurora unavailable'));
      expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel: 'social:dm:alice:bob', ctx: as('alice') })).toBe(false);
      jest.mocked(isAllowed).mockResolvedValueOnce(false);
      expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel: 'social:dm:alice:bob', ctx: as('alice') })).toBe(false);
      expect(await admitChannel({ kind: 'subscribe', clientId: 'a', channel: 'social:dm:alice:bob', ctx: as('alice') })).toBe(false);
      expect(await admitCallRecipient(as('alice'), { callId: 'call' },
        { guard: () => true, getLobby: async () => { throw new Error('Redis unavailable'); } })).toBe(false);
      jest.mocked(getUser).mockRejectedValueOnce(new Error('Aurora unavailable'));
      expect(await admitCallRecipient(as('alice'), { callId: 'call', lobbyName: 'social:dm:alice:bob' },
        { guard: () => true, getLobby: async () => { throw new Error('Redis unavailable'); } })).toBe(false);
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      expect(rejections).toEqual([]);
      expect((store as unknown as { observers: Map<string, Set<unknown>> }).observers.size).toBe(0);
    } finally { process.off('unhandledRejection', onRejection); }
  });
});
