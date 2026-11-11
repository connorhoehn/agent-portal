// Bell items for runbook proposals (value sweep package 2): who hears when one is filed, decided
// or about to expire, and that a failing notice never changes the outcome of the request.
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/identity.js', () => {
  const users = () => {
    const { USERS } = jest.requireActual('./runbook-world');
    return (Object.values(USERS) as Array<{ sub: string; role: string; tenant: string; personId: string }>)
      .map((u) => ({ id: u.sub, personId: u.personId, grants: { [u.tenant]: [u.role] } }));
  };
  return {
    getUser: jest.fn(async (sub: string) => users().find((u) => u.id === sub) ?? null),
    listUsers: jest.fn(async () => users()),
  };
});
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
}));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(async () => null) }));
jest.mock('../../lib/social-notify.js', () => ({
  notify: jest.fn(async (ids: string[]) => ids),
  userForPerson: jest.fn(async (personId: string) => {
    const { USERS } = jest.requireActual('./runbook-world');
    return (Object.values(USERS) as Array<{ sub: string; personId: string }>).find((u) => u.personId === personId)?.sub ?? null;
  }),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { captureRawBody } from '../../lib/service-auth.js';
import { createRunbooksRouter } from '../runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { RunbookStore } from '../../lib/runbooks/index.js';
import { notifyExpiring } from '../../lib/runbooks/notices.js';
import { notify } from '../../lib/social-notify.js';
import { EDIT_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

const notifyMock = notify as unknown as jest.Mock;
let store: RunbookStore;

function appAs(user: TestUser) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => { store = seededStore(); notifyMock.mockClear(); notifyMock.mockImplementation(async (ids: string[]) => ids); });

const file = (user: TestUser) =>
  request(appAs(user)).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'A run found the callback step missing.' });

describe('filing', () => {
  it('tells the people who may review it, inside the tenant, and never the author', async () => {
    const res = await file(USERS.proposer!);
    expect(res.status).toBe(201);
    const [recipients, input] = notifyMock.mock.calls[0]!;
    expect([...recipients].sort()).toEqual(['u-admin', 'u-lead', 'u-own', 'u-sme-a']);
    expect(recipients).not.toContain('u-prop'); // the author
    expect(recipients).not.toContain('u-sme-o'); // an SME on another initiative
    expect(recipients).not.toContain('u-asr'); // another tenant
    expect(input.payload.tenant).toBe('orgiq');
    expect(input.action.href).toBe(`/iq/runbooks/proposals/${res.body.proposal.id}`);
    expect(input.id).toBe(`runbook-proposal:${res.body.proposal.id}:filed`);
  });

  it('is still filed when the notice throws', async () => {
    notifyMock.mockRejectedValue(new Error('gateway down'));
    const res = await file(USERS.member!);
    expect(res.status).toBe(201);
    expect((await store.getProposal(res.body.proposal.id))?.status).toBe('open');
  });
});

describe('deciding', () => {
  it('tells the person who filed it, not the person who decided', async () => {
    const id = (await file(USERS.member!)).body.proposal.id;
    notifyMock.mockClear();
    const res = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${id}/accept`).send({});
    expect(res.status).toBe(200);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toEqual(['u-mem']);
    expect(notifyMock.mock.calls[0][1].title).toContain('accepted');
  });

  it('tells the dispatcher of the run that filed it, and a rejection still succeeds when the notice throws', async () => {
    const id = (await file(USERS.member!)).body.proposal.id;
    const p = (await store.getProposal(id))!;
    await store.putProposal({ ...p, source: { kind: 'run', run_ref: 'run-1', dispatched_by: USERS.member!.personId, lab_experience_ids: [] } });
    notifyMock.mockClear();
    const res = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${id}/reject`).send({ note: 'Not this one.' });
    expect(res.status).toBe(200);
    expect(notifyMock.mock.calls[0][0]).toEqual(['u-mem']);
    expect(notifyMock.mock.calls[0][1].title).toContain('rejected');

    const second = (await file(USERS.proposer!)).body.proposal.id;
    notifyMock.mockRejectedValue(new Error('gateway down'));
    const again = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${second}/reject`).send({ note: 'No.' });
    expect(again.status).toBe(200);
  });
});

describe('the rail count', () => {
  it('counts open proposals the caller may decide, not their own', async () => {
    await file(USERS.proposer!);
    expect((await request(appAs(USERS.leader!)).get('/api/runbooks/proposals/review-count')).body).toEqual({ count: 1 });
    expect((await request(appAs(USERS.proposer!)).get('/api/runbooks/proposals/review-count')).body).toEqual({ count: 0 });
    expect((await request(appAs(USERS.smeOther!)).get('/api/runbooks/proposals/review-count')).body).toEqual({ count: 0 });
  });
});

describe('expiry notice', () => {
  it('goes once, three days before a run proposal expires', async () => {
    const id = (await file(USERS.member!)).body.proposal.id;
    const p = (await store.getProposal(id))!;
    const created = '2026-11-01T00:00:00.000Z';
    await store.putProposal({ ...p, created_at: created, source: { kind: 'run', run_ref: 'run-2', dispatched_by: USERS.member!.personId, lab_experience_ids: [] } });
    notifyMock.mockClear();
    const early = '2026-11-05T00:00:00.000Z';
    const due = '2026-11-12T00:00:00.000Z';
    const list = async () => (await store.listProposals({ status: ['open'] })).items;

    expect(await notifyExpiring(store, await list(), early)).toEqual([]);
    expect(await notifyExpiring(store, await list(), due)).toEqual([id]);
    expect(await notifyExpiring(store, await list(), '2026-11-13T00:00:00.000Z')).toEqual([]);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).not.toContain('u-mem');
    expect(notifyMock.mock.calls[0][1].title).toContain('expires in');
  });
});

describe('the proposal list narrowed to an initiative', () => {
  it('keeps an edit of that initiative\'s runbook and drops another initiative\'s', async () => {
    const mine = (await file(USERS.proposer!)).body.proposal.id;
    const other = await request(appAs(USERS.proposer!)).post('/api/runbooks/proposals')
      .send({ kind: 'edit', runbook_id: 'rb-sso-new-origin', markdown: EDIT_MD, rationale: 'A different initiative.' });
    expect(other.status).toBeLessThan(500);
    const ids = async (initiative: string, user = USERS.leader!) =>
      ((await request(appAs(user)).get(`/api/runbooks/proposals?initiative=${initiative}`)).body.proposals as Array<{ id: string }>).map((p) => p.id);
    expect(await ids('p-auth')).toEqual([mine]);
    expect(await ids('p-nowhere')).toEqual([]);
  });

  it('is open to the same readers as the unfiltered list and refuses the same callers', async () => {
    await file(USERS.proposer!);
    const asReader = await request(appAs(USERS.smeOther!)).get('/api/runbooks/proposals?initiative=p-auth');
    expect(asReader.status).toBe(200);
    expect(asReader.body.proposals).toHaveLength(1);
    const app = express();
    app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
    app.use(errorHandler);
    const plain = (await request(app).get('/api/runbooks/proposals')).status;
    expect((await request(app).get('/api/runbooks/proposals?initiative=p-auth')).status).toBe(plain);
  });
});
