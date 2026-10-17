// realtime-modules 0.108: router plugins receive the operation's AuthorityScope
// (`onMessage` the send/fan-out scope), retained until the plugin settles.
// The gateway's notify plugins (realtime-gateway.ts dmNotifyPlugin,
// channelNotifyPlugin, tenantMentionNotifyPlugin) thread it into their
// membership reads and readable-subscription probes. Contracts, through a real
// LocalRealtimeRouter whose authorize is the gateway's live authority:
//   - one chat send makes ONE durable membership read across the publish
//     check, the fan-out checks and every plugin read/probe, even when the
//     sending operation closes its scope before the plugin finishes;
//   - a revocation that lands mid-plugin denies every remaining probe and the
//     removed member is not alerted;
//   - a publish without a caller scope still shares the router's fan-out scope.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { LocalRealtimeRouter, createAuthorityScope, baseChannel, type AuthorityScope } from '@connorhoehn/realtime-modules/server';
import type { ChatMember, ChatMembershipStore } from '@connorhoehn/realtime-modules/chat';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';

import { channelGuard, channelNotifyPlugin, dmNotifyPlugin, tenantMentionNotifyPlugin } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, MirroredMembershipStore, setSocialChatBackend } from '../social-chat.js';
import { setNotificationSink } from '../social-notify.js';
import { admitChannel } from '../gateway/authority.js';

const CH = 'social:ch:private';
const DM = 'social:dm:alice:bob:carol';
const TOPIC = 'orgiq:initiative:p-1';
const member = (channel: string, userId: string, removedAt: string | null = null): ChatMember =>
  ({ channel, userId, role: 'member', addedBy: 'alice', addedAt: '2026-10-06T00:00:00.000Z', historyFrom: null, removedAt });
const guards = { guard: channelGuard, baseChannel };
type Msg = Record<string, unknown>;

let durable: ChatMember[]; let mirror: ChatMember[]; let reads: string[]; let store: MirroredMembershipStore;
let users: Map<string, UserInfo>; let alerts: Array<{ userId: string; type: unknown }>;
let probes: Array<{ clientId: string; channel: string; scoped: boolean; result: boolean }>;
let midPlugin: (() => Promise<void>) | null;

const ctx = (userId: string): Msg => {
  const u = users.get(userId)!;
  const org = u.grants.social ? 'social' : 'orgiq';
  return { userId, org, role: (u.grants[org] ?? [])[0], epoch: 1, sessionIat: 1, tenants: Object.keys(u.grants), displayName: userId };
};
const chatFrame = (userId: string, channel: string, text: string): Msg =>
  ({ type: 'chat', action: 'message', channel, message: { userId, message: text, metadata: { userId, displayName: userId } } });

beforeEach(() => {
  durable = [member(CH, 'alice'), member(CH, 'bob'), member(CH, 'carol'), member(DM, 'alice'), member(DM, 'bob'), member(DM, 'carol')];
  mirror = [member(CH, 'alice'), member(CH, 'bob'), member(CH, 'carol')];
  reads = []; alerts = []; probes = []; midPlugin = null;
  const persist: ChatMembershipStore = {
    listMembers: async (channel: string) => { reads.push(channel); return structuredClone(durable.filter(row => row.channel === channel)); },
    getMember: async (channel, userId) => durable.find(row => row.channel === channel && row.userId === userId) ?? null,
    putMember: async (row) => { durable = durable.filter(r => !(r.channel === row.channel && r.userId === row.userId)).concat(structuredClone(row)); },
  };
  store = new MirroredMembershipStore(() => mirror, persist);
  setSocialChatBackend({ ...createMemorySocialChatBackend({ fixtures: false }), membershipStore: store });
  users = new Map(['alice', 'bob', 'carol'].map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 1, grants: { social: ['participant'] } }]));
  for (const id of ['olga', 'omar', 'otto']) users.set(id, { id, displayName: id, email: null, personId: null, epoch: 1, grants: { orgiq: ['member'] } });
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()].map(u => structuredClone(u)));
  jest.mocked(isAllowed).mockImplementation(async (p, action) =>
    p.tenant === 'social' && p.role === 'participant' && ['ViewSocial', 'PostMessage'].includes(action));
  setNotificationSink({ notifyUser: async (userId, input) => { alerts.push({ userId, type: input.type }); } });
});
afterEach(() => { setNotificationSink(null); setSocialChatBackend(null); jest.clearAllMocks(); });

function setup(subscribed: Record<string, string[]>) {
  const contexts = new Map<string, Msg>();
  let router!: LocalRealtimeRouter;
  const getRouter = () => router as never;
  router = new LocalRealtimeRouter({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    authorize: ({ kind, clientId, channel, ctx: c, scope }) =>
      admitChannel({ kind, clientId, channel, ctx: c as Msg | null, ...(scope ? { scope } : {}) }),
    plugins: [dmNotifyPlugin(getRouter), channelNotifyPlugin(getRouter), tenantMentionNotifyPlugin(getRouter)],
  });
  router._setHandle({
    getClientContext: (id: string) => contexts.get(id) ?? null,
    sendToClient: () => true,
    listClients: () => [...contexts.keys()],
  } as never);
  // Observe the plugins' readable-subscription probes; `midPlugin` lands a
  // revocation after the plugin has its audience and before it probes.
  const probe = router.isClientSubscribed.bind(router);
  router.isClientSubscribed = async (clientId: string, channel: string, opts?: { scope?: AuthorityScope }) => {
    const result = await probe(clientId, channel, opts);
    probes.push({ clientId, channel, scoped: !!opts?.scope, result });
    return result;
  };
  const lookup = router.getClientsByUserId.bind(router);
  (router as unknown as { getClientsByUserId: unknown }).getClientsByUserId = async (ids: string[], exclude?: string) => {
    const found = lookup(ids, exclude);
    if (midPlugin) { const land = midPlugin; midPlugin = null; await land(); }
    return found;
  };
  return {
    router, contexts,
    async connect() {
      for (const user of new Set([...users.keys()])) contexts.set(`${user}-s`, ctx(user));
      for (const [channel, who] of Object.entries(subscribed)) {
        for (const user of who) expect(await router.subscribeToChannel(`${user}-s`, channel)).not.toBe(false);
      }
      reads = []; probes = [];
    },
  };
}

/** The send as the chat service runs it: one scope, closed when its own work ends (the plugin retains it). */
async function send(router: LocalRealtimeRouter, from: string, channel: string, text: string, scoped = true): Promise<AuthorityScope | null> {
  const scope = scoped ? createAuthorityScope('chat.send') : null;
  try {
    if (scope) expect(await router.checkChannel('publish', `${from}-s`, channel, { scope })).toBe(true);
    await router.sendToChannel(channel, chatFrame(from, channel, text), `${from}-s`, { publisherClientId: `${from}-s`, ...(scope ? { scope } : {}) });
  } finally { scope?.close(); }
  return scope;
}
async function settle(): Promise<void> { for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve)); }

describe('one chat send, one membership read across authorize and plugins', () => {
  it('a private channel: publish check, fan-out, plugin audience and unread probes share one durable read', async () => {
    const { router, connect } = setup({ [CH]: ['alice', 'bob'] });
    await connect();
    const scope = await send(router, 'alice', CH, 'standup in five');
    await settle();
    expect(reads).toEqual([CH]);
    // bob reads the channel (no alert), carol does not (a message alert).
    expect(alerts).toEqual([{ userId: 'carol', type: 'message' }]);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(p => p.scoped)).toBe(true);
    // The sending operation closed its scope before the plugin finished; the
    // plugin retained it and released it when it settled.
    expect(scope!.active).toBe(false);
  });

  it('a DM: the unread probes share the send’s proof', async () => {
    const { router, connect } = setup({ [DM]: ['alice', 'bob'] });
    await connect();
    await send(router, 'alice', DM, 'hello both');
    await settle();
    expect(reads).toEqual([DM]);
    expect(alerts).toEqual([{ userId: 'carol', type: 'message' }]);
    expect(probes.filter(p => p.clientId === 'bob-s' && p.result)).not.toHaveLength(0);
    expect(probes.every(p => p.scoped)).toBe(true);
  });

  it('a tenant discussion mention: each mentioned reader’s membership read shares one read', async () => {
    // The initiative discussion's write authority is DispatchAgentRun; reading needs only the tenant.
    jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'orgiq' && action === 'DispatchAgentRun');
    const { router, connect } = setup({ [TOPIC]: ['olga'] });
    await connect();
    await send(router, 'olga', TOPIC, '@omar and @otto, please look');
    await settle();
    expect(reads).toEqual([TOPIC]);
    expect(alerts.map(a => a.userId).sort()).toEqual(['omar', 'otto']);
  });

  it('a publish with no caller scope still hands the plugin the router’s own fan-out scope', async () => {
    const { router, connect } = setup({ [CH]: ['alice', 'bob'] });
    await connect();
    await send(router, 'alice', CH, 'no caller scope', false);
    await settle();
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(p => p.scoped)).toBe(true);
    expect(reads).toEqual([CH]);
    expect(alerts).toEqual([{ userId: 'carol', type: 'message' }]);
  });
});

describe('a revocation that lands mid-plugin', () => {
  it('denies every remaining probe of the operation, and the removed member is not alerted', async () => {
    const { router, connect } = setup({ [CH]: ['alice', 'bob', 'carol'] });
    await connect();
    // carol is removed after the plugin has its audience, before it probes.
    midPlugin = () => store.putMember(member(CH, 'carol', '2026-10-06T01:00:00.000Z'));
    await send(router, 'alice', CH, 'after the removal');
    await settle();
    expect(midPlugin).toBeNull();
    // bob is subscribed and still a member, yet the shared proof is now
    // changed: every probe after the removal denies (bob counts as not
    // reading — a conservative alert, never a leak).
    const after = probes.filter(p => p.scoped);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(p => !p.result)).toBe(true);
    expect(alerts).toEqual([{ userId: 'bob', type: 'message' }]);
    // The re-ask after the probes read fresh (the shared read was fenced).
    expect(reads).toEqual([CH, CH]);
  });

  it('a removal of the SENDER mid-plugin alerts nobody', async () => {
    const { router, connect } = setup({ [CH]: ['alice', 'bob'] });
    await connect();
    midPlugin = () => store.putMember(member(CH, 'alice', '2026-10-06T01:00:00.000Z'));
    await send(router, 'alice', CH, 'leaving');
    await settle();
    expect(alerts).toEqual([]);
  });

  it('a peer invalidation hint mid-plugin (no payload trusted) also denies the remaining probes', async () => {
    const { router, connect } = setup({ [DM]: ['alice', 'bob', 'carol'] });
    await connect();
    midPlugin = async () => { store.invalidate(DM); };
    await send(router, 'alice', DM, 'hint lands now');
    await settle();
    const scoped = probes.filter(p => p.scoped);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every(p => !p.result)).toBe(true);
    // DM membership is the name; both remain, both get the conservative alert.
    expect(alerts.map(a => a.userId).sort()).toEqual(['bob', 'carol']);
  });

  it('an epoch bump of one recipient mid-plugin denies that recipient’s probe only through the directory', async () => {
    const { router, connect } = setup({ [CH]: ['alice', 'bob', 'carol'] });
    await connect();
    midPlugin = async () => { users.get('bob')!.epoch = 2; };
    await send(router, 'alice', CH, 'epoch');
    await settle();
    expect(probes.filter(p => p.clientId === 'bob-s').every(p => !p.result)).toBe(true);
    expect(probes.filter(p => p.clientId === 'carol-s').some(p => p.result)).toBe(true);
    expect(reads).toEqual([CH]);
    expect(alerts).toEqual([{ userId: 'bob', type: 'message' }]);
  });
});
