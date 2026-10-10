// OrgIQ page lobbies (platform-api lobby-authority lane, 2026-10-06): the
// footer's Huddle on an initiative page starts a call in `orgiq:initiative:<id>`.
// Until this contract the gateway admitted ANY `orgiq:initiative:<id>` to any
// orgiq session — the family asked the REST read's tenant gate but never the
// initiative itself, unlike `assessment:team:<id>` / `pipelines:run:<id>`.
// These run through a real router with the real page-resource check
// (lib/page-resources.ts → providers/projects.ts `projectExists`, mocked here
// as the provider's existence answer): the lobby is admitted only to the same
// fresh, per-request authority GET /api/graph/projects/:id asks (active tenant
// orgiq — every orgiq role holds that read, there is no narrower tier — plus
// the initiative existing now). Work items (`orgiq:work:<id>`) and anything
// else under `orgiq:` are not call lobbies at all; `orgiq:dm:<ids>` admits only
// the named ids. A revocation or a deleted initiative mid-call fences delivery.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ projectExists: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { projectExists } from '../../providers/projects.js';
import { pageResourceVisible } from '../page-resources.js';
import { attachRealtimeGateway, lobbyGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../social-chat.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import type { Session } from '../session.js';

type Frame = Record<string, unknown>;
type Client = { ws: WebSocket; frames: Frame[] };
const SECRET = 'initiative-huddle-gateway-contract';
const INITIATIVE = 'orgiq:initiative:p-auth-migration';
const OTHER = 'orgiq:initiative:p-rag-search';

let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>;
let users: Map<string, UserInfo>, clients: Client[], projects: Set<string>;
let previousSecret: string | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 4000) throw new Error('Gateway receipt timed out'); await pause(10); }
}
const send = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const callErrors = (client: Client) => client.frames.filter(frame => frame.type === 'error' && frame.service === 'call');
const callFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'call' && frame.action === action);
async function dispatched(client: Client, frame: Frame) {
  const service = handle.services['call'];
  const original = service.handleAction.bind(service);
  let complete!: () => void; const receipt = new Promise<void>(resolve => { complete = resolve; });
  const action = jest.spyOn(service, 'handleAction').mockImplementationOnce(async (...args) => {
    try { await original(...args); } finally { complete(); }
  });
  try { send(client, frame); await receipt; await pause(40); } finally { action.mockRestore(); }
}

const session = (sub: string, tenant: string, role: string, grants: Record<string, string[]>): Session =>
  ({ sub, name: sub, role, tenant, epoch: 0, grants, iat: Math.floor(Date.now() / 1000) }) as unknown as Session;
const member = (sub: string) => session(sub, 'orgiq', 'member', { orgiq: ['member'] });

async function connect(s: Session): Promise<Client> {
  const signed = await signRealtimeToken(realtimeClaims(s), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', signed.token]), frames: [] as Frame[] };
  clients.push(client);
  client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  return client;
}
const invite = (callId: string, lobbyName: string, callerId: string, targets: string[]) =>
  ({ service: 'call', action: 'invite', callId, lobbyName, callerId, callerName: callerId, targetUserIds: targets });
const accepted = (callId: string, userId: string, callerId: string) =>
  ({ service: 'call', action: 'accepted', callId, callerId: userId, userId, displayName: userId, targetUserIds: [callerId] });
const participantState = (callId: string, userId: string, targets: string[], extra: Frame = {}) =>
  ({ service: 'call', action: 'participant-state', callId, userId, callerId: userId, participantId: `${userId}-p`, targetUserIds: targets, ...extra });

beforeEach(async () => {
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  clients = []; projects = new Set(['p-auth-migration', 'p-rag-search']);
  const directory: Array<[string, Record<string, string[]>]> = [
    ['olu', { orgiq: ['member'] }], ['oma', { orgiq: ['member'] }],
    // Holds an orgiq grant but stands in social: GET /api/graph/projects/:id (requireTenant('orgiq')) refuses him.
    ['sol', { orgiq: ['member'], social: ['participant'] }],
    ['ana', { assessment: ['assessor'] }],
  ];
  users = new Map(directory.map(([id, grants]) => [id, { id, displayName: id, epoch: 0, email: null, personId: null, grants }]));
  jest.mocked(getUser).mockImplementation(async id => (users.has(id) ? structuredClone(users.get(id)!) : null));
  jest.mocked(isAllowed).mockResolvedValue(true);
  jest.mocked(projectExists).mockImplementation(async id => projects.has(id));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  server = http.createServer();
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: createMemorySocialChatBackend({ fixtures: false }), statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
  jest.restoreAllMocks();
});

describe('the initiative resource check (lib/page-resources.ts)', () => {
  it('asks the provider for the id now and refuses unknown, malformed and failing reads', async () => {
    await expect(pageResourceVisible('orgiq-initiative', INITIATIVE)).resolves.toBe(true);
    expect(projectExists).toHaveBeenLastCalledWith('p-auth-migration');
    await expect(pageResourceVisible('orgiq-initiative', 'orgiq:initiative:p-missing')).resolves.toBe(false);
    await expect(pageResourceVisible('orgiq-initiative', 'orgiq:initiative:')).resolves.toBe(false);
    await expect(pageResourceVisible('orgiq-initiative', 'orgiq:work:p-auth-migration')).resolves.toBe(false);
    jest.mocked(projectExists).mockRejectedValueOnce(new Error('Data API down'));
    await expect(pageResourceVisible('orgiq-initiative', INITIATIVE)).resolves.toBe(false);
  });
});

describe('shape (synchronous guards)', () => {
  const olu = { userId: 'olu', org: 'orgiq', tenants: ['orgiq'] };
  it('keeps work items, sessions and other orgiq names out of the lobby families, and DMs to their named ids', () => {
    expect(lobbyGuard(olu, INITIATIVE)).toBe(true);
    for (const name of ['orgiq:work:wi-1', 'orgiq:session:s-1', 'orgiq:invoke', 'orgiq:deck:d-1', 'orgiq:workgraph',
      'orgiq:initiative:', 'orgiq:initiatives:p-1', 'orgiq:huddle:c1', 'orgiq:dm:oma:sol']) {
      expect(lobbyGuard(olu, name)).toBe(false);
    }
    expect(lobbyGuard(olu, 'orgiq:dm:olu:oma')).toBe(true);
    expect(lobbyGuard({ userId: 'ana', org: 'assessment', tenants: ['assessment'] }, INITIATIVE)).toBe(false);
  });
});

describe('refusals through a real router', () => {
  it('refuses an unknown initiative and a forged id, and never rings', async () => {
    const olu = await connect(member('olu')), oma = await connect(member('oma'));
    await dispatched(olu, invite('unknown', 'orgiq:initiative:p-does-not-exist', 'olu', ['oma']));
    expect(callErrors(olu)).toHaveLength(1);
    for (const forged of ['orgiq:initiative:p-auth-migration/../p-soc2', 'orgiq:initiative:%70-auth-migration', 'orgiq:initiative:P-AUTH-MIGRATION']) {
      await dispatched(olu, invite(`forged-${forged.length}`, forged, 'olu', ['oma']));
    }
    expect(callErrors(olu)).toHaveLength(4);
    await dispatched(olu, { service: 'call', action: 'status', lobbyName: 'orgiq:initiative:p-does-not-exist' });
    expect(callErrors(olu)).toHaveLength(5);
    expect(callFrames(oma, 'invite')).toEqual([]);
  });

  it('refuses an orgiq grant holder standing outside orgiq (the REST read tier) and a cross-tenant caller', async () => {
    const oma = await connect(member('oma'));
    for (const outsider of [session('sol', 'social', 'participant', { orgiq: ['member'], social: ['participant'] }),
      session('ana', 'assessment', 'assessor', { assessment: ['assessor'] })]) {
      const client = await connect(outsider);
      await dispatched(client, invite(`x-${outsider.sub}`, INITIATIVE, outsider.sub, ['oma']));
      expect(callErrors(client).length).toBeGreaterThan(0);
    }
    expect(callFrames(oma, 'invite')).toEqual([]);
  });

  it('refuses a work-item lobby and a DM lobby that does not name the caller, existing work or not', async () => {
    const olu = await connect(member('olu')), oma = await connect(member('oma'));
    await dispatched(olu, invite('work', 'orgiq:work:wi-auth-1', 'olu', ['oma']));
    await dispatched(olu, invite('dm', 'orgiq:dm:oma:sol', 'olu', ['oma']));
    expect(callErrors(olu)).toHaveLength(2);
    expect(callFrames(oma, 'invite')).toEqual([]);
  });

  it('refuses a frame renaming a stored initiative call into another initiative', async () => {
    const olu = await connect(member('olu')), oma = await connect(member('oma'));
    await dispatched(olu, invite('stored', OTHER, 'olu', ['oma']));
    await until(() => callFrames(oma, 'invite').length === 1);
    await dispatched(oma, participantState('stored', 'oma', ['olu'], { lobbyName: INITIATIVE }));
    expect(callErrors(oma)).toHaveLength(1);
    expect(callFrames(olu, 'participant-state')).toEqual([]);
  });
});

describe('revocation mid-call', () => {
  async function liveCall() {
    const olu = await connect(member('olu')), oma = await connect(member('oma'));
    await dispatched(olu, invite('live', INITIATIVE, 'olu', ['oma']));
    await until(() => callFrames(oma, 'invite').length === 1);
    await dispatched(oma, accepted('live', 'oma', 'olu'));
    await until(() => callFrames(olu, 'accepted').length === 1);
    await dispatched(olu, participantState('live', 'olu', ['oma']));
    await until(() => callFrames(oma, 'participant-state').length === 1);
    return { olu, oma };
  }

  it.each(['grant', 'epoch', 'initiative-deleted'])('fences delivery after %s revocation', async reason => {
    const { olu, oma } = await liveCall();
    if (reason === 'grant') users.get('oma')!.grants = {};
    if (reason === 'epoch') users.get('oma')!.epoch++;
    if (reason === 'initiative-deleted') projects.delete('p-auth-migration');
    await dispatched(olu, participantState('live', 'olu', ['oma'], { participantId: 'after' }));
    await pause(50);
    expect(callFrames(oma, 'participant-state')).toHaveLength(1);
    await dispatched(oma, participantState('live', 'oma', ['olu']));
    expect(callErrors(oma).length).toBeGreaterThan(0);
  });
});

describe('admit path', () => {
  it('rings and connects two current readers of an existing initiative, asking the initiative each time', async () => {
    const olu = await connect(member('olu')), oma = await connect(member('oma'));
    await dispatched(olu, invite('init-call', INITIATIVE, 'olu', ['oma']));
    await until(() => callFrames(oma, 'invite').length === 1);
    expect(callFrames(oma, 'invite')[0]!.data).toMatchObject({ lobbyName: INITIATIVE });
    await dispatched(oma, accepted('init-call', 'oma', 'olu'));
    await until(() => callFrames(olu, 'accepted').length === 1);
    expect(callErrors(olu)).toEqual([]); expect(callErrors(oma)).toEqual([]);
    expect(jest.mocked(projectExists).mock.calls.filter(([id]) => id === 'p-auth-migration').length).toBeGreaterThanOrEqual(2);
  });
});
