// The facade contract (docs/realtime-validation/2026-10-08/gateway-split.md §3).
//
// Every row asserts the VERDICT column — what the rule must answer for this
// (feature, family, role): revoked grant, epoch bump, masquerade actor,
// cross-tenant, history floor, non-member lobby, page family existence —
// against one directory world. Until the 0.119 pin move each row also asserted
// equality with the pre-split live-principal primitive (the host copy the
// realtime-modules engine replaced); those copies are deleted, and the verdict
// column, unchanged, is the contract.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []) }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import type { FileUploadRow } from '@connorhoehnslalom/realtime-modules/fileupload';
import { getUser, type UserInfo } from '../../../providers/identity.js';
import { isAllowed } from '../../authz.js';
import { pageResourceVisible } from '../../page-resources.js';
import {
  admitCall, admitCallRecipient, admitChannel, admitConversationChat, admitCursor, admitDistillation, admitDistillationDelivery,
  admitLobbyRead, admitPrincipal, admitReader, admitSocialConversation, admitSubscribe, admitPublish, admitUploadRead,
  callGuards, channelGuard, holdsFamilyAuthority, lobbyGuard, noStoredCall, producerChannelAllowed,
} from '../authority.js';
import { sessionGatewayContext, type LiveGatewayAuth } from '../../live-principal.js';
import { createMemorySocialChatBackend, setSocialChatBackend, type SocialChatBackend } from '../../social-chat.js';
import type { Grants, Session } from '../../session.js';

type Ctx = Record<string, unknown>;
const T0 = '2026-10-08T12:00:00.000Z';
let users: Map<string, UserInfo>;
let backend: SocialChatBackend;
let visible: Set<string>;
let deniedActions: Set<string>;

/** Who holds what: the directory's current grants per seed user. */
const DIRECTORY: Record<string, Grants> = {
  alice: { orgiq: ['member'], social: ['participant'] },
  sam: { orgiq: ['sme'] },
  bob: { orgiq: ['member'], social: ['participant'] },
  carol: { social: ['participant'] },
  ava: { assessment: ['assessor'], orgiq: ['member'] },
  pat: { pipelines: ['operator'] },
  root: { orgiq: ['admin'] },
  nobody: { orgiq: ['member'] },
  // The access tenant (lane A1): a request thread admits its read rule's people.
  rhea: { access: ['requester'] },
  omar: { access: ['approver'] },
  priya: { access: ['access-admin'] },
  zed: { access: ['approver'] },
  mixed: { orgiq: ['member'], access: ['requester'] },
};
/** Cedar, as the seed matrix would answer it: `admin` everything, otherwise the role's own actions. */
const POLICY: Record<string, Record<string, string[]>> = {
  orgiq: { member: ['ViewDistillation'], sme: ['DispatchAgentRun'], admin: ['*'] },
  assessment: { assessor: ['ViewAssessment'] },
  pipelines: { operator: ['ViewPipelines'] },
  social: { participant: ['ViewSocial', 'PostMessage', 'StartCall'] },
  access: { requester: ['ViewAccess', 'RequestAccess'], approver: ['ViewAccess', 'RequestAccess', 'DecideAccess'],
    'access-admin': ['ViewAccess', 'RequestAccess', 'DecideAccess', 'ManageAccessCatalog', 'ManageAccessPolicy', 'ProvisionAccess'] },
};
/** Who the request's read rule admits now, per thread (lib/access/thread.ts, mocked through pageResourceVisible). */
let threadReaders: Map<string, Set<string>>;
const session = (sub: string, tenant: string, role?: string, act?: { sub: string; epoch?: number }): Session => ({
  sub, name: sub, tenant: tenant as Session['tenant'], role: (role ?? DIRECTORY[sub]![tenant]![0]) as Session['role'],
  epoch: 0, grants: structuredClone(DIRECTORY[sub]!), iat: 1_700_000_000,
  ...(act ? { act: { sub: act.sub, epoch: act.epoch ?? 0, role: 'admin', tenant: 'orgiq', grants: {} } } : {}),
});
const ctx = (sub: string, tenant: string, role?: string, act?: { sub: string; epoch?: number }): Ctx =>
  sessionGatewayContext(session(sub, tenant, role, act), value => Number(value ?? 0));
const auth = (sub: string, tenant: string) => ctx(sub, tenant) as LiveGatewayAuth;
async function member(channel: string, userId: string, historyFrom: string | null = null, removedAt: string | null = null) {
  await backend.membershipStore.putMember({ channel, userId, role: 'member', addedBy: 'alice', addedAt: T0, historyFrom, removedAt });
}
const upload = (channel: string, uploader: string, createdAt: string): FileUploadRow => ({
  uploadId: 'u1', channel, uploader, filename: 'notes.pdf', size: 10, contentType: 'application/pdf', status: 'uploaded', createdAt,
} as unknown as FileUploadRow);

beforeEach(() => {
  deniedActions = new Set(); visible = new Set(['orgiq:initiative:p-1', 'assessment:team:TEAM-1', 'pipelines:run:r1']);
  users = new Map(Object.entries(DIRECTORY).map(([id, grants]) => [id, { id, displayName: id, epoch: 0, email: null, personId: null, grants: structuredClone(grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.has(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => {
    if (deniedActions.has(`${principal.sub}:${action}`)) return false;
    const allowed = POLICY[principal.tenant]?.[principal.role] ?? [];
    return allowed.includes('*') || allowed.includes(action);
  });
  threadReaders = new Map([['access:req:req-0001', new Set(['rhea', 'omar', 'priya', 'mixed'])], ['access:req:req-0004', new Set(['priya'])]]);
  jest.mocked(pageResourceVisible).mockImplementation(async (kind, bare, reader) =>
    kind === 'access-request' ? !!reader && (threadReaders.get(bare)?.has(reader) ?? false) : visible.has(bare));
  backend = createMemorySocialChatBackend({ fixtures: false });
  setSocialChatBackend(backend);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { setSocialChatBackend(null); jest.restoreAllMocks(); });

// ── Channels: subscribe / publish / cursor, and the /ws == pre-split equality ──

type ChannelRow = { name: string; ctx: () => Ctx | null; kind: 'subscribe' | 'publish'; channel: string; before?: () => Promise<void> | void; verdict: boolean };
const CHANNEL_ROWS: ChannelRow[] = [
  { name: 'orgiq member reads an initiative discussion', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
  { name: 'orgiq member cannot post to it (DispatchAgentRun is the write)', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'orgiq:initiative:p-1', verdict: false },
  { name: 'an SME posts to it', ctx: () => ctx('sam', 'orgiq'), kind: 'publish', channel: 'orgiq:initiative:p-1', verdict: true },
  { name: 'cross-tenant: a pipelines operator holds no orgiq grant', ctx: () => ctx('pat', 'pipelines'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
  { name: 'cross-tenant: an orgiq grant held while standing in assessment is not the active tenant', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
  { name: 'the same person standing in orgiq reads it', ctx: () => ctx('ava', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
  { name: 'revoked grant: the signed role is no longer granted', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
    before: () => { users.get('alice')!.grants.orgiq = []; }, verdict: false },
  { name: 'epoch bump: another sign-in retired this socket', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
    before: () => { users.get('alice')!.epoch = 1; }, verdict: false },
  { name: 'masquerade: an admin actor behind the target is admitted as the target', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'root' }), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: true },
  { name: 'masquerade: an actor who is no longer admin is refused', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'nobody' }), kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
  { name: 'masquerade: an actor whose epoch moved is refused', ctx: () => ctx('alice', 'orgiq', undefined, { sub: 'root', epoch: 0 }), kind: 'subscribe', channel: 'orgiq:initiative:p-1',
    before: () => { users.get('root')!.epoch = 3; }, verdict: false },
  { name: 'a name no family lists is refused however many grants are held', ctx: () => ctx('root', 'orgiq'), kind: 'subscribe', channel: 'orgiq:nope:1', verdict: false },
  { name: 'page family existence: a team that exists', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'assessment:team:TEAM-1', verdict: true },
  { name: 'page family existence: a team that is gone', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'assessment:team:TEAM-9', verdict: false },
  { name: 'presence on a document (ephemeral: the read authority)', ctx: () => ctx('ava', 'assessment'), kind: 'publish', channel: 'presence:assessment:doc:d1', verdict: true },
  { name: 'cursor on a document canvas', ctx: () => ctx('ava', 'assessment'), kind: 'publish', channel: 'cursor:assessment:doc:d1', verdict: true },
  { name: 'cursor on a family that offers no cursor service', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'cursor:orgiq:work:w1', verdict: false },
  { name: 'cursor from another tenant', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'cursor:assessment:doc:d1', verdict: false },
  { name: 'a social channel member reads it', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:ch:general', before: () => member('social:ch:general', 'alice'), verdict: true },
  { name: 'a social channel non-member is refused', ctx: () => ctx('carol', 'social'), kind: 'subscribe', channel: 'social:ch:general', before: () => member('social:ch:general', 'alice'), verdict: false },
  { name: 'a member whose Social grant was revoked is refused', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:ch:general',
    before: async () => { await member('social:ch:general', 'alice'); users.get('alice')!.grants.social = []; }, verdict: false },
  { name: 'a member denied PostMessage reads but cannot post', ctx: () => ctx('alice', 'social'), kind: 'publish', channel: 'social:ch:general',
    before: async () => { await member('social:ch:general', 'alice'); deniedActions.add('alice:PostMessage'); }, verdict: false },
  { name: 'a DM admits one of its ids', ctx: () => ctx('alice', 'social'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: true },
  { name: 'a DM refuses a third person', ctx: () => ctx('carol', 'social'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: false },
  { name: 'a social grant holder standing in orgiq reaches a social DM (E5)', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'social:dm:alice:bob', verdict: true },
  { name: 'the distillation feed: a plain subscribe standing in orgiq', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: true },
  { name: 'the distillation feed: never a publish', ctx: () => ctx('alice', 'orgiq'), kind: 'publish', channel: 'orgiq:distill:jobs', verdict: false },
  { name: 'the distillation feed: an orgiq grant held from assessment is not enough', ctx: () => ctx('ava', 'assessment'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: false },
  { name: 'the distillation feed: an admin reads it from anywhere', ctx: () => ctx('root', 'orgiq', 'admin'), kind: 'subscribe', channel: 'orgiq:distill:jobs', verdict: true },
  { name: 'a huddle chat name is never admitted by grant alone', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'orgiq:huddle:c1', verdict: false },
  { name: 'no context is refused', ctx: () => null, kind: 'subscribe', channel: 'orgiq:initiative:p-1', verdict: false },
  // access:req:<id> — the request's read rule for THIS reader, now (lane A1).
  { name: 'access: the requester reads her request thread', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
  { name: 'access: the requester posts to it (ViewAccess is the write)', ctx: () => ctx('rhea', 'access'), kind: 'publish', channel: 'access:req:req-0001', verdict: true },
  { name: 'access: the live approver reads it', ctx: () => ctx('omar', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
  { name: 'access: an access-admin reads it', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
  { name: 'access: an approver outside the request\'s read rule is refused', ctx: () => ctx('zed', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
  { name: 'access: the requester is refused someone else\'s request', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0004', verdict: false },
  { name: 'access: an approver who left the read rule (a decided chain) is refused now', ctx: () => ctx('omar', 'access'), kind: 'publish', channel: 'access:req:req-0001',
    before: () => { threadReaders.get('access:req:req-0001')!.delete('omar'); }, verdict: false },
  { name: 'access: a reader whose access grant was revoked is refused', ctx: () => ctx('rhea', 'access'), kind: 'subscribe', channel: 'access:req:req-0001',
    before: () => { users.get('rhea')!.grants.access = []; }, verdict: false },
  { name: 'access: an access grant held while standing in orgiq is not the active tenant', ctx: () => ctx('mixed', 'orgiq'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
  { name: 'access: the same person standing in access reads it', ctx: () => ctx('mixed', 'access'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: true },
  { name: 'access: cross-tenant, an orgiq-only member is refused', ctx: () => ctx('alice', 'orgiq'), kind: 'subscribe', channel: 'access:req:req-0001', verdict: false },
  { name: 'access: presence on the thread (ephemeral: the read authority)', ctx: () => ctx('omar', 'access'), kind: 'publish', channel: 'presence:access:req:req-0001', verdict: true },
  { name: 'access: no cursor service on a request thread', ctx: () => ctx('rhea', 'access'), kind: 'publish', channel: 'cursor:access:req:req-0001', verdict: false },
  { name: 'access: a name no family lists is refused', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:lobby:x', verdict: false },
  { name: 'access: a malformed request id is refused', ctx: () => ctx('priya', 'access'), kind: 'subscribe', channel: 'access:req:nope', verdict: false },
];

describe('admitChannel: the verdict', () => {
  it.each(CHANNEL_ROWS.map(row => [row.name, row] as const))('%s', async (_name, row) => {
    await row.before?.();
    const context = row.ctx();
    const args = { kind: row.kind, clientId: 'c1', channel: row.channel, ctx: context };
    const facade = await admitChannel(args);
    expect(facade).toBe(row.verdict);
    const thin = row.kind === 'subscribe' ? await admitSubscribe(context, row.channel, { clientId: 'c1' }) : await admitPublish(context, row.channel, { clientId: 'c1' });
    expect(thin).toBe(row.verdict);
  });

  it('admitCursor is the router decision on cursor:<channel>', async () => {
    expect(await admitCursor(ctx('ava', 'assessment'), 'assessment:doc:d1', 'publish')).toBe(true);
    expect(await admitCursor(ctx('ava', 'assessment'), 'cursor:assessment:doc:d1', 'publish')).toBe(true);
    expect(await admitCursor(ctx('alice', 'orgiq'), 'assessment:doc:d1', 'publish')).toBe(false);
    expect(await admitCursor(ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe')).toBe(false);
  });
});

// ── /realtime (cookie) and /ws answer the distillation feed the same way ────

describe('admitDistillation: the cookie path equals the /ws path', () => {
  const contexts: Array<[string, Ctx | null]> = [
    ['orgiq member', ctx('alice', 'orgiq')], ['assessment-standing orgiq grant holder', ctx('ava', 'assessment')],
    ['admin', ctx('root', 'orgiq', 'admin')], ['pipelines operator', ctx('pat', 'pipelines')], ['no context', null],
  ];
  it.each(contexts)('%s', async (_name, context) => {
    for (const channel of ['orgiq:distill:jobs', 'orgiq:distill:levels', 'orgiq:distill:review', 'orgiq:distill:other']) {
      for (const kind of ['subscribe', 'publish'] as const) {
        expect(await admitDistillation(context, channel, kind))
          .toBe(await admitChannel({ kind, clientId: 'c1', channel, ctx: context }));
      }
    }
    expect(await admitDistillationDelivery(context)).toBe(await admitDistillation(context, 'orgiq:distill:jobs', 'subscribe'));
  });
  it('fails closed on an epoch bump between frames', async () => {
    const context = ctx('alice', 'orgiq');
    expect(await admitDistillationDelivery(context)).toBe(true);
    users.get('alice')!.epoch = 2;
    expect(await admitDistillationDelivery(context)).toBe(false);
  });
});

// ── Calls: join / invite / recipient / lobby read ────────────────────────────

const lobbies = new Map<string, string>([['c-init', 'orgiq:initiative:p-1'], ['c-team', 'assessment:team:TEAM-1']]);
const stored = async (callId: string) => lobbies.get(callId) ?? null;

type CallRow = { name: string; ctx: () => Ctx; action: string; payload: Record<string, unknown>; before?: () => Promise<void> | void; verdict: boolean };
const CALL_ROWS: CallRow[] = [
  { name: 'join an initiative lobby as an orgiq member', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, verdict: true },
  { name: 'join an initiative that no longer exists', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-gone' }, verdict: false },
  { name: 'a work item is a discussion, not a lobby', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:work:w1' }, verdict: false },
  { name: 'a huddle chat name is not a lobby', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:huddle:c1' }, verdict: false },
  { name: 'cross-tenant: pipelines cannot join an orgiq lobby', ctx: () => ctx('pat', 'pipelines'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, verdict: false },
  { name: 'invite must name the caller as callerId', ctx: () => ctx('alice', 'orgiq'), action: 'invite', payload: { callId: 'x', lobbyName: 'orgiq:initiative:p-1', callerId: 'bob', targetUserIds: ['bob'] }, verdict: false },
  { name: 'invite by the caller', ctx: () => ctx('alice', 'orgiq'), action: 'invite', payload: { callId: 'x', lobbyName: 'orgiq:initiative:p-1', callerId: 'alice', targetUserIds: ['bob'] }, verdict: true },
  { name: 'a stored call cannot be renamed into another lobby', ctx: () => ctx('alice', 'orgiq'), action: 'accepted', payload: { callId: 'c-init', lobbyName: 'orgiq:initiative:p-2' }, verdict: false },
  { name: 'a stored call resolves its lobby from the store', ctx: () => ctx('alice', 'orgiq'), action: 'accepted', payload: { callId: 'c-init' }, verdict: true },
  { name: 'a team huddle on a team that is gone', ctx: () => ctx('ava', 'assessment'), action: 'join', payload: { lobbyName: 'assessment:team:TEAM-1' }, before: () => { visible.delete('assessment:team:TEAM-1'); }, verdict: false },
  { name: 'a team huddle on a team that exists', ctx: () => ctx('ava', 'assessment'), action: 'join', payload: { lobbyName: 'assessment:team:TEAM-1' }, verdict: true },
  { name: 'non-member lobby: a private social channel refuses a non-member ring', ctx: () => ctx('carol', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' }, before: () => member('social:ch:private', 'alice'), verdict: false },
  { name: 'a member with StartCall joins the channel call', ctx: () => ctx('alice', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' }, before: () => member('social:ch:private', 'alice'), verdict: true },
  { name: 'a member denied StartCall cannot', ctx: () => ctx('alice', 'social'), action: 'join', payload: { lobbyName: 'social:ch:private' },
    before: async () => { await member('social:ch:private', 'alice'); deniedActions.add('alice:StartCall'); }, verdict: false },
  { name: 'revoked grant mid-call', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, before: () => { users.get('alice')!.grants.orgiq = []; }, verdict: false },
  { name: 'epoch bump', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { lobbyName: 'orgiq:initiative:p-1' }, before: () => { users.get('alice')!.epoch = 1; }, verdict: false },
  { name: 'nested envelope is normalised like the public service', ctx: () => ctx('alice', 'orgiq'), action: 'join', payload: { data: { lobbyName: 'orgiq:initiative:p-1' } }, verdict: true },
];

describe('admitCall / admitCallRecipient / admitLobbyRead', () => {
  it.each(CALL_ROWS.map(row => [row.name, row] as const))('%s', async (_name, row) => {
    await row.before?.();
    const context = row.ctx();
    const facade = await admitCall(context, row.action, row.payload, callGuards(stored));
    expect(facade).toBe(row.verdict);
  });

  it('the lobby-access route form asks with no stored call behind it', async () => {
    expect(await admitCall(ctx('alice', 'orgiq'), 'join', { lobbyName: 'orgiq:initiative:p-1' }, callGuards(noStoredCall))).toBe(true);
    expect(await admitCall(ctx('alice', 'orgiq'), 'join', { callId: 'c-init' }, callGuards(noStoredCall))).toBe(true);
    expect(await admitCall(ctx('pat', 'pipelines'), 'join', { lobbyName: 'orgiq:initiative:p-1' }, callGuards(noStoredCall))).toBe(false);
  });

  it('a recipient is admitted by its own fresh authority', async () => {
    const guards = callGuards(stored);
    for (const [context, verdict] of [[ctx('bob', 'orgiq'), true], [ctx('pat', 'pipelines'), false], [ctx('ava', 'assessment'), false]] as const) {
      const facade = await admitCallRecipient(context, { callId: 'c-init' }, guards);
      expect(facade).toBe(verdict);
    }
    users.get('bob')!.epoch = 1;
    expect(await admitCallRecipient(ctx('bob', 'orgiq'), { callId: 'c-init' }, guards)).toBe(false);
  });

  it.each([
    ['an orgiq member reads the initiative call log', ctx('alice', 'orgiq'), 'orgiq:initiative:p-1', 'ok'],
    ['a discussion is no lobby', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'not-a-lobby'],
    ['a social channel is no tenant lobby', ctx('alice', 'social'), 'social:ch:general', 'not-a-lobby'],
    ['a team that is gone', ctx('ava', 'assessment'), 'assessment:team:TEAM-9', 'gone'],
    ['cross-tenant is denied', ctx('pat', 'pipelines'), 'orgiq:initiative:p-1', 'denied'],
    ['a pipelines run its operator may read', ctx('pat', 'pipelines'), 'pipelines:run:r1', 'ok'],
  ] as const)('lobby read: %s', async (_name, context, lobby, verdict) => {
    const facade = await admitLobbyRead(context, lobby);
    expect(facade).toBe(verdict);
  });
});

// ── Conversation chat (pins, /summarize, the work graph's own runs) ─────────

describe('admitConversationChat / admitSocialConversation', () => {
  it.each([
    ['a member reads a work-item thread', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', undefined, true],
    ['explicit rows close the thread to non-members', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'bob'), false],
    ['explicit rows admit a listed member', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'alice'), true],
    ['a removed row refuses', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => member('orgiq:work:w1', 'alice', null, T0), false],
    ['social names are refused here (they keep chatAccess)', ctx('alice', 'social'), 'social:ch:general', 'subscribe', () => member('social:ch:general', 'alice'), false],
    ['cross-tenant', ctx('pat', 'pipelines'), 'orgiq:work:w1', 'subscribe', undefined, false],
    ['revoked grant', ctx('alice', 'orgiq'), 'orgiq:work:w1', 'subscribe', () => { users.get('alice')!.grants.orgiq = []; }, false],
    ['a run its operator may read', ctx('pat', 'pipelines'), 'pipelines:run:r1', 'subscribe', undefined, true],
  ] as const)('%s', async (_name, context, channel, kind, before, verdict) => {
    await before?.();
    const args = { ctx: context, channel, kind, clientId: 'rest:test' };
    const facade = await admitConversationChat(args);
    expect(facade).toBe(verdict);
  });

  it.each([
    ['a channel member', 'alice', 'social:ch:general', () => member('social:ch:general', 'alice'), true],
    ['a non-member', 'carol', 'social:ch:general', () => member('social:ch:general', 'alice'), false],
    ['a removed member', 'alice', 'social:ch:general', () => member('social:ch:general', 'alice', null, T0), false],
    ['a DM id', 'alice', 'social:dm:alice:bob', undefined, true],
    ['a DM outsider', 'carol', 'social:dm:alice:bob', undefined, false],
    ['a room is the platform\'s visibility, not chat', 'carol', 'social:room:r1', undefined, true],
    ['a malformed team name', 'alice', 'social:team:x', undefined, false],
  ] as const)('social conversation: %s', async (_name, userId, channel, before, verdict) => {
    await before?.();
    expect(await admitSocialConversation(userId, channel, auth(userId, 'social'))).toBe(verdict);
  });
});

// ── Uploads: the history floor ───────────────────────────────────────────────

describe('admitUploadRead', () => {
  it.each([
    ['the uploader always reads their own file', 'bob', null, true],
    ['a member whose floor is older than the file reads it', 'alice', '2026-10-08T11:00:00.000Z', true],
    ['a member added after the file was shared never sees it', 'alice', '2026-10-08T13:00:00.000Z', false],
    ['a member with no floor reads it', 'alice', null, true],
  ] as const)('%s', async (_name, reader, historyFrom, verdict) => {
    await member('social:ch:general', 'alice', historyFrom); await member('social:ch:general', 'bob');
    expect(await admitUploadRead(upload('social:ch:general', 'bob', T0), ctx(reader, 'social'))).toBe(verdict);
  });
  it('a non-member cannot read a file shared in the channel', async () => {
    await member('social:ch:general', 'bob');
    expect(await admitUploadRead(upload('social:ch:general', 'bob', T0), ctx('carol', 'social'))).toBe(false);
  });
  it('a tenant thread file follows the family read, no floor', async () => {
    expect(await admitUploadRead(upload('orgiq:work:w1', 'bob', T0), ctx('alice', 'orgiq'))).toBe(true);
    expect(await admitUploadRead(upload('orgiq:work:w1', 'bob', T0), ctx('pat', 'pipelines'))).toBe(false);
  });
});

// ── Readers (receipts, unread items, mentions), principals, producers ───────

describe('admitReader / admitPrincipal / producerChannelAllowed / holdsFamilyAuthority', () => {
  it('a reader is asked by id: the family read over every granted role, the page, the rows', async () => {
    expect(await admitReader('alice', 'orgiq:work:w1')).toBe(true);
    expect(await admitReader('pat', 'orgiq:work:w1')).toBe(false);
    expect(await admitReader('ava', 'assessment:team:TEAM-1')).toBe(true);
    expect(await admitReader('ava', 'assessment:team:TEAM-9')).toBe(false);
    await member('orgiq:work:w1', 'bob');
    expect(await admitReader('alice', 'orgiq:work:w1')).toBe(false);
    users.get('ava')!.grants.assessment = [];
    expect(await admitReader('ava', 'assessment:team:TEAM-1')).toBe(false);
    expect(await admitReader('alice', 'orgiq:nope:1')).toBe(false);
  });

  it('an access request thread\'s reader (cursors, unread, mentions) is the request\'s read rule for that id, now', async () => {
    expect(await admitReader('rhea', 'access:req:req-0001')).toBe(true);
    expect(await admitReader('omar', 'access:req:req-0001')).toBe(true);
    expect(await admitReader('zed', 'access:req:req-0001')).toBe(false);
    expect(await admitReader('rhea', 'access:req:req-0004')).toBe(false);
    expect(await admitReader('alice', 'access:req:req-0001')).toBe(false);
    threadReaders.get('access:req:req-0001')!.delete('omar');
    expect(await admitReader('omar', 'access:req:req-0001')).toBe(false);
    users.get('rhea')!.grants.access = [];
    expect(await admitReader('rhea', 'access:req:req-0001')).toBe(false);
  });

  it('a principal is current until its epoch moves or its grant goes', async () => {
    const context = ctx('alice', 'orgiq');
    expect(await admitPrincipal(context)).toBe(true);
    expect(await admitPrincipal(null)).toBe(false);
    expect(await admitPrincipal(ctx('alice', 'orgiq', undefined, { sub: 'nobody' }))).toBe(false);
    users.get('alice')!.epoch = 1;
    expect(await admitPrincipal(context)).toBe(false);
  });

  it('a producer only leaves onto a family name', () => {
    expect(producerChannelAllowed('pipelines:run:r1')).toBe(true);
    expect(producerChannelAllowed('orgiq:initiative:p-1')).toBe(true);
    expect(producerChannelAllowed('pipelines:nope')).toBe(false);
    expect(producerChannelAllowed('orgiq:huddle:c1')).toBe(false);
    expect(producerChannelAllowed('social:ch:general')).toBe(false);
  });

  it('a session holds a family authority exactly as its REST route would decide', async () => {
    expect(await holdsFamilyAuthority(session('ava', 'assessment'), 'assessment:team:TEAM-1', 'subscribe')).toBe(true);
    expect(await holdsFamilyAuthority(session('ava', 'assessment'), 'assessment:team:TEAM-1', 'publish')).toBe(true);
    expect(await holdsFamilyAuthority(session('ava', 'orgiq'), 'assessment:team:TEAM-1', 'subscribe')).toBe(false);
    expect(await holdsFamilyAuthority(session('alice', 'orgiq'), 'orgiq:initiative:p-1', 'publish')).toBe(false);
    expect(await holdsFamilyAuthority(session('sam', 'orgiq'), 'orgiq:initiative:p-1', 'publish')).toBe(true);
    expect(await holdsFamilyAuthority(session('alice', 'orgiq'), 'orgiq:nope:1', 'subscribe')).toBe(false);
  });
});
