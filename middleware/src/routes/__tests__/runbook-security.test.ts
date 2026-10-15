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
import { EDIT_MD, NEW_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

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

describe('references on proposals and accepts must be real', () => {
  it('a proposal naming a work item that does not exist is a 400; a real one is accepted', async () => {
    const post = (workItem: string) => request(appAs(USERS.member!)).post('/api/runbooks/proposals')
      .send({ kind: 'new', markdown: NEW_MD, rationale: 'x', source: { work_item_id: workItem } });
    const bad = await post('wi-nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/work item/);
    expect((await store.listProposals({})).items).toHaveLength(0);
    expect((await post('wi-auth-1')).status).toBe(201);
  });

  it('accepting a new runbook with an owner who is not a person is a 400 and leaves the proposal open', async () => {
    const created = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', markdown: NEW_MD, rationale: 'x' });
    const id = created.body.proposal.id;
    const bad = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${id}/accept`).send({ scope: { kind: 'org' }, id: 'rb-org-wide', owner_person_id: 'p-nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/person/);
    expect((await store.getProposal(id))!.status).toBe('open');
    expect(await store.getRunbook('rb-org-wide')).toBeNull();
    expect((await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${id}/accept`).send({ scope: { kind: 'org' }, id: 'rb-org-wide', owner_person_id: 'p-002' })).status).toBe(201);
  });
});

describe('a proposer may withdraw their own open proposal', () => {
  const withdraw = (user: TestUser, id: string, actor?: TestUser) => request(appAs(user, actor)).post(`/api/runbooks/proposals/${id}/withdraw`).send({ note: 'changed my mind' });

  it('withdraws once: status, decider and note are recorded, and it can no longer be accepted', async () => {
    const id = (await proposeEdit(USERS.member!)).body.proposal.id;
    const res = await withdraw(USERS.member!, id);
    expect(res.status).toBe(200);
    expect(res.body.proposal).toEqual(expect.objectContaining({ status: 'withdrawn', decided_by: 'p-300', note: 'changed my mind' }));
    expect((await withdraw(USERS.member!, id)).status).toBe(409);
    expect((await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({})).status).toBe(409);
    expect((await request(appAs(USERS.member!)).get('/api/runbooks/proposals?status=withdrawn')).body.proposals).toHaveLength(1);
  });

  it('only the proposer: another person, even a reviewer or admin, is refused; so is an unknown proposal', async () => {
    const id = (await proposeEdit(USERS.member!)).body.proposal.id;
    for (const u of [USERS.owner!, USERS.leader!, USERS.admin!, USERS.proposer!]) {
      const res = await withdraw(u, id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_PROPOSER');
    }
    expect((await store.getProposal(id))!.status).toBe('open');
    expect((await withdraw(USERS.member!, 'prop-nope')).status).toBe(404);
  });

  it('is refused during a masquerade, even by the proposer\'s impersonator', async () => {
    const id = (await proposeEdit(USERS.member!)).body.proposal.id;
    const res = await withdraw(USERS.member!, id, USERS.admin!);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MASQUERADING');
    expect((await store.getProposal(id))!.status).toBe('open');
  });

  it('is session-only: a box envelope and an anonymous caller cannot withdraw', async () => {
    const id = (await proposeEdit(USERS.member!)).body.proposal.id;
    const anon = express();
    anon.use(express.json({ verify: captureRawBody }));
    anon.use((req, _res, next) => { (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true; next(); });
    anon.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
    anon.use(errorHandler);
    expect((await request(anon).post(`/api/runbooks/proposals/${id}/withdraw`).send({})).status).toBe(401);
  });

  it('a run proposal cannot be withdrawn by a person, and rejecting your own proposal stays blocked', async () => {
    const id = (await proposeEdit(USERS.proposer!)).body.proposal.id;
    const own = await request(appAs(USERS.proposer!)).post(`/api/runbooks/proposals/${id}/reject`).send({ note: 'no' });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('SELF_ACCEPT');
    await store.putProposal({ ...(await store.getProposal(id))!, id: 'prop-run', source: { kind: 'run', run_ref: 'job-1', lab_experience_ids: [] } });
    expect((await withdraw(USERS.member!, 'prop-run')).status).toBe(403);
  });
});
