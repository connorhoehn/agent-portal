// The lab loop in mock mode: signals ride the findings pipeline, experiences
// recall by repo, consults block until answered — and the auth floors hold.

import express from 'express';
import request from '../../test-support/http.js';

// The real authz stack is open-mode permissive in dev (cookie-less callers
// get the demo identity), so the auth-floor assertions here mock it to the
// strict behaviour the deployed configuration has — the same approach as
// environments.test.ts.
jest.mock('../../lib/authz.js', () => ({
  requireSession: () =>
    (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!req.session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      next();
    },
  // Same shape as lib/authz.ts requireTenant: another tenant is 403, admin passes.
  requireTenant: (tenant: string) =>
    (req: { session?: { role?: string; tenant?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!req.session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      if (req.session.tenant !== tenant && req.session.role !== 'admin') { res.status(403).json({ error: 'Forbidden', requiredTenant: tenant }); return; }
      next();
    },
  requireAction: (_action: string) =>
    (req: { session?: { role?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      // sme holds DispatchAgentRun; anonymous holds nothing.
      if (!req.session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
      next();
    },
}));

jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    region: 'us-east-1',
    // Run tokens are signed under the dev session key when no secret ARN is set.
    auth: { sessionSigningSecretArn: '' },
  },
}));

// The run's frozen brief, as the runbook store would return it.
jest.mock('../../lib/runbooks/store-select.js', () => ({
  runbookStore: () => ({
    getBrief: async (runRef: string) => (runRef === 'job-run-1'
      ? { run_ref: 'job-run-1', initiative_id: 'p-auth-migration', repo: 'orgiq-auth-service' } : null),
  }),
}));

import { labRouter } from '../lab.js';
import { mintRunToken, RUN_TOKEN_HEADER } from '../../lib/run-token.js';
import { listExperiences } from '../../providers/lab.js';
import { listFindings } from '../../providers/org-sweeps.js';

function appWith(session: { sub: string; role: string; tenant: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Simulate sessionMiddleware: attach or omit the session, grants included.
    if (session) {
      (req as unknown as { session: unknown }).session = {
        ...session,
        grants: { [session.tenant]: [session.role] },
      };
    }
    next();
  });
  app.use('/api/lab', labRouter);
  return app;
}

const agent = () => appWith(null); // sessionless caller — the microVM
const sme = () => appWith({ sub: 'u-nora', role: 'sme', tenant: 'orgiq' });
const assessor = () => appWith({ sub: 'u-ana', role: 'assessor', tenant: 'assessment' });

describe('the lab is an orgiq surface', () => {
  it('a session from another tenant reads no experiences, consult list or consult, and answers none', async () => {
    const opened = await request(agent()).post('/api/lab/consults').send({ question: 'Which tenant may read me?', repo: 'payments' });
    const id = opened.body.consult.id as string;
    expect((await request(assessor()).get('/api/lab/experiences')).status).toBe(403);
    expect((await request(assessor()).get('/api/lab/consults')).status).toBe(403);
    expect((await request(assessor()).get(`/api/lab/consults/${id}`)).status).toBe(403);
    expect((await request(assessor()).post(`/api/lab/consults/${id}/answer`).send({ answer: 'x' })).status).toBe(403);
    expect((await request(sme()).get(`/api/lab/consults/${id}`)).status).toBe(200);
  });
});

describe('lab signals', () => {
  it('a sessionless agent files a signal and it lands in the findings list', async () => {
    const res = await request(agent()).post('/api/lab/signals').send({
      severity: 'warning',
      title: 'Flaky integration test in payments',
      detail: 'test_settlement_retry fails ~1 in 5 under parallelism',
      repo: 'payments',
      sessionId: 'sess-123',
    });
    expect(res.status).toBe(201);
    expect(res.body.finding.sweep).toBe('lab-signal');
    const open = await listFindings({ status: 'open', sweep: 'lab-signal' });
    expect(open.some((f) => f.title.includes('Flaky integration test'))).toBe(true);
  });

  it('refiling the same issue updates the finding instead of duplicating', async () => {
    const file = () => request(agent()).post('/api/lab/signals').send({
      severity: 'info', title: 'Same issue', repo: 'payments', fingerprint: 'fp-same',
    });
    await file();
    await file();
    const all = await listFindings({ sweep: 'lab-signal' });
    expect(all.filter((f) => f.fingerprint === 'fp-same')).toHaveLength(1);
  });

  it('rejects a signal with no title', async () => {
    const res = await request(agent()).post('/api/lab/signals').send({ severity: 'info' });
    expect(res.status).toBe(400);
  });
});

describe('lab experiences', () => {
  it('records and recalls by repo', async () => {
    await request(agent()).post('/api/lab/experiences').send({
      kind: 'gotcha', title: 'Vite dep cache must be cleared after pin bumps',
      repo: 'portal', tags: ['vite', 'deps'],
    });
    const res = await request(sme()).get('/api/lab/experiences?repo=portal');
    expect(res.status).toBe(200);
    expect(res.body.experiences.some((e: { title: string }) => e.title.includes('Vite dep cache'))).toBe(true);
    const other = await request(sme()).get('/api/lab/experiences?repo=elsewhere');
    expect(other.body.experiences).toHaveLength(0);
  });

  it('rejects an unknown kind', async () => {
    const res = await request(agent()).post('/api/lab/experiences').send({ kind: 'vibes', title: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('lab consults', () => {
  it('agent opens, human answers, agent polls the answer back', async () => {
    const opened = await request(agent()).post('/api/lab/consults').send({
      question: 'Delete the legacy migration or keep it behind a flag?',
      context: 'migrations/0042 references a dropped table',
      repo: 'payments',
    });
    expect(opened.status).toBe(201);
    const id = opened.body.consult.id as string;

    // Pending while unanswered.
    const pending = await request(agent()).get(`/api/lab/consults/${id}`);
    expect(pending.body.consult.status).toBe('pending');

    // SME answers (DispatchAgentRun holder).
    const answered = await request(sme()).post(`/api/lab/consults/${id}/answer`).send({
      answer: 'Keep it behind a flag until the next release train.',
    });
    expect(answered.status).toBe(200);
    expect(answered.body.consult.answeredBy).toBe('u-nora');

    // The poller sees the answer.
    const polled = await request(agent()).get(`/api/lab/consults/${id}`);
    expect(polled.body.consult.status).toBe('answered');
    expect(polled.body.consult.answer).toContain('flag');

    // Answering twice conflicts.
    const again = await request(sme()).post(`/api/lab/consults/${id}/answer`).send({ answer: 'no' });
    expect(again.status).toBe(409);
  });

  it('the human list requires a session; the agent poll does not', async () => {
    const anon = await request(agent()).get('/api/lab/consults');
    expect(anon.status).toBe(401);
    const listed = await request(sme()).get('/api/lab/consults?status=pending');
    expect(listed.status).toBe(200);
  });

  it('answering requires DispatchAgentRun — an anonymous caller cannot', async () => {
    const opened = await request(agent()).post('/api/lab/consults').send({ question: 'q?' });
    const id = opened.body.consult.id as string;
    const res = await request(agent()).post(`/api/lab/consults/${id}/answer`).send({ answer: 'a' });
    expect([401, 403]).toContain(res.status);
  });

  it('service secret locks the callback routes when set', async () => {
    process.env['LAB_CALLBACK_SECRET'] = 's3cret';
    try {
      const denied = await request(agent()).post('/api/lab/signals').send({ title: 'x' });
      expect(denied.status).toBe(401);
      const allowed = await request(agent()).post('/api/lab/signals')
        .set('x-lab-auth', 's3cret').send({ title: 'x' });
      expect(allowed.status).toBe(201);
    } finally {
      delete process.env['LAB_CALLBACK_SECRET'];
    }
  });
});

describe('where a callback is filed (DE-44 row 28)', () => {
  it('ignores a body-supplied initiative when the box sends no run token: files unattributed', async () => {
    const res = await request(agent()).post('/api/lab/experiences').send({
      kind: 'gotcha', title: 'Claims to be on billing', repo: 'payments', initiativeId: 'p-billing',
    });
    expect(res.status).toBe(201);
    expect(res.body.experience.initiativeId ?? null).toBeNull();
  });

  it('files under the initiative and repo of the run the token names, whatever the body says', async () => {
    const token = await mintRunToken('job-run-1');
    const res = await request(agent()).post('/api/lab/signals').set(RUN_TOKEN_HEADER, token).send({
      severity: 'info', title: 'Run-bound signal', repo: 'payments', initiativeId: 'p-billing',
    });
    expect(res.status).toBe(201);
    expect(res.body.finding.initiativeId ?? res.body.finding.evidence?.initiativeId).toBe('p-auth-migration');
    const exp = await request(agent()).post('/api/lab/experiences').set(RUN_TOKEN_HEADER, token).send({
      kind: 'gotcha', title: 'Run-bound lesson', repo: 'payments', initiativeId: 'p-billing',
    });
    expect(exp.body.experience).toMatchObject({ initiativeId: 'p-auth-migration', repo: 'orgiq-auth-service' });
    expect((await listExperiences({ repo: 'orgiq-auth-service' })).some((e) => e.title === 'Run-bound lesson')).toBe(true);
  });

  it('refuses a run token that does not verify', async () => {
    const forged = `${Buffer.from(JSON.stringify({ k: 'lab-run', v: 1, r: 'job-run-1' })).toString('base64url')}.forged`;
    const res = await request(agent()).post('/api/lab/consults').set(RUN_TOKEN_HEADER, forged).send({ question: 'May I?' });
    expect(res.status).toBe(403);
  });
});

describe('answering a consult steers its run (DE-44 row 29)', () => {
  it('only someone on the consult\'s initiative may answer it', async () => {
    const token = await mintRunToken('job-run-1');
    const opened = await request(agent()).post('/api/lab/consults').set(RUN_TOKEN_HEADER, token).send({ question: 'Ship the cookie change?' });
    const id = opened.body.consult.id as string;
    // An SME attached to nothing is refused; Nora contributes to Auth Migration.
    const stranger = appWith({ sub: 'u-nobody', role: 'sme', tenant: 'orgiq' });
    expect((await request(stranger).post(`/api/lab/consults/${id}/answer`).send({ answer: 'yes' })).status).toBe(403);
    const ok = await request(sme()).post(`/api/lab/consults/${id}/answer`).send({ answer: 'yes, ship it' });
    expect(ok.status).toBe(200);
    expect(ok.body.consult.answer).toBe('yes, ship it');
  });
});
