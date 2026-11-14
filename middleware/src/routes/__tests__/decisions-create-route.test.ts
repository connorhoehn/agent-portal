// POST /api/graph/decisions (meeting consent, package 4): a decision agreed in
// a call, or by hand, is created on an initiative.
//
// The REAL authz stack runs (the seed Cedar matrix), so RaiseDecision and
// DecideDecision are the actual role matrix; identity and the initiatives are
// mocked so each persona's relation to them is explicit. LLM Platform is owned
// by Nina (p-047) with Katya (p-042) and Caleb (p-013) contributing; Auth
// Migration is owned by Vera (p-002) with Nora (p-004) contributing.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn(), fetchAvatarsById: jest.fn(async () => new Map()) }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
// sub -> [person, display name]
const PEOPLE: Record<string, [string | null, string]> = {
  'u-nina': ['p-047', 'Nina Rivera'],   // owns LLM Platform
  'u-katya': ['p-042', 'Katya Petrov'], // contributes to LLM Platform
  'u-caleb': ['p-013', 'Caleb Turner'], // contributes to LLM Platform
  'u-nora': ['p-004', 'Nora DaSilva'],  // contributes to Auth Migration only
  'u-guest': [null, 'Guest Reviewer'],  // an account with no person
};
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => {
    const hit = PEOPLE[sub];
    return hit ? { id: sub, personId: hit[0], displayName: hit[1] } : null;
  }),
}));
jest.mock('../../providers/projects.js', () => ({
  ...jest.requireActual('../../providers/projects.js'),
  getProject: jest.fn(async (id: string) => ({
    'p-llm-platform': { id, ownerId: 'p-047', ownerName: 'Nina Rivera', contributors: [{ personId: 'p-042' }, { personId: 'p-013' }] },
    'p-auth-migration': { id, ownerId: 'p-002', ownerName: 'Vera Green', contributors: [{ personId: 'p-004' }] },
  } as Record<string, unknown>)[id] ?? null),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { decisionsRouter } from '../decisions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { decisionRows, decisionParticipantRows, decisionEventRows } from '../../mock/decisions.js';
import { exec, withTransaction } from '../../providers/aurora.js';

const STATEMENT = 'Cut over the smallest tenants first';

function appAs(sub: string | null, role = 'member') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sub) (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq', grants: { orgiq: [role] }, iat: 0 };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true;
    next();
  });
  app.use('/api/graph/decisions', decisionsRouter);
  app.use(errorHandler);
  return app;
}

const fromCall = (extra: Record<string, unknown> = {}) => ({
  initiativeId: 'p-llm-platform', statement: STATEMENT, source: 'call', callId: 'call-7', participants: ['u-katya', 'u-caleb'], ...extra,
});

afterEach(() => {
  fixtureRegistry.resetAll('default');
  (exec as jest.Mock).mockReset();
  (withTransaction as jest.Mock).mockReset();
});

describe('POST /api/graph/decisions', () => {
  it('the owner records a decision agreed in a call: decided by them, the statement as topic, option and outcome, the history naming who agreed', async () => {
    const res = await request(appAs('u-nina', 'sme')).post('/api/graph/decisions').send(fromCall({ state: 'resolved', participants: ['u-katya', 'u-nina', 'u-guest'] }));
    expect(res.status).toBe(201);
    expect(exec).not.toHaveBeenCalled();
    expect(res.body).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^d-/), topic: STATEMENT, status: 'resolved', projectId: 'p-llm-platform',
      decidedBy: { id: 'p-047', name: 'Nina Rivera' }, outcome: STATEMENT, decidedAt: expect.any(String),
      options: [{ id: 'agreed', label: STATEMENT }],
    }));
    // The creator decides; everyone linked to a person who agreed is a participant; the guest has no person row.
    expect(res.body.participants.map((p: { personId: string; role: string }) => [p.personId, p.role]).sort()).toEqual([['p-042', 'contributor'], ['p-047', 'decider']]);
    expect(res.body.history).toEqual([expect.objectContaining({
      kind: 'recorded', source: 'call', callId: 'call-7', by: { id: 'p-047', name: 'Nina Rivera' }, rationale: '',
      people: [{ id: 'p-047', name: 'Nina Rivera' }, { id: 'p-042', name: 'Katya Petrov' }, { id: 'u-guest', name: 'Guest Reviewer' }],
    })]);
    // It is in the register like any other settled decision.
    const list = await request(appAs('u-katya')).get('/api/graph/decisions?limit=200');
    expect(list.body.find((d: { id: string }) => d.id === res.body.id)).toEqual(expect.objectContaining({ status: 'resolved', decidedBy: { id: 'p-047', name: 'Nina Rivera' } }));
  });

  it('a member raises a waiting decision for the owner, who then decides it with its one option', async () => {
    const res = await request(appAs('u-katya')).post('/api/graph/decisions').send(fromCall({ state: 'waiting' }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ status: 'open', decidedBy: null, outcome: null, decidedAt: null, viewerMayDecide: false }));
    expect(res.body.participants.find((p: { role: string }) => p.role === 'decider')).toEqual(expect.objectContaining({ personId: 'p-047' }));
    expect(res.body.history).toEqual([expect.objectContaining({ kind: 'raised', source: 'call', callId: 'call-7', by: { id: 'p-042', name: 'Katya Petrov' }, people: [{ id: 'p-042', name: 'Katya Petrov' }] })]);

    // The owner's lists show it waiting on them, and their record offers the decide control.
    const list = await request(appAs('u-nina')).get('/api/graph/decisions?limit=200');
    expect(list.body.find((d: { id: string }) => d.id === res.body.id)).toEqual(expect.objectContaining({ status: 'open', deciderRole: 'decider', decider: { id: 'p-047', name: 'Nina Rivera' } }));
    const record = await request(appAs('u-nina')).get(`/api/graph/decisions/${res.body.id}`);
    expect(record.body.viewerMayDecide).toBe(true);
    const decided = await request(appAs('u-nina')).post(`/api/graph/decisions/${res.body.id}/decide`).send({ outcome: 'resolved', optionId: 'agreed' });
    expect(decided.status).toBe(200);
    expect(decided.body).toEqual(expect.objectContaining({ status: 'resolved', outcome: STATEMENT, decidedBy: { id: 'p-047', name: 'Nina Rivera' } }));
    expect(decided.body.history.map((e: { kind: string }) => e.kind).sort()).toEqual(['raised', 'resolved']);
  });

  it('a manual decision carries no call id', async () => {
    const res = await request(appAs('u-caleb')).post('/api/graph/decisions').send({ initiativeId: 'p-llm-platform', statement: STATEMENT, state: 'waiting', source: 'manual' });
    expect(res.status).toBe(201);
    expect(res.body.history[0]).toEqual(expect.objectContaining({ kind: 'raised', source: 'manual', callId: null }));
    expect(decisionEventRows.rows()).toEqual([expect.objectContaining({ kind: 'raised', source: 'manual', callId: null, rationale: '' })]);
  });

  it('a member may not record one as decided (403 NOT_DECIDER) and nothing is written', async () => {
    const before = decisionRows.rows().length;
    const res = await request(appAs('u-katya')).post('/api/graph/decisions').send(fromCall({ state: 'resolved' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_DECIDER');
    expect(decisionRows.rows()).toHaveLength(before);
    expect(decisionEventRows.rows()).toEqual([]);
  });

  it('another initiative\'s member is refused (403 NOT_ON_INITIATIVE) either way; an unknown initiative is 404', async () => {
    const participantsBefore = decisionParticipantRows.rows().length;
    for (const state of ['waiting', 'resolved']) {
      const res = await request(appAs('u-nora', 'sme')).post('/api/graph/decisions').send(fromCall({ state }));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_ON_INITIATIVE');
    }
    // Nobody: an account with no person is on no initiative.
    expect((await request(appAs('u-guest')).post('/api/graph/decisions').send(fromCall({ state: 'waiting' }))).status).toBe(403);
    expect((await request(appAs('u-nina')).post('/api/graph/decisions').send(fromCall({ state: 'waiting', initiativeId: 'p-nowhere' }))).status).toBe(404);
    expect(decisionParticipantRows.rows()).toHaveLength(participantsBefore);
    expect(decisionEventRows.rows()).toEqual([]);
  });

  it('an org-leader may record one as decided on an initiative they are not on', async () => {
    const res = await request(appAs('u-nora', 'org-leader')).post('/api/graph/decisions').send(fromCall({ state: 'resolved' }));
    expect(res.status).toBe(201);
    expect(res.body.decidedBy).toEqual({ id: 'p-004', name: 'Nora DaSilva' });
  });

  it('a role without RaiseDecision is refused before the scope check; anonymous is 401', async () => {
    const outsider = await request(appAs('u-katya', 'participant')).post('/api/graph/decisions').send(fromCall({ state: 'waiting' }));
    expect(outsider.status).toBe(403);
    expect(outsider.body.action).toBe('RaiseDecision');
    expect((await request(appAs(null)).post('/api/graph/decisions').send(fromCall({ state: 'waiting' }))).status).toBe(401);
  });

  it('validates the body', async () => {
    const app = appAs('u-nina');
    const bad = async (body: Record<string, unknown>) => (await request(app).post('/api/graph/decisions').send(body)).status;
    expect(await bad(fromCall({ state: 'maybe' }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', statement: '  ' }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', statement: 'x'.repeat(281) }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', source: 'hallway' }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', callId: undefined }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', source: 'manual' }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', initiativeId: '' }))).toBe(400);
    expect(await bad(fromCall({ state: 'waiting', participants: 'u-katya' }))).toBe(400);
    const unknown = await request(app).post('/api/graph/decisions').send(fromCall({ state: 'waiting', participants: ['u-nobody'] }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/u-nobody/);
    expect(decisionEventRows.rows()).toEqual([]);
  });
});
