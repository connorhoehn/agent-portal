// Read cursors + unread on the page discussions (lib/page-thread-unread.ts,
// realtime-modules 0.115 `cursorMode: 'readers'`), through the real gateway:
// an http.Server, attachRealtimeGateway, real realtime tokens and raw `ws`
// clients, so every frame passes the router's per-request authorize.
//
//   - a reader gets a cursor and receipts (no member list is ever written);
//   - an outsider (no grant, or a policy that denies the read) is refused and
//     stores nothing;
//   - a revocation mid-session fences: the revoked reader's `read` is refused,
//     other readers' receipts no longer reach them, and their stored cursor
//     drops out of every listing;
//   - cross-tenant: a session parked in another tenant, and a page whose
//     resource row is gone, are refused like an unknown channel;
//   - unread: a message gives an earlier reader who is not watching ONE "new
//     messages" item, the REST count is recomputed server-side, reading clears
//     both, and a revoked reader gets neither.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { attachRealtimeGateway } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, type SocialChatBackend } from '../social-chat.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import { unreadThreadsFor, DISCUSSION_UNREAD_KIND } from '../page-thread-unread.js';
import type { Session } from '../session.js';

type Frame = Record<string, unknown>;
type Client = { ws: WebSocket; frames: Frame[] };
type Inbox = { listForUser(userId: string): Promise<Array<{ id: string; read?: boolean; payload?: Record<string, unknown> }>> };
const SECRET = 'page-cursor-gateway-contract';
const TEAM = 'assessment:team:TEAM-005';
let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>, backend: SocialChatBackend;
let users: Map<string, UserInfo>, clients: Client[], deniedActions: Set<string>, existing: Set<string>;
let previousSecret: string | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const start = Date.now();
  while (!(await check())) { if (Date.now() - start > ms) throw new Error('Gateway receipt timed out'); await pause(10); }
}
const send = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const denied = (client: Client) => client.frames.filter(frame => frame.type === 'error');
const of = (client: Client, action: string, channel = TEAM) => client.frames.filter(f => f.type === 'chat' && f.action === action && f.channel === channel);
async function dispatched(client: Client, frame: Frame) {
  const service = handle.services[String(frame.service)];
  const original = service.handleAction.bind(service);
  let complete!: () => void; const receipt = new Promise<void>(resolve => { complete = resolve; });
  const action = jest.spyOn(service, 'handleAction').mockImplementationOnce(async (...args) => {
    try { await original(...args); } finally { complete(); }
  });
  try { send(client, frame); await receipt; } finally { action.mockRestore(); }
}
const ROLES: Record<string, string> = { assessment: 'assessor', orgiq: 'member', pipelines: 'operator' };
const session = (sub: string, tenant = 'assessment'): Session => ({ sub, name: sub, tenant: tenant as Session['tenant'],
  role: (users.get(sub)?.grants[tenant]?.[0] ?? ROLES[tenant]) as Session['role'], epoch: users.get(sub)?.epoch ?? 0,
  grants: structuredClone(users.get(sub)?.grants ?? {}), iat: Math.floor(Date.now() / 1000) });
async function connect(sub: string, tenant = 'assessment'): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(session(sub, tenant)), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]), frames: [] as Frame[] };
  clients.push(client);
  client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  return client;
}
async function join(client: Client, channel = TEAM) {
  send(client, { service: 'chat', action: 'join', channel });
  await until(() => client.frames.some(frame => frame.type === 'chat' && frame.action === 'joined' && frame.channel === channel));
}
async function post(client: Client, text: string, channel = TEAM) {
  const before = client.frames.filter(frame => frame.action === 'sent').length;
  send(client, { service: 'chat', action: 'send', channel, message: text });
  await until(() => client.frames.filter(frame => frame.action === 'sent').length > before);
}
const read = (client: Client, channel = TEAM) => dispatched(client, { service: 'chat', action: 'read', channel });
async function receipts(client: Client, channel = TEAM): Promise<Frame> {
  const before = of(client, 'receipts', channel).length;
  await dispatched(client, { service: 'chat', action: 'receipts', channel });
  await until(() => of(client, 'receipts', channel).length > before || denied(client).length > 0);
  return of(client, 'receipts', channel).at(-1) ?? {};
}
const cursorOf = async (userId: string, channel = TEAM) => (await backend.readReceiptStore.listReceipts(channel)).find(r => r.userId === userId)?.readAt ?? null;
const inbox = () => handle.services['notification'] as unknown as Inbox;
const unreadItems = async (userId: string) => (await inbox().listForUser(userId)).filter(n => n.payload?.['kind'] === DISCUSSION_UNREAD_KIND);

beforeEach(async () => {
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  clients = []; deniedActions = new Set(); existing = new Set([TEAM, 'orgiq:initiative:p-rag-search', 'pipelines:run:run-1']);
  const u = (id: string, grants: Record<string, string[]>): [string, UserInfo] => [id, { id, displayName: `${id} Directory`, epoch: 0, email: null, personId: null, grants }];
  users = new Map([
    u('asha', { assessment: ['assessor'] }), u('jonas', { assessment: ['lead-assessor'] }),
    u('olaf', { orgiq: ['member'] }), u('mia', { orgiq: ['member'], assessment: ['assessor'] }),
    u('ola', { orgiq: ['member'] }), u('sam', { orgiq: ['sme'] }), u('kofi', { pipelines: ['operator'] }), u('ines', { pipelines: ['author'] }),
  ]);
  jest.mocked(getUser).mockImplementation(async id => (users.has(id) ? structuredClone(users.get(id)!) : null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()].map(x => structuredClone(x)));
  // The tenants' read/write actions, as the seed policies grant them; `deniedActions` revokes one.
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => {
    if (deniedActions.has(action)) return false;
    if (action === 'ViewAssessment') return principal.tenant === 'assessment';
    if (action === 'ViewPipelines') return principal.tenant === 'pipelines';
    if (action === 'DispatchAgentRun') return principal.tenant === 'orgiq' && principal.role === 'sme';
    return false;
  });
  jest.mocked(pageResourceVisible).mockImplementation(async (_kind, bare) => existing.has(bare));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  backend = createMemorySocialChatBackend({ fixtures: false });
  server = http.createServer(); handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
  jest.restoreAllMocks();
});

it('gives a reader a cursor and receipts on an open team discussion, with no member list', async () => {
  const asha = await connect('asha'), jonas = await connect('jonas');
  await join(asha); await join(jonas);
  await post(jonas, 'Before Asha reads');
  expect(await receipts(asha)).toMatchObject({ enabled: true, mode: 'readers', receipts: [] });
  await read(asha);
  await until(() => of(jonas, 'readReceipt').some(f => f.userId === 'asha'));
  await until(() => of(asha, 'readReceipt').some(f => f.userId === 'asha')); // her other tabs hear the accepted value
  expect(await cursorOf('asha')).toEqual(expect.any(String));
  expect((await receipts(jonas)).receipts).toEqual([expect.objectContaining({ userId: 'asha' })]);
  // No roster was invented: the channel is still open.
  expect(await backend.membershipStore.listMembers(TEAM)).toEqual([]);
  expect(denied(asha)).toEqual([]); expect(denied(jonas)).toEqual([]);
});

it.each([
  ['an initiative discussion', 'orgiq:initiative:p-rag-search', 'ola', 'sam', 'orgiq'],
  ['a pipelines run thread', 'pipelines:run:run-1', 'kofi', 'ines', 'pipelines'],
])('keeps reader cursors on %s too', async (_label, channel, readerId, posterId, tenant) => {
  const reader = await connect(readerId, tenant), poster = await connect(posterId, tenant);
  await join(reader, channel); await join(poster, channel);
  await post(poster, 'New on the page', channel);
  expect(await receipts(reader, channel)).toMatchObject({ enabled: true, mode: 'readers' });
  await read(reader, channel); // ola holds no DispatchAgentRun: a cursor is reader state, not content
  await until(() => of(poster, 'readReceipt', channel).some(f => f.userId === readerId));
  expect(await cursorOf(readerId, channel)).toEqual(expect.any(String));
});

it('refuses an outsider: no grant, or a policy that denies the read, stores nothing', async () => {
  const olaf = await connect('olaf', 'orgiq');
  await read(olaf); await receipts(olaf);
  await until(() => denied(olaf).filter(f => f.code === 'AUTHZ_CHANNEL_DENIED').length >= 2);
  expect(of(olaf, 'receipts')).toEqual([]);
  expect(await cursorOf('olaf')).toBeNull();
  const asha = await connect('asha'); deniedActions.add('ViewAssessment');
  await read(asha);
  await until(() => denied(asha).some(f => f.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await cursorOf('asha')).toBeNull();
});

it.each(['grant', 'epoch'])('fences a reader revoked mid-session (%s): refused writes, no receipts, no listing', async reason => {
  const asha = await connect('asha'), jonas = await connect('jonas');
  await join(asha); await join(jonas);
  await post(jonas, 'First'); await read(asha);
  const before = await cursorOf('asha');
  expect(before).toEqual(expect.any(String));
  if (reason === 'grant') users.get('asha')!.grants.assessment = []; else users.get('asha')!.epoch++;
  await pause(5); await post(jonas, 'After revocation');
  await read(asha);
  await until(() => denied(asha).some(f => f.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await cursorOf('asha')).toBe(before);
  const heard = asha.frames.length;
  await read(jonas);
  await until(() => of(jonas, 'readReceipt').some(f => f.userId === 'jonas'));
  await pause(50);
  expect(asha.frames.slice(heard).filter(f => f.action === 'readReceipt' || f.action === 'message')).toEqual([]);
  if (reason === 'grant') {
    // Her stored cursor stays in the store but is never reported to anyone.
    expect((await receipts(jonas)).receipts).toEqual([expect.objectContaining({ userId: 'jonas' })]);
  }
});

it('is cross-tenant tight: another active tenant, or a page whose row is gone, is refused', async () => {
  const mia = await connect('mia', 'orgiq'); // holds an assessment grant, but this session is parked in orgiq
  await read(mia); await receipts(mia);
  await until(() => denied(mia).filter(f => f.code === 'AUTHZ_CHANNEL_DENIED').length >= 2);
  expect(await cursorOf('mia')).toBeNull();
  const asha = await connect('asha'); existing.delete(TEAM);
  await read(asha);
  await until(() => denied(asha).some(f => f.code === 'AUTHZ_CHANNEL_DENIED'));
  expect(await cursorOf('asha')).toBeNull();
  // Another tenant's pages never reach this one's unread list.
  existing.add(TEAM);
  expect(await unreadThreadsFor(session('mia', 'orgiq'))).toEqual([]);
});

it('gives an earlier reader one "new messages" item, counts server-side, and clears on read', async () => {
  const jonas = await connect('jonas');
  let asha = await connect('asha');
  await join(asha); await join(jonas);
  await post(jonas, 'Seen'); await read(asha);
  asha.ws.terminate(); await pause(30); // she leaves: not watching the thread any more
  await post(jonas, 'First unseen'); await post(jonas, 'Second unseen');
  await until(async () => (await unreadItems('asha')).length === 1);
  await pause(50);
  const [item] = await unreadItems('asha');
  expect(item?.read).toBeFalsy();
  expect(item).toMatchObject({ payload: expect.objectContaining({ tenant: 'assessment', channel: TEAM, actorId: 'jonas' }) });
  expect(await unreadItems('jonas')).toEqual([]); // never the sender
  expect(await unreadThreadsFor(session('asha'))).toEqual([expect.objectContaining({
    channel: TEAM, unreadCount: 2, section: '/assessment/teams', href: '/assessment/teams/TEAM-005?tab=discussion',
  })]);
  asha = await connect('asha'); await join(asha); await read(asha);
  await until(async () => (await unreadItems('asha')).every(n => n.read));
  expect(await unreadThreadsFor(session('asha'))).toEqual([]);
});

it('gives a revoked reader no item and no count', async () => {
  const jonas = await connect('jonas'), asha = await connect('asha');
  await join(asha); await join(jonas);
  await post(jonas, 'Seen'); await read(asha);
  asha.ws.terminate(); await pause(30);
  users.get('asha')!.grants.assessment = [];
  await post(jonas, 'Unseen after revocation'); await pause(100);
  expect(await unreadItems('asha')).toEqual([]);
  users.get('asha')!.grants.assessment = ['assessor'];
  await post(jonas, 'Unseen, restored'); // her item now names the thread
  await until(async () => (await unreadItems('asha')).length === 1);
  deniedActions.add('ViewAssessment'); // the page's read policy, revoked: the REST count re-asks it
  expect(await unreadThreadsFor(session('asha'))).toEqual([]);
});
