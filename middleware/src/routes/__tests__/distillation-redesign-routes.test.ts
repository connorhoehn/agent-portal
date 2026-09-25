// routes/distillation.ts — the redesign's API additions (spec §3a), against
// the real provider and mock corpus. Pinned: every new route's response
// shape, the IA doc's worked example (the CI chain "test passes alone, fails
// in CI → shared port → troubleshooting guide" on cl-019/art-001 has sources
// with excerpts), review samples resolving their target titles, jobs carrying
// input/output ids + log + what_changed + duration + cost, tiers carrying
// writers/backlog/lastCompletedAt/digest/health, procedure runs carrying
// per-step outcomes, and the 400/404 edges.
//
// The role gates (member reads, member writes 403) are pinned against the
// real authz module in distillation-gates.test.ts.

jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: () => ({ sub: 'u-test', name: 'Test Reviewer', role: 'org-leader', tenant: 'orgiq' }),
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {}, messageQueue: { mock: true } },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { distillationRouter } from '../distillation.js';
import { __setCompactRunMs, __resetDistillationMock, l2Replica } from '../../providers/distillation.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/distillation', distillationRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(() => __setCompactRunMs(0));
beforeEach(() => __resetDistillationMock());
afterAll(() => __resetDistillationMock());

describe('GET /api/distillation/levels — tier fields', () => {
  it('each tier carries writers, backlog, lastCompletedAt, digest and health', async () => {
    const res = await request(buildApp()).get('/api/distillation/levels');
    expect(res.status).toBe(200);
    expect(res.body.levels.map((l: { level: string }) => l.level)).toEqual(['L0', 'L1', 'L2']);
    for (const tier of res.body.levels) {
      expect(typeof tier.writers).toBe('number');
      expect(typeof tier.backlog).toBe('number');
      expect(tier.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(['ok', 'behind', 'stalled']).toContain(tier.health.state);
      expect(typeof tier.health.reason).toBe('string');
      expect(tier.health.lagSeconds).toBe(tier.lagSeconds);
    }
    expect(res.body.levels[0].lastCompletedAt).toBeNull();
    expect(typeof res.body.levels[1].lastCompletedAt).toBe('string');
    // The old top-level verdict list is still there for existing readers.
    expect(res.body.health).toHaveLength(3);
  });
});

describe('GET /api/distillation/items — total', () => {
  it('reports the filtered total beside the page and the cursor', async () => {
    const res = await request(buildApp()).get('/api/distillation/items?level=L1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.total).toBeGreaterThan(5);
    expect(typeof res.body.next_cursor).toBe('string');
    const narrowed = await request(buildApp()).get('/api/distillation/items?level=L1&repo=connorhoehnslalom/orgiq-finops&limit=200');
    expect(narrowed.body.total).toBe(narrowed.body.items.length);
    expect(narrowed.body.total).toBeLessThan(res.body.total);
  });
});

describe('GET /api/distillation/facets', () => {
  it('lists repos, initiatives and kinds with counts that match /items', async () => {
    const res = await request(buildApp()).get('/api/distillation/facets?level=L2');
    expect(res.status).toBe(200);
    for (const key of ['repos', 'initiatives', 'kinds']) {
      expect(Array.isArray(res.body[key])).toBe(true);
      for (const f of res.body[key]) {
        expect(typeof f.value).toBe('string');
        expect(typeof f.label).toBe('string');
        expect(f.count).toBeGreaterThan(0);
      }
    }
    const obs = res.body.repos.find((r: { value: string }) => r.value === 'connorhoehnslalom/orgiq-observability');
    // repoDisplayName: last segment, `orgiq-` dropped — the same label a
    // guide's based_on row shows for the repo.
    expect(obs.label).toBe('observability');
    const items = await request(buildApp()).get(`/api/distillation/items?level=L2&repo=${encodeURIComponent(obs.value)}&limit=200`);
    expect(items.body.total).toBe(obs.count);
    const initiative = res.body.initiatives.find((i: { value: string }) => i.value === 'p-observability');
    expect(initiative.label).toBe('Observability Platform');
    expect(res.body.kinds.map((k: { value: string }) => k.value)).toContain('procedure');
  });

  it('400s on a bad level', async () => {
    expect((await request(buildApp()).get('/api/distillation/facets?level=L9')).status).toBe(400);
  });
});

describe('GET /api/distillation/items/:id/sources — the IA example chain', () => {
  it('the guide (art-001) lists its pattern and the notes behind it, with excerpts', async () => {
    const res = await request(buildApp()).get('/api/distillation/items/art-001/sources');
    expect(res.status).toBe(200);
    const [pattern, ...notes] = res.body.sources;
    expect(pattern).toMatchObject({ id: 'cl-019', kind: 'cluster' });
    expect(pattern.excerpt).toMatch(/Port contention/);
    expect(notes.length).toBe(3);
    for (const n of notes) {
      expect(n.kind).toBe('observation');
      expect(n.session_id).toBe('sess-obs-03');
      expect(n.repo).toBe('connorhoehnslalom/orgiq-observability');
      expect(n.excerpt.length).toBeGreaterThan(20);
      expect(typeof n.timestamp).toBe('string');
    }
    // "passes alone, fails in CI" → "same local port"
    const passesAlone = notes.find((n: { title: string }) => /pass alone/.test(n.title));
    expect(passesAlone.excerpt).toMatch(/same local port/);
  });

  it('the pattern (cl-019) lists its member notes; a note lists its session', async () => {
    const pattern = await request(buildApp()).get('/api/distillation/items/cl-019/sources');
    expect(pattern.status).toBe(200);
    expect(pattern.body.sources.map((s: { kind: string }) => s.kind)).toEqual(['observation', 'observation', 'observation']);
    const noteId = pattern.body.sources[0].id as string;
    const note = await request(buildApp()).get(`/api/distillation/items/${noteId}/sources`);
    expect(note.body.sources).toEqual([expect.objectContaining({ id: 'sess-obs-03', kind: 'session', session_id: 'sess-obs-03' })]);
    expect(note.body.sources[0].excerpt).toMatch(/run notes? written in connorhoehnslalom\/orgiq-observability/);
  });

  it('404s an unknown item and 400s a malformed id', async () => {
    expect((await request(buildApp()).get('/api/distillation/items/art-999999/sources')).status).toBe(404);
    expect((await request(buildApp()).get('/api/distillation/items/NOPE/sources')).status).toBe(400);
  });
});

describe('GET /api/distillation/sessions/:id', () => {
  it('returns the run-note session with its notes in write order', async () => {
    const res = await request(buildApp()).get('/api/distillation/sessions/sess-obs-03');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'sess-obs-03', repo: 'connorhoehnslalom/orgiq-observability', box_id: 'box-obs-03', initiative_id: 'p-observability' });
    expect(res.body.notes.length).toBeGreaterThan(0);
    expect(res.body.started_at).toBe(res.body.notes[0].created_at);
    const stamps = res.body.notes.map((n: { created_at: string }) => n.created_at);
    expect(stamps).toEqual(stamps.slice().sort());
  });

  it('404s a session nothing names', async () => {
    expect((await request(buildApp()).get('/api/distillation/sessions/sess-nobody')).status).toBe(404);
  });
});

describe('GET /api/distillation/review — resolved targets', () => {
  it('every sample carries its target title, type, repo and source count', async () => {
    const res = await request(buildApp()).get('/api/distillation/review?verdict=pending');
    expect(res.status).toBe(200);
    const cl019 = res.body.samples.find((s: { target_id: string }) => s.target_id === 'cl-019');
    expect(cl019.target).toEqual({
      id: 'cl-019', kind: 'cluster', type: 'gotcha',
      title: 'Flaky collector-fleet tests only fail under parallel CI runs',
      repo: 'connorhoehnslalom/orgiq-observability', source_count: 3,
    });
    for (const s of res.body.samples) {
      expect(s.target).not.toBeNull();
      expect(s.target.title.length).toBeGreaterThan(0);
    }
  });

  it('an unresolvable target reads null with a target_error', async () => {
    const { reviewSamples } = await import('../../mock/distillation.js');
    reviewSamples.rows().push({
      id: 'rev-orphan', target_kind: 'cluster', target_id: 'cl-gone', sampled_at: new Date(0).toISOString(),
      reviewer: null, verdict: 'pending', note: null,
    });
    const res = await request(buildApp()).get('/api/distillation/review');
    const orphan = res.body.samples.find((s: { id: string }) => s.id === 'rev-orphan');
    expect(orphan.target).toBeNull();
    expect(orphan.target_error).toMatch(/cl-gone could not be found/);
  });
});

describe('GET /api/distillation/compactions and /compactions/:id — run fields', () => {
  it('each job carries input/output ids, a log, what_changed, duration and cost', async () => {
    const res = await request(buildApp()).get('/api/distillation/compactions');
    expect(res.status).toBe(200);
    for (const job of res.body.jobs) {
      expect(Array.isArray(job.input_ids)).toBe(true);
      expect(Array.isArray(job.output_ids)).toBe(true);
      expect(job.log.length).toBeGreaterThan(0);
      expect(typeof job.what_changed).toBe('string');
      expect(typeof job.cost_usd).toBe('number');
      if (job.status === 'succeeded') {
        expect(job.duration_ms).toBeGreaterThan(0);
        expect(job.input_ids.length).toBe(job.inputItems);
        expect(job.output_ids.length).toBe(job.outputItems);
      }
    }
    const failed = res.body.jobs.find((j: { id: string }) => j.id === 'comp-104');
    expect(failed.what_changed).toMatch(/^Nothing changed/);
    expect(failed.log.at(-1).level).toBe('error');
    expect(failed.phase).toBe('failed');
  });

  it('GET /compactions/:id returns one job, 404 for an unknown id', async () => {
    const one = await request(buildApp()).get('/api/distillation/compactions/comp-102');
    expect(one.status).toBe(200);
    expect(one.body.id).toBe('comp-102');
    expect(one.body.output_ids).toEqual(expect.arrayContaining(['cl-019']));
    expect((await request(buildApp()).get('/api/distillation/compactions/comp-000')).status).toBe(404);
  });

  it('filters by status=queued', async () => {
    const res = await request(buildApp()).get('/api/distillation/compactions?status=queued');
    expect(res.status).toBe(200);
    expect(res.body.jobs.every((j: { status: string }) => j.status === 'queued')).toBe(true);
  });
});

describe('POST /api/distillation/compact — queued pass, optional repo', () => {
  it('runs a repo-scoped pass through the queue and answers the job', async () => {
    const res = await request(buildApp()).post('/api/distillation/compact')
      .send({ level: 'L1', repo: 'connorhoehnslalom/orgiq-auth-service' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.repo).toBe('connorhoehnslalom/orgiq-auth-service');
    expect(res.body.queue).toBe('distill-compact-l1');
    expect(res.body.requested_by).toBe('Test Reviewer');
  });

  it('400s a malformed repo', async () => {
    const res = await request(buildApp()).post('/api/distillation/compact').send({ level: 'L1', repo: 'not a repo' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/distillation/procedures/:id/runs — per-step outcomes', () => {
  it('a drifting procedure: its failed run marks steps done → failed → pending', async () => {
    const res = await request(buildApp()).get('/api/distillation/procedures/art-010/runs');
    expect(res.status).toBe(200);
    const failed = res.body.runs.find((r: { outcome: string }) => r.outcome === 'failed');
    const statuses = failed.steps.map((s: { status: string }) => s.status);
    const at = failed.steps.findIndex((s: { step_id: string }) => s.step_id === failed.failed_at_step_id);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(statuses[at]).toBe('failed');
    expect(statuses.slice(0, at).every((s: string) => s === 'done')).toBe(true);
    expect(statuses.slice(at + 1).every((s: string) => s === 'pending')).toBe(true);
    const ok = res.body.runs.find((r: { outcome: string }) => r.outcome === 'succeeded');
    expect(ok.steps.every((s: { status: string }) => s.status === 'done')).toBe(true);
    expect(typeof ok.actor).toBe('string');
    expect(typeof ok.at).toBe('string');
  });

  it('a never-run procedure has no runs; a non-procedure 404s', async () => {
    expect((await request(buildApp()).get('/api/distillation/procedures/art-011/runs')).body).toEqual({ runs: [] });
    expect((await request(buildApp()).get('/api/distillation/procedures/art-001/runs')).status).toBe(404);
  });
});

describe('GET /api/distillation/replication', () => {
  it('reports the replica against the primary, and in sync after a sweep', async () => {
    await l2Replica().sync();
    const res = await request(buildApp()).get('/api/distillation/replication');
    expect(res.status).toBe(200);
    expect(res.body.inSync).toBe(true);
    expect(res.body.replicas).toEqual([expect.objectContaining({ id: 'l2-replica-1', lagMs: 0, repaired: expect.any(Number) })]);
    expect(res.body.replicas[0].digest).toBe(res.body.primary.digest);
    const levels = await request(buildApp()).get('/api/distillation/levels');
    expect(levels.body.levels[2].digest).toBe(res.body.primary.digest);
  });
});
