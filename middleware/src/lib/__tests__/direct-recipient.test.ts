jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { directRecipientFilter } from '../direct-recipient.js';
import { createMemorySocialChatBackend, MirroredMembershipStore, setSocialChatBackend, socialChat } from '../social-chat.js';

const ctx = { userId: 'bob', org: 'orgiq', role: 'member', epoch: 2, sessionIat: 100, tenants: ['orgiq', 'social'] };
const DM = 'social:dm:alice:bob';
const guards = { guard: (_: unknown, lobby: string) => ['orgiq:initiative:test', DM, 'social:dm:bob:carol'].includes(lobby),
  getLobby: async () => DM };
const filter = directRecipientFilter(guards);
let users: Map<string, UserInfo>;
beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([['bob', { id: 'bob', displayName: 'Bob', email: null, personId: null, epoch: 2,
    grants: { orgiq: ['member'], social: ['participant'] } }]]);
  jest.mocked(getUser).mockImplementation(async id => users.has(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async (_, action) => action === 'ViewSocial');
});
afterEach(() => jest.clearAllMocks());
const item = (id: string, tenant = 'social', channel?: string) => ({ id, title: `Private ${id}`, type: 'message',
  payload: { tenant, ...(channel ? { channel } : {}) }, action: { href: tenant === 'social' ? '/social/teams' : '/iq/projects' } });
const bulk = (...notifications: unknown[]) => ({ type: 'notification:bulk-update', payload: { notifications } });

it('keeps unrelated service delivery synchronous under its existing authority boundary', () => {
  for (const type of ['chat', 'call-chat', 'call-page', 'error']) {
    const message = { type, data: 'owned by the original service' };
    expect(filter({ clientId: 'b', message, ctx })).toBe(message);
  }
  expect(getUser).not.toHaveBeenCalled();
});

it('uses current ViewSocial for recipients without requiring call creation policy', async () => {
  const message = { type: 'call', action: 'invite', data: { callId: 'call', lobbyName: DM, callerId: 'alice' } };
  expect(await filter({ clientId: 'b', message, ctx })).toBe(message);
  expect(isAllowed).toHaveBeenCalledWith({ sub: 'bob', tenant: 'social', role: 'participant' }, 'ViewSocial');
  expect(isAllowed).not.toHaveBeenCalledWith(expect.anything(), 'StartCall');
});
it.each(['grant', 'epoch', 'source-role', 'actor', 'outage', 'policy', 'membership'])('refuses direct call data after %s revocation', async reason => {
  let context = ctx;
  if (reason === 'grant') users.get('bob')!.grants.social = [];
  if (reason === 'epoch') users.get('bob')!.epoch++;
  if (reason === 'source-role') users.get('bob')!.grants.orgiq = ['sme'];
  if (reason === 'actor') context = { ...ctx, act: { sub: 'retired-operator', epoch: 1 } } as typeof ctx;
  if (reason === 'outage') jest.mocked(getUser).mockRejectedValue(new Error('offline'));
  if (reason === 'policy') jest.mocked(isAllowed).mockResolvedValue(false);
  if (reason === 'membership') await socialChat().membershipStore.putMember({ channel: DM, userId: 'bob', role: 'member',
    addedBy: 'alice', addedAt: '2026-10-04', historyFrom: null, removedAt: '2026-10-04' });
  expect(await filter({ clientId: 'b', ctx: context, message: { type: 'call', action: 'invite', data: { callId: 'call', lobbyName: DM } } })).toBeNull();
});
it('filters each persisted item by current tenant rights without mutating the stored batch', async () => {
  const message = bulk(item('social'), item('orgiq', 'orgiq'));
  users.get('bob')!.grants.social = [];
  expect(await filter({ clientId: 'b', ctx, message })).toEqual(bulk(item('orgiq', 'orgiq')));
  expect(message.payload.notifications).toHaveLength(2);
  expect(await filter({ clientId: 'b', ctx, message: { type: 'notification:new', payload: item('social') } })).toBeNull();
});
it('a full unread window shares current resource checks only inside that one reply', async () => {
  const store = socialChat().membershipStore;
  const read = jest.spyOn(store, 'listMembers');
  const records = Array.from({ length: 200 }, (_, index) => item(`unread-${index}`, 'social', DM));
  const message = bulk(...records);
  try {
    expect(await filter({ clientId: 'b', ctx, message })).toEqual(message);
    expect(read).toHaveBeenCalledTimes(1);
    expect(isAllowed).toHaveBeenCalledTimes(1);
    // A later reply must read the resource again, even for the same user and
    // channel; it cannot retain this batch's positive membership answer.
    await store.putMember({ channel: DM, userId: 'bob', role: 'member', addedBy: 'alice',
      addedAt: '2026-10-05', historyFrom: null, removedAt: '2026-10-05' });
    expect(await filter({ clientId: 'b', ctx, message })).toEqual(bulk());
    expect(read).toHaveBeenCalledTimes(2);
    expect(message.payload.notifications).toHaveLength(200);
  } finally { read.mockRestore(); }
});

it('hydrates a cold peer resource before applying the synchronous recipient guard', async () => {
  const channel = 'social:ch:remote-private', rows: import('@connorhoehnslalom/realtime-modules/chat').ChatMember[] = [];
  const member = { channel, userId: 'bob', role: 'member' as const, addedBy: 'alice', addedAt: '2026-10-05', historyFrom: null, removedAt: null };
  const read = jest.fn(async () => [structuredClone(member)]);
  const membershipStore = new MirroredMembershipStore(() => rows, { listMembers: read,
    getMember: async () => structuredClone(member), putMember: async () => undefined });
  setSocialChatBackend({ ...createMemorySocialChatBackend({ fixtures: false }), membershipStore });
  const coldFilter = directRecipientFilter({ ...guards, guard: () => membershipStore.isActiveMember(channel, 'bob') });
  const message = bulk(item('cold-peer', 'social', channel));
  expect(membershipStore.isActiveMember(channel, 'bob')).toBe(false);
  expect(await coldFilter({ clientId: 'b', ctx, message })).toEqual(message);
  expect(read).toHaveBeenCalledTimes(1);
});
it('holds membership fences across the entire bulk policy/read operation', async () => {
  const store = socialChat().membershipStore;
  const row = { channel: DM, userId: 'bob', role: 'member' as const, addedBy: 'alice', addedAt: '2026-10-04', historyFrom: null, removedAt: null };
  await store.putMember(row);
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { release = r; }); const start = new Promise<void>(r => { started = r; });
  const original = store.listMembers.bind(store);
  const read = jest.spyOn(store, 'listMembers').mockImplementation(async channel => {
    if (channel === 'social:dm:bob:carol') { started(); await waiting; }
    return original(channel);
  });
  const first = item('first', 'social', DM), second = item('second', 'social', 'social:dm:bob:carol');
  const pending = filter({ clientId: 'b', ctx, message: bulk(first, second) }); await start;
  try {
    await store.putMember({ ...row, removedAt: '2026-10-04' }); release();
    expect(await pending).toEqual(bulk(second));
  } finally { release(); read.mockRestore(); }
});
it('rechecks the source epoch after a delayed notification policy read', async () => {
  jest.mocked(isAllowed).mockImplementation(async () => { users.get('bob')!.epoch++; return true; });
  expect(await filter({ clientId: 'b', ctx, message: bulk(item('private')) })).toBeNull();
});
it('refuses cross-tenant links, conflicting channels, inaccessible lobbies and current approval denial', async () => {
  const valid = item('valid');
  const wrongHref = { ...valid, action: { href: '/assessment/workspace' } };
  const traversal = { ...valid, action: { href: '/social/%2e%2e/assessment/workspace' } };
  const backslash = { ...valid, action: { href: '/social/..\\assessment/workspace' } };
  const wrongChannel = { ...valid, channel: DM, payload: { tenant: 'social', channel: 'social:dm:bob:carol' } };
  const outside = item('outside', 'social', 'social:dm:alice:carol');
  const approval = { ...item('approval', 'orgiq'), payload: { tenant: 'orgiq', kind: 'approval' } };
  expect(await filter({ clientId: 'b', ctx, message: bulk(wrongHref, traversal, backslash, wrongChannel, outside, approval, valid) })).toEqual(bulk(valid));
});
it('scopes missed calls by the call lobby and supports the existing OrgIQ initiative origin', async () => {
  const missed = { ...item('missed', 'orgiq'), channel: 'initiative:test', payload: { tenant: 'orgiq', kind: 'call-missed', channel: 'initiative:test' } };
  expect(await filter({ clientId: 'b', ctx, message: bulk(missed) })).toEqual(bulk(missed));
  const social = { ...item('social-missed'), channel: 'initiative:test', payload: { tenant: 'social', kind: 'call-missed', lobbyName: 'social:dm:alice:carol' } };
  expect(await filter({ clientId: 'b', ctx, message: bulk(social) })).toEqual(bulk());
});
it('allows a current forgotten receipt after state deletion but refuses unscoped call data', async () => {
  const unscoped = directRecipientFilter({ ...guards, getLobby: async () => null });
  expect(await unscoped({ clientId: 'b', ctx, message: { type: 'call', action: 'participant-state', data: { callId: 'gone' } } })).toBeNull();
  const receipt = { type: 'call', action: 'forgotten', data: { callId: 'gone', forgotten: true } };
  expect(await unscoped({ clientId: 'b', ctx, message: receipt })).toBe(receipt);
  users.get('bob')!.epoch++; expect(await unscoped({ clientId: 'b', ctx, message: receipt })).toBeNull();
});
