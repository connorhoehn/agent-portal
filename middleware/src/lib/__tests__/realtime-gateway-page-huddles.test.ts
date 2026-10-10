// Page huddles (realtime-parity gap 3): the footer's Huddle on an assessment
// team page (`assessment:team:<id>`) and a pipelines run page
// (`pipelines:run:<id>`) starts a call in that page's lobby. These contracts
// run through a real router: the lobby is admitted only to the same fresh,
// per-request authority the page's REST read asks (active tenant + the
// family's Cedar action + the resource existing now), refused to outsiders,
// cross-tenant and forged frames, and a revocation mid-call fences delivery.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { attachRealtimeGateway, channelGuard, lobbyGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend } from '../social-chat.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import type { Session } from '../session.js';

type Frame = Record<string, unknown>;
type Client = { ws: WebSocket; frames: Frame[] };
const SECRET = 'page-huddle-gateway-contract';
const TEAM = 'assessment:team:TEAM-005';
const OTHER_TEAM = 'assessment:team:TEAM-001';
const RUN = 'pipelines:run:run-42';
const READ: Record<string, string> = { assessment: 'ViewAssessment', pipelines: 'ViewPipelines', orgiq: 'ViewOrg' };

let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>;
let users: Map<string, UserInfo>, clients: Client[], deniedActions: Set<string>, resources: Set<string>;
let previousSecret: string | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 4000) throw new Error('Gateway receipt timed out'); await pause(10); }
}
const send = (client: Client, frame: Frame) => client.ws.send(JSON.stringify(frame));
const callErrors = (client: Client) => client.frames.filter(frame => frame.type === 'error' && frame.service === 'call');
const channelDenials = (client: Client) => client.frames.filter(frame => frame.type === 'error' && frame.code === 'AUTHZ_CHANNEL_DENIED');
const callFrames = (client: Client, action: string) => client.frames.filter(frame => frame.type === 'call' && frame.action === action);
/** Wait until the call service has finished one action (admitted or refused). */
async function dispatched(client: Client, frame: Frame) {
  const service = handle.services['call'];
  const original = service.handleAction.bind(service);
  let complete!: () => void; const receipt = new Promise<void>(resolve => { complete = resolve; });
  const action = jest.spyOn(service, 'handleAction').mockImplementationOnce(async (...args) => {
    try { await original(...args); } finally { complete(); }
  });
  // The call service authorizes inside handleAction and answers a refusal
  // with `{ type: 'error', service: 'call' }` just after it returns.
  try { send(client, frame); await receipt; await pause(40); } finally { action.mockRestore(); }
}

const session = (sub: string, tenant: string, role: string, grants: Record<string, string[]>): Session =>
  ({ sub, name: sub, role, tenant, epoch: 0, grants, iat: Math.floor(Date.now() / 1000) }) as unknown as Session;
const assessor = (sub: string) => session(sub, 'assessment', 'assessor', { assessment: ['assessor'] });
const operator = (sub: string) => session(sub, 'pipelines', 'operator', { pipelines: ['operator'] });

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
  clients = []; deniedActions = new Set(); resources = new Set([TEAM, OTHER_TEAM, RUN]);
  const directory: Array<[string, Record<string, string[]>]> = [
    ['ana', { assessment: ['assessor'] }], ['bea', { assessment: ['assessor'] }],
    ['pia', { pipelines: ['operator'] }], ['pete', { pipelines: ['operator'] }],
    // Holds an assessment grant but stands in orgiq: the REST read (requireTenant) refuses her.
    ['olly', { orgiq: ['member'], assessment: ['assessor'] }],
    ['oz', { orgiq: ['member'] }],
  ];
  users = new Map(directory.map(([id, grants]) => [id, { id, displayName: id, epoch: 0, email: null, personId: null, grants }]));
  jest.mocked(getUser).mockImplementation(async id => (users.has(id) ? structuredClone(users.get(id)!) : null));
  jest.mocked(isAllowed).mockImplementation(async (principal, action) =>
    READ[principal.tenant] === action && !deniedActions.has(`${principal.sub}:${action}`));
  jest.mocked(pageResourceVisible).mockImplementation(async (_kind, bare) => resources.has(bare));
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

describe('shape (synchronous guards)', () => {
  const ana = { userId: 'ana', org: 'assessment', tenants: ['assessment'] };
  const pia = { userId: 'pia', org: 'pipelines', tenants: ['pipelines'] };
  it('admits the page lobby families to grant holders of their partition only', () => {
    expect(lobbyGuard(ana, TEAM)).toBe(true);
    expect(lobbyGuard(pia, RUN)).toBe(true);
    expect(lobbyGuard(pia, TEAM)).toBe(false);
    expect(lobbyGuard(ana, RUN)).toBe(false);
    expect(lobbyGuard({ userId: 'oz', org: 'orgiq', tenants: ['orgiq'] }, TEAM)).toBe(false);
  });
  it('refuses malformed team ids, sibling names and the call-chat seat namespace', () => {
    for (const name of ['assessment:team:', 'assessment:team:../TEAM-1', 'assessment:team:TEAM-1:x', 'assessment:team:team-1',
      'assessment:teams:TEAM-1', 'pipelines:run:', 'orgiq:huddle:c1', 'assessment:huddle:c1']) {
      expect(lobbyGuard(name.startsWith('pipelines') ? pia : ana, name)).toBe(false);
    }
    // The team discussion is a chat family; a pipelines:def stays a non-lobby.
    expect(channelGuard(ana, TEAM, 'publish')).toBe(true);
    expect(lobbyGuard(pia, 'pipelines:def:d-1')).toBe(false);
  });
});

describe('refusals through a real router', () => {
  it('refuses a cross-tenant caller and a grant holder standing in another tenant, and never rings', async () => {
    const ana = await connect(assessor('ana'));
    for (const outsider of [session('oz', 'orgiq', 'member', { orgiq: ['member'] }), session('olly', 'orgiq', 'member', { orgiq: ['member'], assessment: ['assessor'] })]) {
      const client = await connect(outsider);
      await dispatched(client, invite(`x-${outsider.sub}`, TEAM, outsider.sub, ['ana']));
      expect(callErrors(client).length).toBeGreaterThan(0);
      await dispatched(client, { service: 'call', action: 'status', lobbyName: TEAM });
      expect(callErrors(client).length).toBeGreaterThan(1);
    }
    expect(callFrames(ana, 'invite')).toEqual([]);
  });

  it('refuses a reader without the page read action, an unknown team and an unknown run', async () => {
    const ana = await connect(assessor('ana')), bea = await connect(assessor('bea'));
    deniedActions.add('ana:ViewAssessment');
    await dispatched(ana, invite('no-read', TEAM, 'ana', ['bea']));
    expect(callErrors(ana).length).toBe(1);
    deniedActions.clear(); resources.delete(TEAM);
    await dispatched(ana, invite('gone-team', TEAM, 'ana', ['bea']));
    expect(callErrors(ana).length).toBe(2);
    const pia = await connect(operator('pia')), pete = await connect(operator('pete'));
    await dispatched(pia, invite('gone-run', 'pipelines:run:missing', 'pia', ['pete']));
    expect(callErrors(pia).length).toBe(1);
    expect(callFrames(bea, 'invite')).toEqual([]);
    expect(callFrames(pete, 'invite')).toEqual([]);
  });

  it('refuses forged context: another caller id, and a frame renaming a stored call into another lobby', async () => {
    const ana = await connect(assessor('ana')), bea = await connect(assessor('bea'));
    await dispatched(ana, invite('forged-caller', TEAM, 'bea', ['bea']));
    expect(callErrors(ana).length).toBe(1);
    await dispatched(ana, invite('stored', OTHER_TEAM, 'ana', ['bea']));
    await until(() => callFrames(bea, 'invite').length === 1);
    await dispatched(bea, participantState('stored', 'bea', ['ana'], { lobbyName: TEAM }));
    expect(callErrors(bea).length).toBe(1);
    expect(callFrames(ana, 'participant-state')).toEqual([]);
  });

  it('refuses a team discussion subscribe to an outsider and for an unknown team with AUTHZ_CHANNEL_DENIED', async () => {
    const oz = await connect(session('oz', 'orgiq', 'member', { orgiq: ['member'] }));
    send(oz, { service: 'chat', action: 'join', channel: TEAM });
    await until(() => channelDenials(oz).length > 0);
    const ana = await connect(assessor('ana'));
    resources.delete(TEAM);
    send(ana, { service: 'chat', action: 'join', channel: TEAM });
    await until(() => channelDenials(ana).length > 0);
    resources.add(TEAM);
    send(ana, { service: 'chat', action: 'join', channel: TEAM });
    await until(() => ana.frames.some(frame => frame.type === 'chat' && frame.action === 'joined' && frame.channel === TEAM));
  });
});

describe('revocation mid-call', () => {
  async function liveTeamCall() {
    const ana = await connect(assessor('ana')), bea = await connect(assessor('bea'));
    await dispatched(ana, invite('live', TEAM, 'ana', ['bea']));
    await until(() => callFrames(bea, 'invite').length === 1);
    await dispatched(bea, accepted('live', 'bea', 'ana'));
    await until(() => callFrames(ana, 'accepted').length === 1);
    await dispatched(ana, participantState('live', 'ana', ['bea']));
    await until(() => callFrames(bea, 'participant-state').length === 1);
    return { ana, bea };
  }

  it.each(['grant', 'policy', 'epoch', 'team-deleted'])('fences delivery after %s revocation', async reason => {
    const { ana, bea } = await liveTeamCall();
    if (reason === 'grant') users.get('bea')!.grants = {};
    if (reason === 'policy') deniedActions.add('bea:ViewAssessment');
    if (reason === 'epoch') users.get('bea')!.epoch++;
    if (reason === 'team-deleted') resources.delete(TEAM);
    await dispatched(ana, participantState('live', 'ana', ['bea'], { participantId: 'after' }));
    await pause(50);
    expect(callFrames(bea, 'participant-state')).toHaveLength(1);
    // The revoked side cannot act in the call either.
    await dispatched(bea, participantState('live', 'bea', ['ana']));
    expect(callErrors(bea).length).toBeGreaterThan(0);
  });
});

describe('admit path', () => {
  it('rings and connects two current readers of a team page and of a run page', async () => {
    const ana = await connect(assessor('ana')), bea = await connect(assessor('bea'));
    await dispatched(ana, invite('team-call', TEAM, 'ana', ['bea']));
    await until(() => callFrames(bea, 'invite').length === 1);
    expect(callFrames(bea, 'invite')[0]!.data).toMatchObject({ lobbyName: TEAM });
    const pia = await connect(operator('pia')), pete = await connect(operator('pete'));
    await dispatched(pia, invite('run-call', RUN, 'pia', ['pete']));
    await until(() => callFrames(pete, 'invite').length === 1);
    await dispatched(pete, accepted('run-call', 'pete', 'pia'));
    await until(() => callFrames(pia, 'accepted').length === 1);
    expect(callErrors(ana)).toEqual([]); expect(callErrors(pia)).toEqual([]);
    expect(pageResourceVisible).toHaveBeenCalledWith('assessment-team', TEAM);
    expect(pageResourceVisible).toHaveBeenCalledWith('pipelines-run', RUN);
  });
});
