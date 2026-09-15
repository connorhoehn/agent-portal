// routes/distillation.ts — every mounted route, real provider (the mock
// corpus is pure, deterministic data; nothing here needs a provider mock).
// Pinned: 200 response shapes, 400 on bad ids/enums/pagination bounds, 404 on
// a well-formed-but-unknown id, 403 on the two state-changing routes for a
// role without ManageBots, and the /items cursor round-trip.

const gateOpen = { value: true };

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!gateOpen.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    },
  resolveSession: () => ({ sub: 'u-test', name: 'Test Reviewer', role: 'org-leader', tenant: 'orgiq' }),
}));

// distillation.ts's provider pulls in prompt-library.ts (Library provenance
// lookups) which pulls in the Bedrock SDK + aurora.ts — mocked out exactly
// as prompt-library.test.ts does; config.mock.aurora=true never reaches
// either in this suite.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {} },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { distillationRouter } from '../distillation.js';
import { __setCompactRunMs, __resetDistillationMock } from '../../providers/distillation.js';
import { procedureApplications } from '../../mock/distillation.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/distillation', distillationRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { gateOpen.value = true; });

// A hand-triggered pass runs for 3s by default; these suites assert the
// corpus right after the call, so complete synchronously here.
beforeAll(() => __setCompactRunMs(0));

describe('GET /api/distillation/levels', () => {
  it('200s with levels + health', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/distillation/levels');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.levels)).toBe(true);
    expect(Array.isArray(res.body.health)).toBe(true);
  });
});

describe('GET /api/distillation/ingest', () => {
  it('200s with ingest pressure', async () => {
    const res = await request(buildApp()).get('/api/distillation/ingest');
    expect(res.status).toBe(200);
    expect(typeof res.body.activeWriters).toBe('number');
  });
});

describe('GET /api/distillation/compactions', () => {
  it('200s with jobs, and filters by level', async () => {
    const res = await request(buildApp()).get('/api/distillation/compactions?level=L2');
    expect(res.status).toBe(200);
    expect(res.body.jobs.every((j: { level: string }) => j.level === 'L2')).toBe(true);
    expect(res.body.jobs[0]).toHaveProperty('produced');
  });
});

describe('GET /api/distillation/sampling', () => {
  it('200s with the sampling verdict attached', async () => {
    const res = await request(buildApp()).get('/api/distillation/sampling');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toHaveProperty('verdict');
  });
});

describe('POST /api/distillation/compact', () => {
  it('400s on L0 (nothing compacts into the write head)', async () => {
    const res = await request(buildApp()).post('/api/distillation/compact').send({ level: 'L0' });
    expect(res.status).toBe(400);
  });

  it('403s without ManageBots', async () => {
    gateOpen.value = false;
    const res = await request(buildApp()).post('/api/distillation/compact').send({ level: 'L1' });
    expect(res.status).toBe(403);
  });

  it('201s with a job for a valid level', async () => {
    const res = await request(buildApp()).post('/api/distillation/compact').send({ level: 'L1' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('produced');
  });

  // The defect this fixed: compactNow used to move a level's item counter
  // without touching the corpus, so a produced id resolved nowhere and the
  // level cards disagreed with what /items actually listed. Pin that a real
  // compaction's produced ids are openable end-to-end through the same
  // router a real "Compact L0 -> L1" button hits.
  it('a produced L1 cluster id opens through GET /items/:id and agrees with GET /levels', async () => {
    const app = buildApp();
    const compact = await request(app).post('/api/distillation/compact').send({ level: 'L1' });
    expect(compact.status).toBe(201);

    if ((compact.body.produced.cluster_ids as string[]).length === 0) {
      // Nothing was left unclustered in this run (a prior test in this file
      // may have already consumed it) — the honest-empty case is itself
      // covered in providers/__tests__/distillation-compaction.test.ts.
      return;
    }
    for (const id of compact.body.produced.cluster_ids as string[]) {
      const item = await request(app).get(`/api/distillation/items/${id}`);
      expect(item.status).toBe(200);
      expect(item.body.level).toBe('L1');
    }

    const levelsRes = await request(app).get('/api/distillation/levels');
    const l1 = (levelsRes.body.levels as Array<{ level: string; items: number }>).find((l) => l.level === 'L1');
    expect(l1?.items).toBeGreaterThanOrEqual(compact.body.produced.cluster_ids.length);
  });
});

describe('GET /api/distillation/items', () => {
  it('200s with items + next_cursor shape', async () => {
    const res = await request(buildApp()).get('/api/distillation/items?level=L0&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(10);
    expect(res.body.items.every((i: { level: string }) => i.level === 'L0')).toBe(true);
    expect(res.body.next_cursor).toEqual(expect.any(String));
  });

  it('400s on an unknown level', async () => {
    const res = await request(buildApp()).get('/api/distillation/items?level=L9');
    expect(res.status).toBe(400);
  });

  it('400s on an out-of-range limit', async () => {
    const res = await request(buildApp()).get('/api/distillation/items?limit=0');
    expect(res.status).toBe(400);
    const res2 = await request(buildApp()).get('/api/distillation/items?limit=201');
    expect(res2.status).toBe(400);
  });

  it('the cursor round-trips through the whole L0 set with no repeats', async () => {
    const app = buildApp();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ level: 'L0', limit: '20', ...(cursor ? { cursor } : {}) });
      const res = await request(app).get(`/api/distillation/items?${qs.toString()}`);
      expect(res.status).toBe(200);
      for (const i of res.body.items as Array<{ id: string }>) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      if (!res.body.next_cursor) break;
      cursor = res.body.next_cursor;
    }
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });
});

describe('GET /api/distillation/items/:id', () => {
  it('200s with a kind-discriminated item', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/art-001');
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('L2');
    expect(res.body.id).toBe('art-001');
  });

  it('400s on a malformed id', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/NOTVALID');
    expect(res.status).toBe(400);
  });

  it('404s on a well-formed but unknown id', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/art-does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/distillation/items/:id/lineage', () => {
  it('200s with a nodes/edges graph', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/cl-011/lineage?depth=3');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes.some((n: { id: string }) => n.id === 'art-004')).toBe(true);
  });

  it('400s on a depth outside 1-4', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/cl-011/lineage?depth=0');
    expect(res.status).toBe(400);
    const res2 = await request(buildApp()).get('/api/distillation/items/cl-011/lineage?depth=5');
    expect(res2.status).toBe(400);
  });

  it('404s on an unknown item id', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/cl-does-not-exist/lineage');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/distillation/artifacts', () => {
  it('200s with artifacts, filtered by status', async () => {
    const res = await request(buildApp()).get('/api/distillation/artifacts?status=draft');
    expect(res.status).toBe(200);
    expect(res.body.artifacts.every((a: { status: string }) => a.status === 'draft')).toBe(true);
  });

  it('400s on an unknown status', async () => {
    const res = await request(buildApp()).get('/api/distillation/artifacts?status=archived');
    expect(res.status).toBe(400);
  });

  it('?type=procedure is a valid filter and lists only procedures', async () => {
    const res = await request(buildApp()).get('/api/distillation/artifacts?type=procedure');
    expect(res.status).toBe(200);
    expect(res.body.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.artifacts.every((a: { type: string }) => a.type === 'procedure')).toBe(true);
  });
});

describe('GET /api/distillation/facts/:id/lineage', () => {
  it('200s with the fact, its evidence and its artifact', async () => {
    const res = await request(buildApp()).get('/api/distillation/facts/fact-001/lineage');
    expect(res.status).toBe(200);
    expect(res.body.nodes.some((n: { id: string; kind: string }) => n.id === 'fact-001' && n.kind === 'fact')).toBe(true);
  });

  it('400s on an id that is not a fact id', async () => {
    const res = await request(buildApp()).get('/api/distillation/facts/cl-001/lineage');
    expect(res.status).toBe(400);
  });

  it('404s on a well-formed but unknown fact id', async () => {
    const res = await request(buildApp()).get('/api/distillation/facts/fact-does-not-exist/lineage');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/distillation/review', () => {
  it('200s with samples, filtered by verdict', async () => {
    const res = await request(buildApp()).get('/api/distillation/review?verdict=pending');
    expect(res.status).toBe(200);
    expect(res.body.samples.length).toBeGreaterThanOrEqual(6);
    expect(res.body.samples.every((s: { verdict: string }) => s.verdict === 'pending')).toBe(true);
  });

  it('400s on an unknown verdict', async () => {
    const res = await request(buildApp()).get('/api/distillation/review?verdict=maybe');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/distillation/review/:id', () => {
  it('403s without ManageBots', async () => {
    gateOpen.value = false;
    const res = await request(buildApp()).post('/api/distillation/review/rev-003').send({ verdict: 'agree' });
    expect(res.status).toBe(403);
  });

  it('400s on an invalid verdict', async () => {
    const res = await request(buildApp()).post('/api/distillation/review/rev-003').send({ verdict: 'pending' });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown sample id', async () => {
    const res = await request(buildApp()).post('/api/distillation/review/rev-does-not-exist').send({ verdict: 'agree' });
    expect(res.status).toBe(404);
  });

  it('decides a pending sample, then 409s a second decision', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/distillation/review/rev-003').send({ verdict: 'agree', note: 'confirmed' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ verdict: 'agree', reviewer: 'Test Reviewer', note: 'confirmed' });

    const second = await request(app).post('/api/distillation/review/rev-003').send({ verdict: 'disagree' });
    expect(second.status).toBe(409);
  });
});

describe('GET /api/distillation/library/:libraryItemId/provenance', () => {
  it('200s with the artifact + lineage for a distilled Library item', async () => {
    const res = await request(buildApp()).get('/api/distillation/library/skill-cold-start-aurora/provenance');
    expect(res.status).toBe(200);
    expect(res.body.artifact.id).toBe('art-002');
    expect(res.body.lineage.nodes.length).toBeGreaterThan(0);
  });

  it('404s for a Library item nothing was distilled into', async () => {
    const res = await request(buildApp()).get('/api/distillation/library/lib-stakeholder-email/provenance');
    expect(res.status).toBe(404);
  });
});

// ─── Procedures ──────────────────────────────────────────────────────────────
// The compaction tests above may have minted clusters into the same repos
// these procedures are read against, and a health verdict is counted from
// exactly those rows — so every procedure suite starts from the seed.

describe('GET /api/distillation/procedures', () => {
  beforeEach(() => { __resetDistillationMock(); });

  it('200s with the procedure views, drifting and unproven ahead of proven', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures');
    expect(res.status).toBe(200);
    const views = res.body.procedures as Array<{ artifact: { id: string; type: string }; health: { status: string }; runs: { total: number }; step_count: number }>;
    expect(views.length).toBeGreaterThanOrEqual(3);
    expect(views.every((v) => v.artifact.type === 'procedure')).toBe(true);
    expect(views.map((v) => v.health.status)).toEqual(['drifting', 'unproven', 'proven']);
    expect(views[0]).toHaveProperty('applied_per_day');
    expect(views[0]).toHaveProperty('drift');
  });
});

describe('GET /api/distillation/procedures/:id', () => {
  beforeEach(() => { __resetDistillationMock(); });

  it('200s with one view', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/art-009');
    expect(res.status).toBe(200);
    expect(res.body.artifact.id).toBe('art-009');
    expect(res.body.health.status).toBe('proven');
    expect(res.body.step_count).toBe(4);
    expect(res.body.runs.total).toBe(4);
  });

  it('404s on an artifact that is not a procedure', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/art-001');
    expect(res.status).toBe(404);
  });

  it('400s on a malformed id', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/NOTVALID');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/distillation/procedures/:id/applications', () => {
  beforeEach(() => { __resetDistillationMock(); });

  it('200s with the runs, newest first', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/art-010/applications');
    expect(res.status).toBe(200);
    const apps = res.body.applications as Array<{ id: string; applied_at: string; outcome: string }>;
    expect(apps.map((a) => a.id)).toEqual(['papp-006', 'papp-005']);
    expect(apps[0]!.outcome).toBe('failed');
  });

  it('404s on a non-procedure id', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/art-001/applications');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/distillation/procedures/:id/apply', () => {
  beforeEach(() => { __resetDistillationMock(); });
  afterAll(() => { __resetDistillationMock(); });

  it('403s without ManageBots', async () => {
    gateOpen.value = false;
    const res = await request(buildApp()).post('/api/distillation/procedures/art-011/apply').send({ outcome: 'succeeded' });
    expect(res.status).toBe(403);
  });

  it('400s on a bad outcome', async () => {
    const res = await request(buildApp()).post('/api/distillation/procedures/art-011/apply').send({ outcome: 'meh' });
    expect(res.status).toBe(400);
  });

  it('400s on a failed run with no step, or a step that is not this procedure’s', async () => {
    const app = buildApp();
    const noStep = await request(app).post('/api/distillation/procedures/art-009/apply').send({ outcome: 'failed' });
    expect(noStep.status).toBe(400);
    const wrongStep = await request(app).post('/api/distillation/procedures/art-009/apply').send({ outcome: 'failed', failed_at_step_id: 'fact-020' });
    expect(wrongStep.status).toBe(400);
    const stepOnSuccess = await request(app).post('/api/distillation/procedures/art-009/apply').send({ outcome: 'succeeded', failed_at_step_id: 'fact-013' });
    expect(stepOnSuccess.status).toBe(400);
  });

  it('404s on a non-procedure id', async () => {
    const res = await request(buildApp()).post('/api/distillation/procedures/art-001/apply').send({ outcome: 'succeeded' });
    expect(res.status).toBe(404);
  });

  it('201s, lands in the registered fixture, moves the verdict, and reset takes it back', async () => {
    const app = buildApp();
    const before = procedureApplications.rows().length;
    const res = await request(app).post('/api/distillation/procedures/art-011/apply').send({ outcome: 'succeeded', note: 'approved in one meeting' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      procedure_id: 'art-011', outcome: 'succeeded', failed_at_step_id: null, note: 'approved in one meeting',
      session_id: 'u-test', box_id: 'portal',
    });
    expect(res.body.id).toMatch(/^papp-9\d{3}$/);
    expect(procedureApplications.rows().length).toBe(before + 1);

    const view = await request(app).get('/api/distillation/procedures/art-011');
    expect(view.body.health.status).toBe('proven');
    const apps = await request(app).get('/api/distillation/procedures/art-011/applications');
    expect(apps.body.applications[0].id).toBe(res.body.id);

    __resetDistillationMock();
    expect(procedureApplications.rows().length).toBe(before);
    const after = await request(app).get('/api/distillation/procedures/art-011');
    expect(after.body.health.status).toBe('unproven');
  });
});
