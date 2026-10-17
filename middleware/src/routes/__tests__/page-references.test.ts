// Assessment dimension page references: a team discussion stores only
// `{kind:'assessment-dimension', id:'<TEAM-id>:<dimensionId>'}`, and
// GET /api/page-references/resolve answers each READER from their own current
// assessment authority — `unavailable` (never a 403) when they cannot see it.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
jest.mock('../../providers/assessment.js', () => ({ getTeamDetail: jest.fn() }));
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import type { RealtimeHandle } from '@connorhoehn/realtime-modules/server';
import { pageReferencesRouter } from '../page-references.js';
import { attachRealtimeGateway } from '../../lib/realtime-gateway.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getTeamDetail } from '../../providers/assessment.js';
import { isAllowed } from '../../lib/authz.js';
import { pageResourceVisible } from '../../lib/page-resources.js';
import { signRealtimeToken, realtimeClaims } from '../../lib/realtime-token.js';
import { createMemorySocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';
import type { Session } from '../../lib/session.js';
import request from '../../test-support/http.js';

const SECRET = 'assessment-page-reference-test-only';
const TEAM = 'TEAM-005', CHANNEL = `assessment:team:${TEAM}`;
const REF = { kind: 'assessment-dimension', id: `${TEAM}:7` };
const DETAIL = { team: { id: TEAM, name: 'Private Team Five' }, dimensions: [{ id: '7', title: 'Testing' }, { id: '8', title: 'Release' }] };
const SESSIONS: Record<string, Session> = {
  ana: { sub: 'ana', name: 'ana', tenant: 'assessment', role: 'assessor', epoch: 0, iat: 100, grants: { assessment: ['assessor'] } },
  bea: { sub: 'bea', name: 'bea', tenant: 'assessment', role: 'assessor', epoch: 0, iat: 100, grants: { assessment: ['assessor'] } },
  oz: { sub: 'oz', name: 'oz', tenant: 'orgiq', role: 'member', epoch: 0, iat: 100, grants: { orgiq: ['member'] } },
  // Holds an assessment grant but stands in orgiq: assessment reads require the active tenant.
  olly: { sub: 'olly', name: 'olly', tenant: 'orgiq', role: 'member', epoch: 0, iat: 100, grants: { orgiq: ['member'], assessment: ['assessor'] } },
} as unknown as Record<string, Session>;
type Frame = Record<string, any>;
type Client = { ws: WebSocket; frames: Frame[] };
let users: Map<string, UserInfo>, backend: SocialChatBackend, app: express.Express;
let server: http.Server, handle: RealtimeHandle, port: number, clients: Client[];
let previousSecret: string | undefined, denied: Set<string>;
async function until(check: () => boolean) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > 3000) throw new Error('Timed out waiting for gateway'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function connect(sub: string) {
  const token = await signRealtimeToken(realtimeClaims(SESSIONS[sub]!), SECRET);
  const client = { ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer-token-v1', token.token]), frames: [] as Frame[] };
  clients.push(client); client.ws.on('message', data => client.frames.push(JSON.parse(String(data))));
  await until(() => client.frames.some(frame => frame.type === 'session'));
  client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: CHANNEL }));
  await until(() => client.frames.some(frame => frame.action === 'joined')); return client;
}
async function sendReference(client: Client, page: unknown = REF) {
  client.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel: CHANNEL, message: 'See this dimension',
    metadata: { pageReference: page, clientDeliveryId: 'delivery-1' } }));
  await until(() => client.frames.some(frame => frame.action === 'sent' || frame.code === 'PAGE_REFERENCE_DENIED'));
  return (await backend.chatStore.listMessages(CHANNEL, 10))[0];
}
const resolve = (user: string | null, query: Record<string, string> = REF) => {
  const call = request(app).get('/api/page-references/resolve').query(query);
  return user ? call.set('x-user', user) : call;
};
beforeEach(async () => {
  jest.clearAllMocks();
  previousSecret = process.env['REALTIME_JWT_SECRET']; process.env['REALTIME_JWT_SECRET'] = SECRET;
  denied = new Set(); clients = [];
  users = new Map(Object.values(SESSIONS).map(s => [s.sub, { id: s.sub, displayName: s.sub, email: null, personId: null, epoch: 0, grants: structuredClone(s.grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ? structuredClone(users.get(id)!) : null);
  jest.mocked(isAllowed).mockImplementation(async (principal, action) =>
    principal.tenant === 'assessment' && action === 'ViewAssessment' && !denied.has(principal.sub));
  jest.mocked(pageResourceVisible).mockImplementation(async (_kind, bare) => bare === CHANNEL);
  jest.mocked(getTeamDetail).mockImplementation(async id => (id === TEAM ? structuredClone(DETAIL) : null) as Awaited<ReturnType<typeof getTeamDetail>>);
  backend = createMemorySocialChatBackend({ fixtures: false });
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { const id = req.get('x-user'); if (id && SESSIONS[id]) req.session = SESSIONS[id]; next(); });
  app.use('/api/page-references', pageReferencesRouter); app.use(errorHandler);
  server = http.createServer(app);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  handle = attachRealtimeGateway(server, { redisUrl: null, socialChat: backend, statsIntervalMs: 0, pingIntervalMs: 0 });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  clients.forEach(client => client.ws.terminate()); await handle.dispose(); await new Promise<void>(done => server.close(() => done()));
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
  jest.restoreAllMocks();
});

describe('GET /api/page-references/resolve', () => {
  it('resolves title, trail and canonical route for a current assessor', async () => {
    const response = await resolve('ana');
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.pageReference).toEqual({ ...REF, status: 'available', title: '7. Testing',
      href: '/assessment/teams/TEAM-005?dimension=7', team: { id: TEAM, name: 'Private Team Five', href: '/assessment/teams/TEAM-005' },
      breadcrumbs: [{ title: 'Teams', href: '/assessment/teams' }, { title: 'Private Team Five', href: '/assessment/teams/TEAM-005' },
        { title: '7. Testing', href: '/assessment/teams/TEAM-005?dimension=7' }] });
  });
  it.each(['oz', 'olly'])('is unavailable, without resource reads or titles, for %s (not standing in assessment)', async user => {
    const response = await resolve(user);
    expect(response.status).toBe(200); expect(response.body.pageReference).toEqual({ ...REF, status: 'unavailable' });
    expect(getTeamDetail).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('Private');
  });
  it('is unavailable when ViewAssessment is denied now, and for unknown teams or dimensions', async () => {
    denied.add('ana'); expect((await resolve('ana')).body.pageReference.status).toBe('unavailable'); denied.clear();
    expect((await resolve('ana', { kind: REF.kind, id: 'TEAM-404:7' })).body.pageReference).toEqual({ kind: REF.kind, id: 'TEAM-404:7', status: 'unavailable' });
    expect((await resolve('ana', { kind: REF.kind, id: `${TEAM}:99` })).body.pageReference.status).toBe('unavailable');
  });
  it('fails closed when access is revoked during the provider read', async () => {
    jest.mocked(getTeamDetail).mockImplementationOnce(async () => { denied.add('ana'); return structuredClone(DETAIL) as Awaited<ReturnType<typeof getTeamDetail>>; });
    expect((await resolve('ana')).body.pageReference).toEqual({ ...REF, status: 'unavailable' });
  });
  it('is unavailable when the provider fails', async () => {
    jest.mocked(getTeamDetail).mockRejectedValueOnce(new Error('aurora down'));
    expect((await resolve('ana')).body.pageReference.status).toBe('unavailable');
  });
  it.each([{ kind: 'initiative', id: `${TEAM}:7` }, { kind: REF.kind, id: 'team-005:7' }, { kind: REF.kind, id: `${TEAM}:../x` },
    { kind: REF.kind, id: TEAM }, { kind: REF.kind }])('rejects forged descriptors with 400: %j', async query => {
    expect((await resolve('ana', query as Record<string, string>)).status).toBe(400); expect(getTeamDetail).not.toHaveBeenCalled();
  });
  it('requires a session', async () => { expect((await resolve(null)).status).toBe(401); });
});

describe('team discussion send path', () => {
  it('stores only the validated descriptor and delivers no resolved fields', async () => {
    const ana = await connect('ana'), bea = await connect('bea');
    const message = await sendReference(ana);
    expect(message?.metadata?.['pageReference']).toEqual(REF);
    await until(() => bea.frames.some(frame => frame.action === 'message'));
    expect(JSON.stringify(bea.frames)).not.toContain('Private Team Five');
  });
  it.each([{ ...REF, title: 'Forged', href: '//evil.invalid' }, { kind: 'work-item', id: 'w-1' }, { kind: REF.kind, id: 'TEAM-001:7' },
    { kind: REF.kind, id: `${TEAM}:../x` }])('refuses forged or other-team references before persistence: %j', async page => {
    const ana = await connect('ana'); expect(await sendReference(ana, page)).toBeUndefined();
    expect(ana.frames).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PAGE_REFERENCE_DENIED', status: 400 })]));
  });
  it('refuses an unknown dimension of the right team', async () => {
    const ana = await connect('ana'); expect(await sendReference(ana, { kind: REF.kind, id: `${TEAM}:99` })).toBeUndefined();
    expect(ana.frames).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PAGE_REFERENCE_DENIED', status: 404 })]));
  });
  it('fails closed when the sender loses ViewAssessment during the dimension lookup', async () => {
    const ana = await connect('ana');
    jest.mocked(getTeamDetail).mockImplementationOnce(async () => { denied.add('ana'); return structuredClone(DETAIL) as Awaited<ReturnType<typeof getTeamDetail>>; });
    expect(await sendReference(ana)).toBeUndefined();
    expect(ana.frames.some(frame => frame.action === 'sent')).toBe(false);
  });
  it('leaves plain team messages untouched', async () => {
    const ana = await connect('ana');
    ana.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel: CHANNEL, message: 'plain', metadata: { clientDeliveryId: 'd-2' } }));
    await until(() => ana.frames.some(frame => frame.action === 'sent'));
    expect(getTeamDetail).not.toHaveBeenCalled();
  });
});
