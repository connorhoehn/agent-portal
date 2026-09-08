// The SME's journey across the Work page, end to end in mock mode:
//
//   suggestions → queue a job from one → the job says what it serves
//
// Deliberately NOT mocked: work-items, projects, identity and the job queue
// all run their real `config.mock.aurora` paths. The complaint that started
// this ("it's not intuitive what queue a job means in regards to the projects
// the user is working on") was about `dev:mock`, and every link in the chain
// had a hole only visible with the real fixtures in place — an SME saw zero
// suggestions because the ranker spoke a status vocabulary the board does not
// use, and enqueueing answered 503 because the queue had no mock path at all.
// Mocking the providers here would have preserved both.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } },
}));

// Cedar is not the subject: ManageDevbox is granted to `sme` role-wide, and
// the interesting scoping happens after it.
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';

interface Suggestion {
  id: string; kind: string; title: string; reason: string; prompt: string;
  initiativeId: string; initiativeName: string; workItemId: string;
  storyPoints: number | null; estimatedCostUsd: number | null;
}

interface Job {
  id: string; title: string; status: string;
  payload: {
    prompt?: string; workItemId?: string; workItemTitle?: string;
    initiativeId?: string; initiativeName?: string;
  };
}

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/work', workRouter);
  app.use(errorHandler);
  return app;
}

// Nora DaSilva: `u-nora` → person p-004, who owns p-observability and is an
// SME on p-auth-migration (providers/projects.ts, mirroring seed_program.sql).
const nora = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const leader = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' };
/** Layla is an SME on p-observability but is on no other initiative Nora is. */
const layla = { sub: 'u-layla', role: 'sme', tenant: 'orgiq' };

const NORAS_INITIATIVES = ['p-observability', 'p-auth-migration'];

describe('GET /api/work/suggestions', () => {
  it('offers an SME work drawn from her own initiatives', async () => {
    const res = await request(buildApp(nora)).get('/api/work/suggestions');
    expect(res.status).toBe(200);
    const suggestions = res.body.suggestions as Suggestion[];

    // The bug this pins: the strip was empty for every SME, because the
    // ranker matched statuses (`blocked`, `todo`) the board never stores.
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(4);
    for (const s of suggestions) {
      expect(NORAS_INITIATIVES).toContain(s.initiativeId);
    }
  });

  it('offers something from each of her initiatives, not four from one', async () => {
    const res = await request(buildApp(nora)).get('/api/work/suggestions');
    const initiatives = new Set((res.body.suggestions as Suggestion[]).map((s) => s.initiativeId));
    expect(initiatives.size).toBeGreaterThan(1);
  });

  it('reads what is blocked and what is in review, not just what is unstarted', async () => {
    const res = await request(buildApp(nora)).get('/api/work/suggestions');
    const kinds = new Set((res.body.suggestions as Suggestion[]).map((s) => s.kind));
    // Blocked is carried as a label and review is a real status; both have to
    // survive the trip from the board through the ranker.
    expect([...kinds].some((k) => k === 'blocked' || k === 'in-review')).toBe(true);
  });

  it('ships a prompt that can be run without rewriting it', async () => {
    const res = await request(buildApp(nora)).get('/api/work/suggestions');
    for (const s of res.body.suggestions as Suggestion[]) {
      expect(s.prompt).toContain(s.title);
      expect(s.prompt.length).toBeGreaterThan(80);
      expect(s.id).toBe(`sg-${s.workItemId}`);
    }
  });

  it('scopes per person: another SME gets her own initiatives, not Nora’s', async () => {
    const res = await request(buildApp(layla)).get('/api/work/suggestions');
    expect(res.status).toBe(200);
    // Layla contributes to p-observability and p-cost-opt; nothing of hers may
    // come from Auth Migration, which she is not attached to.
    for (const s of res.body.suggestions as Suggestion[]) {
      expect(s.initiativeId).not.toBe('p-auth-migration');
    }
  });

  it('gives the release manager the whole program, not one initiative', async () => {
    const res = await request(buildApp(leader)).get('/api/work/suggestions');
    expect(res.status).toBe(200);
    const initiatives = (res.body.suggestions as Suggestion[]).map((s) => s.initiativeId);
    expect(initiatives.some((id) => !NORAS_INITIATIVES.includes(id))).toBe(true);
  });

  it('offers nothing to a caller with no linked person and no org-wide role', async () => {
    // An unresolvable caller resolves to "attached to nothing" — the same
    // conservative answer stewardsInitiative gives an authorization gate.
    const res = await request(buildApp({ sub: 'u-nobody', role: 'sme', tenant: 'orgiq' }))
      .get('/api/work/suggestions');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });
});

describe('POST /api/work/jobs — what the job serves', () => {
  it('resolves a suggestion id to the work item and the initiative it moves', async () => {
    const app = buildApp(nora);
    const [first] = (await request(app).get('/api/work/suggestions')).body.suggestions as Suggestion[];
    expect(first).toBeDefined();

    const res = await request(app).post('/api/work/jobs').send({
      title: first!.title, prompt: first!.prompt, suggestionId: first!.id,
    });
    expect(res.status).toBe(201);
    const job = res.body as Job;

    // The client sent a card id; the server stored the durable fact, and the
    // initiative came from the board rather than from the request.
    expect(job.payload.workItemId).toBe(first!.workItemId);
    expect(job.payload.workItemTitle).toBe(first!.title);
    expect(job.payload.initiativeId).toBe(first!.initiativeId);
    expect(job.payload.initiativeName).toBe(first!.initiativeName);
  });

  it('takes a work item id directly — the canonical field', async () => {
    const res = await request(buildApp(nora)).post('/api/work/jobs').send({
      title: 'Finish the burn-rate alerts',
      prompt: 'Read the open PR and say what is left before it can merge.',
      workItemId: 'wi-obs-e2-s2',
    });
    expect(res.status).toBe(201);
    expect((res.body as Job).payload).toMatchObject({
      workItemId: 'wi-obs-e2-s2',
      workItemTitle: 'Multi-window burn-rate alerts (fast + slow burn)',
      initiativeId: 'p-observability',
      initiativeName: 'Observability Platform',
    });
  });

  it('queues a free-typed prompt with no attribution rather than inventing one', async () => {
    const res = await request(buildApp(nora)).post('/api/work/jobs').send({
      title: 'Poke at the collector config', prompt: 'Have a look at the collector config.',
    });
    expect(res.status).toBe(201);
    expect((res.body as Job).payload.workItemId).toBeUndefined();
  });

  it('runs the job anyway when the attribution is stale', async () => {
    // A card can outlive the item it names. Refusing to dispatch real work
    // over a dangling reference would be the wrong trade.
    const res = await request(buildApp(nora)).post('/api/work/jobs').send({
      title: 'Something', prompt: 'Do the thing.', suggestionId: 'sg-wi-does-not-exist',
    });
    expect(res.status).toBe(201);
    expect((res.body as Job).payload.workItemId).toBeUndefined();
  });

  it('carries the link through to the queue the page reads', async () => {
    const app = buildApp(nora);
    const created = (await request(app).post('/api/work/jobs').send({
      title: 'Unblock the cutover runbook',
      prompt: 'Work out what the runbook is waiting on.',
      workItemId: 'wi-auth-e2-s2',
    })).body as Job;

    const listed = ((await request(app).get('/api/work/jobs?limit=50')).body.jobs as Job[])
      .find((j) => j.id === created.id);
    expect(listed).toBeDefined();
    expect(listed!.payload).toMatchObject({
      workItemId: 'wi-auth-e2-s2', initiativeName: 'Auth Migration',
    });

    // And the detail route the queue row links to says the same thing.
    const detail = (await request(app).get(`/api/work/jobs/${created.id}`)).body as Job;
    expect(detail.payload.workItemId).toBe('wi-auth-e2-s2');
  });
});
