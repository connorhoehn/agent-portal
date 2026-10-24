jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true }, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn(async () => false) }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { pageResourceVisible } from '../page-resources.js';
import { isAllowed } from '../authz.js';
import { getKnowledgeDoc } from '../../providers/assessment.js';
import { assessmentDocumentLobby } from '../assessment-document-context.js';
import { CallMediaProofRuntime, setCallMediaProofRuntime } from '../call-media-proof.js';
import { lobbyGuard } from '../gateway/authority.js';
import { realtimeLobbyAccessRouter } from '../../routes/realtime-lobby-access.js';
import { realtimeClaims, signRealtimeToken } from '../realtime-token.js';
import type { Session } from '../session.js';
const LOBBY = 'orgiq:initiative:p-observability', CALL = 'call-one';
const session: Session = { sub: 'alice', tenant: 'orgiq', role: 'member', epoch: 2, grants: { orgiq: ['member'] }, iat: 100 };
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, epoch: s.epoch, sessionIat: s.iat, act: s.act });
let calls: InMemoryCallStateStore, runtime: CallMediaProofRuntime, users: Map<string, UserInfo>, sockets: Map<string, Record<string, unknown>>;
const app = express().use(express.json()).use('/api/realtime', realtimeLobbyAccessRouter).use((e: any, _r: any, s: any, _n: any) => s.status(e.status ?? 500).json({ error: e.message }));
beforeEach(async () => {
  process.env['REALTIME_JWT_SECRET'] = 'synthetic-seat-proof';
  users = new Map([['alice', { id: 'alice', displayName: 'Alice', email: null, personId: null, epoch: 2, grants: { orgiq: ['member'] } }]]);
  jest.mocked(getUser).mockReset().mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  jest.mocked(isAllowed).mockReset().mockResolvedValue(false);
  jest.mocked(getKnowledgeDoc).mockReset();
  sockets = new Map([['alice-socket', ctx(session)], ['alice-unseated', ctx(session)], ['bob-socket', ctx({ ...session, sub: 'bob' })]]);
  const router = { isClientLive: (id: string) => sockets.has(id), getClientData: (id: string) => ({ userContext: sockets.get(id) }) } as RealtimeRouter;
  calls = new InMemoryCallStateStore();
  await calls.registerParticipant(CALL, 'alice-socket', 'alice', LOBBY, []);
  await calls.registerParticipant(CALL, 'bob-socket', 'alice', LOBBY, []);
  await calls.markAccepted(CALL, 600);
  runtime = new CallMediaProofRuntime({ calls, router, lobbyAllowed: lobbyGuard }); setCallMediaProofRuntime(runtime);
});
afterEach(() => setCallMediaProofRuntime(null));
const ask = async (input: Record<string, unknown> = { callId: CALL, clientId: 'alice-socket', lobbyName: LOBBY }, token?: string) => {
  const bearer = token ?? (await signRealtimeToken(realtimeClaims(session), 'synthetic-seat-proof')).token;
  return request(app).post('/api/realtime/call-seat').set('Authorization', `Bearer ${bearer}`).send(input);
};
test('real native accepted seat, Work read authority and current socket produce exact proof, no Social grant', async () => {
  const res = await ask(); expect(res.status).toBe(200);
  expect(res.body).toEqual({ allowed: true, callId: CALL, lobbyName: LOBBY, clientId: 'alice-socket', userId: 'alice', tenant: 'orgiq', epoch: 2 });
  expect(res.headers['cache-control']).toBe('no-store');
});
test.each(['alice-unseated', 'bob-socket', 'gone'])('arbitrary client %s cannot bind another media leg', async clientId => {
  expect((await ask({ callId: CALL, clientId, lobbyName: LOBBY })).status).toBe(403);
});
test('unaccepted, ended, wrong lobby and lost socket refuse', async () => {
  await calls.clearAccepted(CALL); expect((await ask()).status).toBe(403);
  await calls.markAccepted(CALL, 600);
  expect((await ask({ callId: CALL, clientId: 'alice-socket', lobbyName: 'orgiq:initiative:other' })).status).toBe(403);
  sockets.delete('alice-socket'); expect((await ask()).status).toBe(403);
  await calls.forgetCall(CALL); expect((await ask()).status).toBe(403);
});
test('resource/epoch/tenant revocation and same user different provenance refuse', async () => {
  jest.mocked(pageResourceVisible).mockResolvedValue(false); expect((await ask()).status).toBe(403);
  jest.mocked(pageResourceVisible).mockResolvedValue(true);
  users.get('alice')!.epoch = 3; expect((await ask()).status).toBe(403); users.get('alice')!.epoch = 2;
  sockets.set('alice-socket', ctx({ ...session, epoch: 1 })); expect((await ask()).status).toBe(403);
  sockets.set('alice-socket', ctx(session)); users.get('alice')!.grants.orgiq = []; expect((await ask()).status).toBe(403);
});
test('masquerade actor must still be current and its exact provenance must match the connected seat', async () => {
  const acting: Session = { ...session, act: { sub: 'admin', epoch: 4, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } };
  users.set('admin', { id: 'admin', displayName: 'Admin', epoch: 4, email: null, personId: null, grants: { orgiq: ['admin'] } });
  sockets.set('alice-socket', ctx(acting));
  const bearer = (await signRealtimeToken(realtimeClaims(acting), 'synthetic-seat-proof')).token;
  expect((await ask(undefined, bearer)).body).toMatchObject({ allowed: true, actor: { sub: 'admin', epoch: 4 } });
  users.get('admin')!.epoch = 5; expect((await ask(undefined, bearer)).status).toBe(403);
});
test('exact Work DM named user is supported; another DM or wrong tenant cannot bind', async () => {
  const callId = 'dm-call', lobbyName = 'orgiq:dm:alice:bob';
  await calls.registerParticipant(callId, 'alice-socket', 'alice', lobbyName, ['bob']); await calls.markAccepted(callId, 600);
  expect((await ask({ callId, lobbyName, clientId: 'alice-socket' })).body).toMatchObject({ allowed: true, callId, lobbyName, userId: 'alice' });
  const other = 'orgiq:dm:bob:carol'; await calls.registerParticipant('other-dm', 'alice-socket', 'bob', other, ['carol']); await calls.markAccepted('other-dm', 600);
  expect((await ask({ callId: 'other-dm', lobbyName: other, clientId: 'alice-socket' })).status).toBe(403);
  sockets.set('alice-socket', ctx({ ...session, tenant: 'assessment' }));
  expect((await ask({ callId, lobbyName, clientId: 'alice-socket' })).status).toBe(403);
});
test.each(['social:dm:alice:bob', 'social:room:journey'])('binds a current Social media seat in %s and refuses permission or identity revocation', async lobbyName => {
  const social: Session = { ...session, tenant: 'social', role: 'participant', grants: { social: ['participant'] } };
  users.get('alice')!.grants = social.grants;
  sockets.set('alice-socket', ctx(social));
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.tenant === 'social' && action === 'ViewSocial');
  const callId = 'social-call';
  await calls.registerParticipant(callId, 'alice-socket', 'alice', lobbyName, ['bob']); await calls.markAccepted(callId, 600);
  const token = (await signRealtimeToken(realtimeClaims(social), 'synthetic-seat-proof')).token;
  const input = { callId, lobbyName, clientId: 'alice-socket' };
  expect((await ask(input, token)).body).toMatchObject({ allowed: true, callId, lobbyName, userId: 'alice', tenant: 'social' });
  jest.mocked(isAllowed).mockResolvedValue(false);
  expect((await ask(input, token)).status).toBe(403);
  jest.mocked(isAllowed).mockResolvedValue(true);
  users.get('alice')!.epoch = 3;
  expect((await ask(input, token)).status).toBe(403);
});
test('leaving while final host read is pending cannot produce an ACK', async () => {
  jest.mocked(pageResourceVisible).mockImplementation(async () => { sockets.delete('alice-socket'); return true; });
  expect((await ask()).status).toBe(403);
});
test('malformed body, forged bearer and unavailable authority fail closed', async () => {
  expect((await ask({ callId: CALL, clientId: 'alice-socket', lobbyName: LOBBY, userId: 'bob' })).status).toBe(400);
  expect((await ask(undefined, 'invalid')).status).toBe(401);
  setCallMediaProofRuntime(null); expect((await ask()).status).toBe(503);
});

async function documentSeat(channelSource = 'ec:standards/ci-cd-standards.md', withChannel = true) {
  const sourceId = 'ec:standards/ci-cd-standards.md', lobbyName = assessmentDocumentLobby(sourceId), callId = 'doc-call';
  const signed: Session = { ...session, tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } };
  users.get('alice')!.grants = signed.grants;
  sockets.set('alice-socket', ctx(signed));
  jest.mocked(isAllowed).mockResolvedValue(true);
  jest.mocked(getKnowledgeDoc).mockResolvedValue({ id: sourceId, title: 'CI standards', classification: 'internal', markdown: '', editable: true, path: '', updated_at: '' });
  await calls.forgetCall(callId);
  await calls.registerParticipant(callId, 'alice-socket', 'alice', lobbyName, [], withChannel ? `assessment-document:/assessment/enterprise?doc=${encodeURIComponent(channelSource)}` : undefined);
  await calls.markAccepted(callId, 600);
  const token = (await signRealtimeToken(realtimeClaims(signed), 'synthetic-seat-proof')).token;
  return { sourceId, lobbyName, callId, token, input: { callId, lobbyName, clientId: 'alice-socket', documentSourceId: sourceId } };
}
test('accepted native document seat proves original hashed source without Social access or page POST', async () => {
  const doc = await documentSeat(); const res = await ask(doc.input, doc.token);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ allowed: true, tenant: 'assessment', documentContext: { tenant: 'assessment', sourceId: doc.sourceId, lobbyName: doc.lobbyName } });
  expect(getKnowledgeDoc).toHaveBeenCalledTimes(2);
  expect(getKnowledgeDoc).toHaveBeenCalledWith(doc.sourceId);
});
test('document source must match the original accepted stored channel, not just a client hash claim', async () => {
  const wrong = await documentSeat('different-source'); expect((await ask(wrong.input, wrong.token)).status).toBe(403);
  const legacy = await documentSeat('', false); expect((await ask(legacy.input, legacy.token)).status).toBe(403);
  const { documentSourceId: _omitted, ...noSource } = legacy.input;
  expect((await ask(noSource, legacy.token)).status).toBe(403);
  expect((await ask({ callId: CALL, lobbyName: LOBBY, clientId: 'alice-socket', documentSourceId: 'page:100002' })).status).toBe(403);
});
test('document deletion, permission revocation and leaving during source I/O cannot bind', async () => {
  const doc = await documentSeat();
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null); expect((await ask(doc.input, doc.token)).status).toBe(403);
  jest.mocked(isAllowed).mockResolvedValue(false); expect((await ask(doc.input, doc.token)).status).toBe(403);
  jest.mocked(isAllowed).mockResolvedValue(true);
  jest.mocked(getKnowledgeDoc).mockImplementation(async () => { sockets.delete('alice-socket'); return { id: doc.sourceId, title: 'deleted seat', classification: 'internal', markdown: '', editable: false, path: '', updated_at: '' }; });
  expect((await ask(doc.input, doc.token)).status).toBe(403);
});
