// POST /api/graph/decisions/:id/decide (G54): a waiting decision is decided,
// on the page and by voice (both call this route).
//
// The REAL authz stack runs (the seed Cedar matrix, no policy store), so the
// DecideDecision floor is the actual role matrix; identity and the initiative
// owner are mocked so each persona's relation to the decision is explicit.
// The owner's acceptance case is d-eval-judge-model ("Judge model for canary
// evaluation", open, on p-llm-platform, decider p-047 Nina Rivera, who also
// owns the initiative).

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn(), fetchAvatarsById: jest.fn(async () => new Map()) }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
// sub -> [person, display name]
const PEOPLE: Record<string, [string | null, string]> = {
  'u-nina': ['p-047', 'Nina Rivera'],     // d-eval-judge-model's decider (and p-llm-platform's owner)
  'u-nora': ['p-004', 'Nora DaSilva'],    // an SME with no part in that decision
  'u-sienna': ['p-005', 'Sienna Garcia'], // d-cognito-cutover's decider
  'u-vera': ['p-002', 'Vera Green'],      // p-auth-migration's owner, not d-cognito-cutover's decider
  'u-rhea': ['p-042', 'Rhea'],            // a contributor on d-eval-judge-model
  'u-ops': [null, 'Platform Operator'],   // an account with no person
};
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => {
    const hit = PEOPLE[sub];
    return hit ? { id: sub, personId: hit[0], displayName: hit[1] } : null;
  }),
}));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => ({ 'p-llm-platform': { id, ownerId: 'p-047' }, 'p-auth-migration': { id, ownerId: 'p-002' } } as Record<string, unknown>)[id] ?? null),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { decisionsRouter } from '../decisions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { decisionRows, decisionEventRows } from '../../mock/decisions.js';
import { exec } from '../../providers/aurora.js';
import { decideDecision } from '../../providers/decisions.js';

const execMock = exec as unknown as jest.Mock;
const JUDGE = '/api/graph/decisions/d-eval-judge-model';
const RATIONALE = 'Go with Nova Pro and halve the sample rate from 20 to 10 percent, so the evaluation bill stays flat.';

function appAs(sub: string | null, role = 'member', name?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sub) (req as unknown as { session: unknown }).session = { sub, role, tenant: 'orgiq', grants: { orgiq: [role] }, iat: 0, ...(name ? { name } : {}) };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true;
    next();
  });
  app.use('/api/graph/decisions', decisionsRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  fixtureRegistry.resetAll('default');
  execMock.mockReset();
});

describe('POST /api/graph/decisions/:id/decide', () => {
  it('the cookie-less demo identity may decide under the dev flag (the demo stays explorable)', async () => {
    expect((await request(appAs('demo-user', 'sme')).get(JUDGE)).body.viewerMayDecide).toBe(true);
    const res = await request(appAs('demo-user', 'sme', 'Demo User')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    // Walk, 9 November: never "Decided by demo-user". No app user row, so the session's own name is recorded.
    expect(res.body.decidedBy).toEqual({ id: 'demo-user', name: 'Demo User' });
    expect(res.body.history[0].by).toEqual({ id: 'demo-user', name: 'Demo User' });
  });

  it('a decider known only by an account id reads as "you" to themselves and as the id to anyone else', async () => {
    const res = await request(appAs('u-ghost', 'org-leader')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE });
    expect(res.status).toBe(200);
    expect(res.body.decidedBy).toEqual({ id: 'u-ghost', name: 'you' });
    expect(res.body.history[0].by).toEqual({ id: 'u-ghost', name: 'you' });
    const other = await request(appAs('u-nora', 'sme')).get(JUDGE);
    expect(other.body.decidedBy).toEqual({ id: 'u-ghost', name: 'u-ghost' });
    // The stored rows keep the id: "you" is presentation, per viewer.
    expect(decisionEventRows.rows()[0]).toEqual(expect.objectContaining({ actorId: 'u-ghost', actorName: 'u-ghost' }));
  });

  it('the decider resolves the waiting judge-model decision: status, who, when, the rationale as the outcome, and a history entry', async () => {
    const before = await request(appAs('u-nina', 'sme')).get(JUDGE);
    expect(before.body).toEqual(expect.objectContaining({ status: 'open', decidedAt: null, decidedBy: null, outcome: null, history: [], viewerMayDecide: true }));

    const res = await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: `  ${RATIONALE}  ` });
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    const today = new Date().toISOString().slice(0, 10);
    // The instant, not the day (a day read as noon UTC printed "Decided in 8h").
    const instant = new RegExp(`^${today}T\\d{2}:\\d{2}:\\d{2}`);
    expect(res.body).toEqual(expect.objectContaining({
      id: 'd-eval-judge-model', status: 'resolved', decidedAt: expect.stringMatching(instant),
      decidedBy: { id: 'p-047', name: 'Nina Rivera' }, outcome: RATIONALE,
    }));
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toEqual(expect.objectContaining({
      kind: 'resolved', by: { id: 'p-047', name: 'Nina Rivera' }, rationale: RATIONALE,
    }));
    expect(Date.parse(res.body.history[0].at)).not.toBeNaN();

    // The next read is the record the page shows, and the list's Waiting view loses it.
    const after = await request(appAs('u-nora', 'sme')).get(JUDGE);
    expect(after.body).toEqual(expect.objectContaining({ status: 'resolved', outcome: RATIONALE, viewerMayDecide: false }));
    const list = await request(appAs('u-nora', 'sme')).get('/api/graph/decisions?limit=200');
    const row = list.body.find((d: { id: string }) => d.id === 'd-eval-judge-model');
    expect(row.status).toBe('resolved');
    expect(row.decidedAt).toMatch(instant);
    expect(row.outcome).toBe(RATIONALE);
  });

  it('writes the mock store: the decision row and one decision_events row', async () => {
    await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ outcome: 'rejected', rationale: 'Neither model; rerun the rubric first.' });
    const row = decisionRows.rows().find((d) => d.id === 'd-eval-judge-model')!;
    expect(row).toEqual(expect.objectContaining({ status: 'rejected', decidedBy: 'p-047', resolution: 'Neither model; rerun the rubric first.' }));
    expect(decisionEventRows.rows()).toEqual([expect.objectContaining({ decisionId: 'd-eval-judge-model', kind: 'rejected', actorId: 'p-047', actorName: 'Nina Rivera' })]);
  });

  it('a non-decider is refused with 403 NOT_DECIDER and nothing is written', async () => {
    for (const sub of ['u-nora', 'u-rhea', 'u-ops']) {
      const res = await request(appAs(sub, 'sme')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_DECIDER');
    }
    expect(decisionRows.rows().find((d) => d.id === 'd-eval-judge-model')!.status).toBe('open');
    expect(decisionEventRows.rows()).toEqual([]);
    // A role without the Cedar floor never reaches the scope check (the social tenant's participant holds none of it).
    const outsider = await request(appAs('u-nina', 'participant')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE });
    expect(outsider.status).toBe(403);
    expect(outsider.body.action).toBe('DecideDecision');
    // Anonymous: 401.
    expect((await request(appAs(null)).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE })).status).toBe(401);
  });

  it('the initiative\'s owner and an org-leader may decide what they are not the decider of', async () => {
    // d-cognito-cutover (escalated): decided by Sienna; Vera owns Auth Migration.
    const owner = await request(appAs('u-vera', 'member')).post('/api/graph/decisions/d-cognito-cutover/decide').send({ outcome: 'resolved', rationale: 'Riskiest first while the shim is warm.' });
    expect(owner.status).toBe(200);
    expect(owner.body.decidedBy).toEqual({ id: 'p-002', name: 'Vera Green' });
    const leader = await request(appAs('u-nora', 'org-leader')).post('/api/graph/decisions/d-inference-warm-floor/decide').send({ outcome: 'rejected', rationale: 'Not until the SLO owners agree.' });
    expect(leader.status).toBe(200);
    expect(leader.body.status).toBe('rejected');
  });

  it('a settled decision is 409 and keeps its record', async () => {
    const first = await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: RATIONALE });
    expect(first.status).toBe(200);
    const again = await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ outcome: 'rejected', rationale: 'Changed my mind.' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual(expect.objectContaining({ status: 'resolved' }));
    expect(decisionEventRows.rows()).toHaveLength(1);
    // A seeded settled ADR, too.
    const adr = await request(appAs('u-nora', 'org-leader')).post('/api/graph/decisions/d-aurora/decide').send({ outcome: 'rejected', rationale: 'x' });
    expect(adr.status).toBe(409);
  });

  it('validates the outcome and the rationale (required, at most 500 characters); an unknown id is 404', async () => {
    const app = appAs('u-nina', 'sme');
    expect((await request(app).post(`${JUDGE}/decide`).send({ outcome: 'approve', rationale: RATIONALE })).status).toBe(400);
    expect((await request(app).post(`${JUDGE}/decide`).send({ outcome: 'resolved' })).status).toBe(400);
    expect((await request(app).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: '   ' })).status).toBe(400);
    const long = await request(app).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/500/);
    expect((await request(app).post(`${JUDGE}/decide`).send({ outcome: 'resolved', rationale: 'x'.repeat(500) })).status).toBe(200);
    expect((await request(appAs('u-nina', 'sme')).post('/api/graph/decisions/d-nope/decide').send({ outcome: 'resolved', rationale: RATIONALE })).status).toBe(404);
  });
});

describe('POST /api/graph/decisions/:id/decide with an option (G57)', () => {
  it('the detail lists the waiting decision\'s options in order; a settled one offers none', async () => {
    const judge = await request(appAs('u-nina', 'sme')).get(JUDGE);
    expect(judge.body.options).toEqual([
      { id: 'nova-pro-10', label: 'Nova Pro, sample rate halved to 10%', detail: '82 percent agreement with human labels, at the current spend.' },
      { id: 'nova-lite-20', label: 'Nova Lite at the current 20% sample rate', detail: '71 percent agreement, at about a sixth of the cost per judged answer.' },
    ]);
    const cutover = await request(appAs('u-sienna', 'member')).get('/api/graph/decisions/d-cognito-cutover');
    expect(cutover.body.options.map((o: { label: string }) => o.label)).toEqual(['Smallest tenants first', 'Riskiest two tenants first']);
    const warm = await request(appAs('u-nora', 'sme')).get('/api/graph/decisions/d-inference-warm-floor');
    expect(warm.body.options).toHaveLength(3);
    const adr = await request(appAs('u-nora', 'sme')).get('/api/graph/decisions/d-aurora');
    expect(adr.body.options).toEqual([]);
  });

  it('an option with no rationale records its label as the outcome', async () => {
    const res = await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ optionId: 'nova-pro-10', outcome: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'resolved', outcome: 'Nova Pro, sample rate halved to 10%' }));
    expect(res.body.history[0]).toEqual(expect.objectContaining({ kind: 'resolved', rationale: 'Nova Pro, sample rate halved to 10%' }));
  });

  it('an option with a rationale records "<label>, because <rationale>" (a said "because" is not doubled)', async () => {
    const res = await request(appAs('u-sienna', 'member')).post('/api/graph/decisions/d-cognito-cutover/decide')
      .send({ optionId: 'riskiest-first', outcome: 'resolved', rationale: '  because rollback is still a route flip ' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('Riskiest two tenants first, because rollback is still a route flip');
    expect(decisionRows.rows().find((d) => d.id === 'd-cognito-cutover')!.resolution).toBe('Riskiest two tenants first, because rollback is still a route flip');
  });

  it('an option the decision does not offer, an option with reject, or a non-string option is a 400 and writes nothing', async () => {
    const app = appAs('u-nina', 'sme');
    const unknown = await request(app).post(`${JUDGE}/decide`).send({ optionId: 'smallest-first', outcome: 'resolved' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/offers no option/);
    const rejecting = await request(app).post(`${JUDGE}/decide`).send({ optionId: 'nova-pro-10', outcome: 'rejected', rationale: 'No.' });
    expect(rejecting.status).toBe(400);
    expect((await request(app).post(`${JUDGE}/decide`).send({ optionId: 2, outcome: 'resolved' })).status).toBe(400);
    expect((await request(app).post(`${JUDGE}/decide`).send({ optionId: '  ', outcome: 'resolved' })).status).toBe(400);
    expect((await request(app).post(`${JUDGE}/decide`).send({ optionId: 'nova-pro-10', outcome: 'resolved', rationale: 'x'.repeat(501) })).status).toBe(400);
    expect(decisionRows.rows().find((d) => d.id === 'd-eval-judge-model')!.status).toBe('open');
    expect(decisionEventRows.rows()).toEqual([]);
  });

  it('without an option the rationale is still required; a rejection needs no option', async () => {
    const app = appAs('u-nina', 'sme');
    const bare = await request(app).post(`${JUDGE}/decide`).send({ outcome: 'resolved' });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/rationale is required/);
    expect((await request(app).post(`${JUDGE}/decide`).send({ outcome: 'rejected' })).status).toBe(400);
    const rejected = await request(app).post(`${JUDGE}/decide`).send({ outcome: 'rejected', rationale: 'Rerun the rubric first.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.outcome).toBe('Rerun the rubric first.');
  });

  it('403 and 409 hold with an option, as without one', async () => {
    const stranger = await request(appAs('u-nora', 'sme')).post(`${JUDGE}/decide`).send({ optionId: 'nova-pro-10', outcome: 'resolved' });
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('NOT_DECIDER');
    expect((await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ optionId: 'nova-pro-10', outcome: 'resolved' })).status).toBe(200);
    const again = await request(appAs('u-nina', 'sme')).post(`${JUDGE}/decide`).send({ optionId: 'nova-lite-20', outcome: 'resolved' });
    expect(again.status).toBe(409);
    expect(decisionEventRows.rows()).toHaveLength(1);
  });
});

describe('the Aurora provider', () => {
  it('updates only a waiting row and appends its event in one transaction; a lost race reads back as settled', async () => {
    const config = jest.requireMock('../../config.js').config as { mock: { aurora: boolean } };
    const aurora = jest.requireMock('../../providers/aurora.js') as { exec: jest.Mock; withTransaction: jest.Mock };
    config.mock.aurora = false;
    try {
      const tx = jest.fn()
        .mockResolvedValueOnce([{ id: 'd-x' }]) // UPDATE … RETURNING id
        .mockResolvedValueOnce([]);             // INSERT INTO decision_events
      aurora.withTransaction.mockImplementation(async (fn: (t: jest.Mock) => Promise<unknown>) => fn(tx));
      aurora.exec
        .mockResolvedValueOnce([{ id: 'd-x', topic: 'T', summary: null, status: 'resolved', project_id: null, decided_at: '2026-11-09', resolution: 'Why', decided_by: 'p-047', decided_by_name: 'Nina Rivera',
          options: '[{"id":"a","label":"Option A","detail":"why A"},{"id":"","label":"dropped"},{"label":"no id"}]' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '1', kind: 'resolved', at: '2026-11-09T01:00:00Z', actor_id: 'p-047', actor_name: 'Nina Rivera', rationale: 'Why' }]);
      const ok = await decideDecision('d-x', { outcome: 'resolved', rationale: 'Why', actorId: 'p-047', actorName: 'Nina Rivera' });
      expect(String(tx.mock.calls[0]![0])).toMatch(/UPDATE decisions[\s\S]*status IN \('open', 'escalated'\)/);
      expect(String(tx.mock.calls[1]![0])).toMatch(/INSERT INTO decision_events/);
      expect(ok).toEqual({ kind: 'ok', decision: expect.objectContaining({ decidedBy: { id: 'p-047', name: 'Nina Rivera' }, outcome: 'Why', history: [expect.objectContaining({ kind: 'resolved', rationale: 'Why' })] }) });
      // The record reads the instant (`resolved_at`) over the DATE column's day.
      expect(String(aurora.exec.mock.calls[0]![0])).toMatch(/COALESCE\(to_char\(d\.resolved_at AT TIME ZONE 'UTC'[\s\S]*d\.decided_at::text\) AS decided_at/);
      // G57: the jsonb options column, read as text; malformed entries are dropped, never invented.
      expect(ok.kind === 'ok' && ok.decision.options).toEqual([{ id: 'a', label: 'Option A', detail: 'why A' }]);

      const lost = jest.fn().mockResolvedValueOnce([]);
      aurora.withTransaction.mockImplementation(async (fn: (t: jest.Mock) => Promise<unknown>) => fn(lost));
      aurora.exec.mockReset().mockResolvedValueOnce([{ status: 'rejected' }]);
      expect(await decideDecision('d-x', { outcome: 'resolved', rationale: 'Why', actorId: 'p-047', actorName: 'Nina' })).toEqual({ kind: 'settled', status: 'rejected' });
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      config.mock.aurora = true;
    }
  });
});
