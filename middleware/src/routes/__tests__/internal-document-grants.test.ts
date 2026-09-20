jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { getUser } from '../../providers/identity.js';
import { internalDocumentGrantsRouter } from '../internal-document-grants.js';
import { documentSessionId } from '../../lib/document-session.js';
import type { Session } from '../../lib/session.js';

const app = express().use(express.json()).use('/internal/document-grants', internalDocumentGrantsRouter);
const session: Session = { sub: 'alice', tenant: 'assessment', role: 'assessor',
  grants: { assessment: ['assessor'] }, epoch: 3, iat: Date.now() };
const send = (body: unknown = { sub: 'alice', tenantId: 'assessment', sessionId: documentSessionId(session) }, key = 'test-policy') =>
  request(app).post('/internal/document-grants/session').set('x-document-policy-key', key).send(body as object);
const originalSecret = process.env['DOCUMENT_POLICY_SECRET'];
beforeEach(() => {
  process.env['DOCUMENT_POLICY_SECRET'] = 'test-policy';
  jest.mocked(getUser).mockReset().mockResolvedValue({ id: 'alice', displayName: 'Alice', email: null,
    personId: null, grants: { assessment: ['assessor'] }, epoch: 3 });
});
afterAll(() => {
  if (originalSecret === undefined) delete process.env['DOCUMENT_POLICY_SECRET'];
  else process.env['DOCUMENT_POLICY_SECRET'] = originalSecret;
});

it('never opens an unconfigured policy endpoint, including development', async () => {
  delete process.env['DOCUMENT_POLICY_SECRET'];
  expect((await send()).status).toBe(503);
  expect(getUser).not.toHaveBeenCalled();
});
it('rejects invalid service credentials before looking up identity', async () => {
  expect((await send(undefined, 'wrong')).status).toBe(401);
  expect(getUser).not.toHaveBeenCalled();
});
it('resolves the current epoch from authoritative identity and disables caching', async () => {
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ epoch: 3 });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(getUser).toHaveBeenCalledWith('alice', { authoritative: true });
});
it.each([null, { epoch: 4, grants: { assessment: ['assessor'] } }, { epoch: 3, grants: { orgiq: ['member'] } }])
('revokes missing users, stale epochs and removed tenant grants', async (user) => {
  jest.mocked(getUser).mockResolvedValue(user as Awaited<ReturnType<typeof getUser>>);
  expect((await send()).body).toEqual({ epoch: null });
});
it('fails closed on an identity outage', async () => {
  jest.mocked(getUser).mockRejectedValue(new Error('database unavailable'));
  expect((await send()).status).toBe(503);
});
it('validates the original operator epoch for masqueraded sessions', async () => {
  const impersonated = { ...session, act: { sub: 'operator', role: 'admin' as const, tenant: 'orgiq' as const,
    grants: { orgiq: ['admin'] }, epoch: 8 } };
  jest.mocked(getUser).mockImplementation(async (sub): ReturnType<typeof getUser> => sub === 'alice'
    ? { id: 'alice', displayName: 'Alice', email: null, personId: null, grants: { assessment: ['assessor'] }, epoch: 3 }
    : { id: 'operator', displayName: 'Operator', email: null, personId: null, grants: { orgiq: ['admin'] }, epoch: 9 });
  expect((await send({ sub: 'alice', tenantId: 'assessment', sessionId: documentSessionId(impersonated) })).body).toEqual({ epoch: null });
});
it('rejects malformed and cross-tenant references', async () => {
  expect((await send({ sub: 'alice', tenantId: 'orgiq', sessionId: 'x' })).status).toBe(400);
  expect((await send({ sub: 'alice', tenantId: 'assessment', sessionId: 'broken' })).body).toEqual({ epoch: null });
});
