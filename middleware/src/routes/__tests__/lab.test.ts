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
  },
}));

import { labRouter } from '../lab.js';
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
