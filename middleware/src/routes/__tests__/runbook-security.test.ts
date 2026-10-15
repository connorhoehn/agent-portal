// /api/runbooks — the adversarial cases from the R3 security review: scope
// bypasses through merge, self-accept through masquerade, decisions landing on a
// retired runbook, and an unvalidated `superseded_by`. Same world and the same
// real authz stack as runbooks.test.ts.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => {
    const { personOf } = jest.requireActual('./runbook-world');
    return { personId: personOf(sub) };
  }),
}));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
}));
jest.mock('../../providers/work-items.js', () => ({
  getWorkItem: jest.fn(async (id: string) => (id === 'wi-auth-1' ? { id, projectId: 'p-auth' } : null)),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { captureRawBody } from '../../lib/service-auth.js';
import { createRunbooksRouter } from '../runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { RunbookStore } from '../../lib/runbooks/index.js';
import { EDIT_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

let store: RunbookStore;
beforeEach(() => { store = seededStore(); });

/** A session as `user`; with `actor`, the real identity behind a masquerade (session.act). */
function appAs(user: TestUser, actor?: TestUser) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0,
      ...(actor ? { act: { sub: actor.sub, role: actor.role, tenant: actor.tenant, grants: { [actor.tenant]: [actor.role] } } } : {}),
    };
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

async function proposeEdit(user: TestUser, actor?: TestUser) {
  return request(appAs(user, actor)).post('/api/runbooks/proposals')
    .send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'A run found the callback step missing.' });
}

describe('merge cannot close a proposal outside the reviewer\'s scope', () => {
  it('an SME on p-other cannot merge an edit aimed at a p-auth runbook into their own runbook', async () => {
    const created = await proposeEdit(USERS.member!);
    expect(created.status).toBe(201);
    const id = created.body.proposal.id;
    // smeOther may review rb-sso-new-origin (p-other) but not rb-tenant-cutover (p-auth).
    const res = await request(appAs(USERS.smeOther!)).post(`/api/runbooks/proposals/${id}/merge`).send({ into: 'rb-sso-new-origin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
    expect((await store.getProposal(id))!.status).toBe('open');
  });

  it('a reviewer of BOTH the source runbook and the target may merge', async () => {
    const created = await proposeEdit(USERS.member!);
    const res = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${created.body.proposal.id}/merge`).send({ into: 'rb-sso-new-origin' });
    expect(res.status).toBe(201);
  });
});

describe('masquerade cannot launder a self-accept', () => {
  it('an admin who proposed cannot accept while masquerading as an eligible SME', async () => {
    const created = await proposeEdit(USERS.admin!);
    expect(created.status).toBe(201);
    const res = await request(appAs(USERS.smeAuth!, USERS.admin!)).post(`/api/runbooks/proposals/${created.body.proposal.id}/accept`).send({});
    expect(res.status).toBe(403);
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(1);
  });

  it('a proposal cannot be filed under a masquerade (it would be attributed to someone else)', async () => {
    const res = await proposeEdit(USERS.member!, USERS.admin!);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MASQUERADING');
  });

  it('no decision is taken under a masquerade', async () => {
    const created = await proposeEdit(USERS.member!);
    const id = created.body.proposal.id;
    const as = appAs(USERS.smeAuth!, USERS.admin!);
    expect((await request(as).post(`/api/runbooks/proposals/${id}/accept`).send({})).body.code).toBe('MASQUERADING');
    expect((await request(as).post(`/api/runbooks/proposals/${id}/reject`).send({ note: 'no' })).body.code).toBe('MASQUERADING');
    expect((await request(as).post('/api/runbooks/rb-tenant-cutover/retire').send({ reason: 'x' })).body.code).toBe('MASQUERADING');
    expect((await store.getProposal(id))!.status).toBe('open');
  });
});

describe('a retired runbook takes no decision', () => {
  it('an edit opened before retirement cannot be accepted after it', async () => {
    const created = await proposeEdit(USERS.member!);
    const id = created.body.proposal.id;
    await request(appAs(USERS.leader!)).post('/api/runbooks/rb-tenant-cutover/retire').send({ reason: 'The shim is gone.' }).expect(200);
    const res = await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RETIRED');
    const rb = (await store.getRunbook('rb-tenant-cutover'))!;
    expect(rb.current_version).toBe(1);
    expect(rb.status).toBe('retired');
  });

  it('a retire proposal names only another published runbook as its successor', async () => {
    const created = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'retire', runbook_id: 'rb-tenant-cutover', rationale: 'Gone.' });
    const id = created.body.proposal.id;
    const bad = await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({ superseded_by: 'rb-nope' });
    expect(bad.status).toBe(400);
    const self = await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({ superseded_by: 'rb-tenant-cutover' });
    expect(self.status).toBe(400);
    expect((await store.getRunbook('rb-tenant-cutover'))!.status).toBe('published');
  });
});
