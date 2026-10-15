// Resource authority for the non-Social tenant channel families
// (lib/tenant-channels.ts), through the real authorizeLiveGatewayChannel and
// call admission with the real channelGuard/lobbyGuard. Identity and policy
// are mocked so each case names exactly which authority decides it.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { authorizeLiveGatewayCall, authorizeLiveGatewayChannel } from '../live-principal.js';
import { channelGuard, lobbyGuard } from '../realtime-gateway.js';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { TENANT_CHANNEL_FAMILIES, tenantChannelFamily } from '../tenant-channels.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import { initiativeDecksFixture } from '../../mock/initiative-decks.js';

// The seed matrix, for the actions these families ask.
const POLICY: Record<string, string[]> = {
  member: [], sme: ['DispatchAgentRun'],
  assessor: ['ViewAssessment'], author: ['ViewPipelines'], operator: ['ViewPipelines'], admin: ['*'],
};
let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>, epoch = 1): UserInfo =>
  ({ id, displayName: id, email: null, personId: null, epoch, grants });
const ctx = (userId: string, org: string, role: string, epoch = 1) =>
  ({ userId, org, role, epoch, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const guards = { guard: channelGuard, baseChannel };
const authorize = (c: ReturnType<typeof ctx>, channel: string, kind: 'subscribe' | 'publish' = 'subscribe') =>
  authorizeLiveGatewayChannel({ kind, clientId: 'socket', channel, ctx: c }, guards);

beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  // A non-budget initiative deck: tenant-open, like the REST read (initiative-deck-channel.test.ts covers the budget tier).
  initiativeDecksFixture.rows().unshift({ id: 'idk-0b1c2d3e-0000-4000-8000-000000000001', projectId: 'p-soc2', title: 'T', includesBudget: false, createdBy: 'mia', createdAt: 'x', updatedAt: 'x', headRevisionId: null });
  users = new Map([
    ['mia', user('mia', { orgiq: ['member'] })],
    ['sam', user('sam', { orgiq: ['sme'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['root', user('root', { orgiq: ['admin'], assessment: ['admin'], pipelines: ['admin'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (POLICY[p.role] ?? []).some(a => a === action || a === '*'));
});
afterEach(() => { jest.clearAllMocks(); initiativeDecksFixture.reset(); });

const READERS: Array<[string, () => ReturnType<typeof ctx>]> = [
  ['orgiq:invoke', () => ctx('mia', 'orgiq', 'member')],
  ['orgiq:session:abc-123', () => ctx('mia', 'orgiq', 'member')],
  ['orgiq:initiative:p-soc2', () => ctx('mia', 'orgiq', 'member')],
  ['orgiq:work:wi-zt-e1', () => ctx('mia', 'orgiq', 'member')],
  ['assessment:doc:page:100002', () => ctx('ana', 'assessment', 'assessor')],
  ['assessment:doc:h:3k2j1', () => ctx('ana', 'assessment', 'assessor')],
  ['presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', () => ctx('mia', 'orgiq', 'member')],
  ['presence:assessment:knowledge:confluence-eng', () => ctx('ana', 'assessment', 'assessor')],
  ['presence:assessment:deck:deck-1', () => ctx('ana', 'assessment', 'assessor')],
  ['presence:pipelines:deck:deck-1', () => ctx('pat', 'pipelines', 'author')],
  ['pipelines:run:job:42', () => ctx('pat', 'pipelines', 'author')],
  ['pipelines:def:agent:search', () => ctx('pat', 'pipelines', 'author')],
  ['presence:orgiq:lobby', () => ctx('mia', 'orgiq', 'member')],
  ['presence:pipelines:lobby', () => ctx('pat', 'pipelines', 'author')],
];

describe('every family the portal uses', () => {
  it('lists each portal channel builder', () => {
    for (const [channel] of READERS) expect(tenantChannelFamily(baseChannel(channel))).not.toBeNull();
    expect(TENANT_CHANNEL_FAMILIES.length).toBeGreaterThanOrEqual(11);
  });
  it.each(READERS)('%s admits its reader', async (channel, c) => {
    expect(await authorize(c(), channel)).toBe(true);
    expect(await authorize(c(), channel.startsWith('presence:') ? channel : `presence:${channel}`, 'publish')).toBe(true);
  });
  it.each(READERS)('%s also admits the cross-tenant admin', async (channel) => {
    expect(await authorize(ctx('root', 'orgiq', 'admin'), channel)).toBe(true);
  });
});

describe('non-readers', () => {
  it('denies a grant holder standing in another tenant (the requireTenant rule)', async () => {
    // Ana holds orgiq:member, but her signed session is in orgiq, not assessment.
    expect(await authorize(ctx('ana', 'orgiq', 'member'), 'assessment:doc:page:100002')).toBe(false);
    expect(await authorize(ctx('pat', 'orgiq', 'member'), 'pipelines:run:job:42')).toBe(false);
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'orgiq:initiative:p-soc2')).toBe(false);
  });
  it('denies the right tenant when the REST action is not granted', async () => {
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'assessment:doc:page:100002')).toBe(false);
    expect(await authorize(ctx('pat', 'pipelines', 'author'), 'presence:pipelines:def:x')).toBe(false);
    expect(isAllowed).toHaveBeenCalledWith({ sub: 'ana', tenant: 'assessment', role: 'assessor' }, 'ViewAssessment');
    expect(isAllowed).toHaveBeenCalledWith({ sub: 'pat', tenant: 'pipelines', role: 'author' }, 'ViewPipelines');
  });
  it('denies cross-tenant partitions outright, even for the lobby', async () => {
    expect(await authorize(ctx('mia', 'orgiq', 'member'), 'presence:assessment:lobby')).toBe(false);
    expect(await authorize(ctx('mia', 'orgiq', 'member'), 'pipelines:def:x')).toBe(false);
    expect(isAllowed).not.toHaveBeenCalled();
  });
});

describe('pipelines:deck (run report deck presence)', () => {
  const pat = () => ctx('pat', 'pipelines', 'author');
  it('admits presence for ViewPipelines in the pipelines session', async () => {
    expect(await authorize(pat(), 'presence:pipelines:deck:deck-1')).toBe(true);
    expect(await authorize(pat(), 'presence:pipelines:deck:deck-1', 'publish')).toBe(true);
    expect(isAllowed).toHaveBeenCalledWith({ sub: 'pat', tenant: 'pipelines', role: 'author' }, 'ViewPipelines');
  });
  it('refuses chat, reactions and a call lobby on it', async () => {
    expect(await authorize(pat(), 'pipelines:deck:deck-1')).toBe(false);
    expect(await authorize(pat(), 'pipelines:deck:deck-1', 'publish')).toBe(false);
    expect(await authorize(pat(), 'reactions:pipelines:deck:deck-1', 'publish')).toBe(false);
    expect(lobbyGuard({ userId: 'pat', org: 'pipelines', tenants: ['pipelines'] }, 'pipelines:deck:deck-1')).toBe(false);
  });
  it('refuses malformed names', async () => {
    for (const name of ['presence:pipelines:deck:', 'presence:pipelines:deck:a b', `presence:pipelines:deck:${'x'.repeat(257)}`]) {
      expect(await authorize(pat(), name)).toBe(false);
    }
    expect(tenantChannelFamily('pipelines:deck:')).toBeNull();
  });
  it('refuses another tenant, and a pipelines grant standing in orgiq', async () => {
    expect(await authorize(ctx('mia', 'orgiq', 'member'), 'presence:pipelines:deck:deck-1')).toBe(false);
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'presence:pipelines:deck:deck-1')).toBe(false);
    expect(await authorize(ctx('pat', 'orgiq', 'member'), 'presence:pipelines:deck:deck-1')).toBe(false);
  });
});

describe('orgiq:deck (initiative status deck presence)', () => {
  const mia = () => ctx('mia', 'orgiq', 'member');
  it('admits presence, read and publish, for the orgiq session', async () => {
    expect(await authorize(mia(), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(true);
    expect(await authorize(mia(), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', 'publish')).toBe(true);
    expect(await authorize(ctx('sam', 'orgiq', 'sme'), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', 'publish')).toBe(true);
  });
  it('refuses chat, reactions, activity and a call lobby on it', async () => {
    expect(await authorize(mia(), 'orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
    expect(await authorize(mia(), 'orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', 'publish')).toBe(false);
    expect(await authorize(ctx('sam', 'orgiq', 'sme'), 'orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', 'publish')).toBe(false);
    expect(await authorize(mia(), 'reactions:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001', 'publish')).toBe(false);
    expect(await authorize(mia(), 'activity:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
    expect(lobbyGuard({ userId: 'mia', org: 'orgiq', tenants: ['orgiq'] }, 'orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
  });
  it('refuses malformed names', async () => {
    for (const name of ['presence:orgiq:deck:', 'presence:orgiq:deck:a b', `presence:orgiq:deck:${'x'.repeat(257)}`]) {
      expect(await authorize(mia(), name)).toBe(false);
    }
    expect(tenantChannelFamily('orgiq:deck:')).toBeNull();
  });
  it('refuses other tenants, and an orgiq grant standing in another tenant', async () => {
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
    expect(await authorize(ctx('pat', 'pipelines', 'author'), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
    expect(await authorize(ctx('mia', 'assessment', 'assessor'), 'presence:orgiq:deck:idk-0b1c2d3e-0000-4000-8000-000000000001')).toBe(false);
  });
});

describe('publish versus subscribe', () => {
  it('lets an orgiq member watch an initiative or work item but not post; an SME may post', async () => {
    for (const channel of ['orgiq:initiative:p-soc2', 'orgiq:work:wi-1']) {
      expect(await authorize(ctx('mia', 'orgiq', 'member'), channel)).toBe(true);
      expect(await authorize(ctx('mia', 'orgiq', 'member'), channel, 'publish')).toBe(false);
      expect(await authorize(ctx('mia', 'orgiq', 'member'), `reactions:${channel}`, 'publish')).toBe(false);
      // Typing is a chat action on the bare channel; no client names a
      // `typing:` channel. Since baseChannel (realtime-modules 0.107) such a
      // name keeps its prefix as its partition and fails closed.
      expect(await authorize(ctx('mia', 'orgiq', 'member'), `typing:${channel}`, 'publish')).toBe(false);
      expect(await authorize(ctx('mia', 'orgiq', 'member'), `presence:${channel}`, 'publish')).toBe(true);
      expect(await authorize(ctx('sam', 'orgiq', 'sme'), channel, 'publish')).toBe(true);
    }
    expect(isAllowed).toHaveBeenCalledWith({ sub: 'mia', tenant: 'orgiq', role: 'member' }, 'DispatchAgentRun');
  });
  it('keeps presence-only families presence-only', async () => {
    const ana = ctx('ana', 'assessment', 'assessor');
    expect(await authorize(ana, 'assessment:knowledge:confluence-eng')).toBe(false);
    expect(await authorize(ana, 'assessment:knowledge:confluence-eng', 'publish')).toBe(false);
    expect(await authorize(ctx('mia', 'orgiq', 'member'), 'orgiq:lobby', 'publish')).toBe(false);
    expect(await authorize(ctx('mia', 'orgiq', 'member'), 'chat:orgiq:lobby')).toBe(false);
  });
  it('lets readers post where REST lets readers comment (assessment docs, pipelines discussions)', async () => {
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'assessment:doc:page:100002', 'publish')).toBe(true);
    expect(await authorize(ctx('pat', 'pipelines', 'author'), 'pipelines:run:job:42', 'publish')).toBe(true);
  });
});

describe('default deny', () => {
  it.each([
    'orgiq:anything', 'orgiq:doc:1', 'orgiq:room:x', 'orgiq:initiative:', 'presence:orgiq:invoke:extra',
    'assessment:private', 'orgiq:deck:', 'chat:orgiq:deck:d1', 'assessment:deck:', 'chat:assessment:deck:d1', 'pipelines:deck:', 'pipelines:deck:a b', 'assessment:room:x', 'pipelines:runs', 'pipelines:lobby:x', 'cursor:orgiq:session:a',
  ])('refuses the unknown name %s to every holder, admin included', async (channel) => {
    expect(await authorize(ctx('mia', 'orgiq', 'member'), channel)).toBe(false);
    expect(await authorize(ctx('root', 'orgiq', 'admin'), channel)).toBe(false);
  });
  it('limits call lobbies to the lobby families', () => {
    const mia = { userId: 'mia', org: 'orgiq', tenants: ['orgiq'] };
    expect(lobbyGuard(mia, 'orgiq:initiative:p-soc2')).toBe(true);
    expect(lobbyGuard(mia, 'orgiq:invoke')).toBe(false);
    expect(lobbyGuard(mia, 'orgiq:lobby')).toBe(false);
    expect(lobbyGuard(mia, 'orgiq:room:x')).toBe(false);
    expect(lobbyGuard({ userId: 'ana', org: 'assessment', tenants: ['assessment'] }, 'assessment:doc:h:abc')).toBe(true);
  });
});

describe('call lobbies ask the family read authority', () => {
  const call = (c: ReturnType<typeof ctx>, lobbyName: string) => authorizeLiveGatewayCall(c, 'invite',
    { callId: 'c1', lobbyName, callerId: c.userId, targetUserIds: ['x'] }, { guard: lobbyGuard, getLobby: async () => null });
  it('admits the document reader and refuses the same person standing elsewhere', async () => {
    expect(await call(ctx('ana', 'assessment', 'assessor'), 'assessment:doc:page:1')).toBe(true);
    expect(await call(ctx('ana', 'orgiq', 'member'), 'assessment:doc:page:1')).toBe(false);
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect(await call(ctx('ana', 'assessment', 'assessor'), 'assessment:doc:page:1')).toBe(false);
  });
});

describe('revocation while the policy decision is pending', () => {
  it.each([
    ['assessment:doc:page:100002', 'ana', 'assessment', 'assessor', 'subscribe'],
    ['pipelines:run:job:42', 'pat', 'pipelines', 'author', 'publish'],
    ['orgiq:initiative:p-soc2', 'sam', 'orgiq', 'sme', 'publish'],
  ] as const)('%s is refused once the role is revoked mid-await', async (channel, who, org, role, kind) => {
    let started!: () => void; let release!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(isAllowed).mockImplementation(async () => { started(); await gate; return true; });
    const pending = authorize(ctx(who, org, role), channel, kind);
    await begun;
    users.get(who)!.grants[org] = [];
    release();
    expect(await pending).toBe(false);
  });
  it('is refused when the session epoch moves mid-await', async () => {
    jest.mocked(isAllowed).mockImplementation(async () => { users.get('ana')!.epoch += 1; return true; });
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), 'assessment:doc:page:100002')).toBe(false);
  });
  it('holds no positive cache: a later decision is asked again', async () => {
    const c = ctx('pat', 'pipelines', 'author');
    expect(await authorize(c, 'pipelines:run:job:42')).toBe(true);
    jest.mocked(isAllowed).mockResolvedValue(false);
    expect(await authorize(c, 'pipelines:run:job:42')).toBe(false);
  });
});
