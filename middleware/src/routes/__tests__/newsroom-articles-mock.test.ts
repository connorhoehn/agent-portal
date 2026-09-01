// Newsroom articles routes (routes/newsroom-articles.ts) under MOCK_AURORA.
//
// getClusters/getPitches/getPitchBoard/updatePitchStatus/publishArticle had no
// try/catch AND no mock branch — under MOCK_AURORA (no cluster ARN, no real
// Data API) they threw straight through asyncHandler into a bare 500, while
// listArticles/getArticle/getTodayStats/getEntity at least had a try/catch
// that degraded to an empty default. This pins the new config.mock.aurora
// fixture path added to all of them: clusters, pitches, and the pitch board
// now return real fixture content instead of a 500 (or, for articles/today,
// instead of a silent []).

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import { newsroomArticlesRouter } from '../newsroom-articles.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/newsroom', newsroomArticlesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { mockFlag.value = true; });

describe('GET /api/newsroom/clusters (mock)', () => {
  it('returns fixture clusters instead of 500ing', async () => {
    const res = await request(buildApp()).get('/api/newsroom/clusters');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.active.length).toBeGreaterThan(0);
    expect(res.body.active[0]).toHaveProperty('headline');
    expect(res.body.active[0]).toHaveProperty('size');
  });
});

describe('GET /api/newsroom/pitches (mock)', () => {
  it('defaults to status=open and returns the two open fixture pitches', async () => {
    const res = await request(buildApp()).get('/api/newsroom/pitches');
    expect(res.status).toBe(200);
    expect(res.body.open).toHaveLength(2);
    expect(res.body.total).toBeGreaterThanOrEqual(4);
  });

  it('filters by an explicit status', async () => {
    const res = await request(buildApp()).get('/api/newsroom/pitches?status=filed');
    expect(res.status).toBe(200);
    expect(res.body.open.length).toBeGreaterThan(0);
    expect(res.body.open.every((p: unknown) => p)).toBe(true);
  });
});

describe('GET /api/newsroom/pitches/board (mock)', () => {
  it('returns every pitch with status counts, not a 500', async () => {
    const res = await request(buildApp()).get('/api/newsroom/pitches/board');
    expect(res.status).toBe(200);
    expect(res.body.pitches.length).toBeGreaterThanOrEqual(4);
    expect(res.body.counts.open).toBe(2);
    const withCluster = res.body.pitches.find((p: { cluster: unknown }) => p.cluster);
    expect(withCluster.cluster).toHaveProperty('title');
  });
});

describe('PATCH /api/newsroom/pitches/:id (mock)', () => {
  it('updates status in the in-memory fixture', async () => {
    const app = buildApp();
    const board = await request(app).get('/api/newsroom/pitches/board');
    const openPitch = board.body.pitches.find((p: { status: string }) => p.status === 'open');
    const res = await request(app)
      .patch(`/api/newsroom/pitches/${openPitch.id}`)
      .send({ status: 'assigned' });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/newsroom/pitches/board');
    expect(after.body.pitches.find((p: { id: string }) => p.id === openPitch.id).status).toBe('assigned');
  });

  it('rejects an invalid status', async () => {
    const res = await request(buildApp()).patch('/api/newsroom/pitches/pitch-001').send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/newsroom/articles/today (mock)', () => {
  it('reports at least one article published today', async () => {
    const res = await request(buildApp()).get('/api/newsroom/articles/today');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.sections.length).toBeGreaterThan(0);
  });
});

describe('GET /api/newsroom/articles (mock)', () => {
  it('returns the fixture article list, not an empty array', async () => {
    const res = await request(buildApp()).get('/api/newsroom/articles');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(6);
    expect(res.body[0]).toHaveProperty('headline');
  });

  it('filters by beat', async () => {
    const res = await request(buildApp()).get('/api/newsroom/articles?beat=AI Policy');
    expect(res.status).toBe(200);
    expect(res.body.every((a: { section: string }) => a.section === 'AI Policy')).toBe(true);
  });
});

describe('GET /api/newsroom/articles/:id (mock)', () => {
  it('returns a full article detail with entities and cluster', async () => {
    const res = await request(buildApp()).get('/api/newsroom/articles/art-001');
    expect(res.status).toBe(200);
    expect(res.body.headline).toContain('Nimbus');
    expect(res.body.entities.length).toBeGreaterThan(0);
    expect(res.body.cluster).toHaveProperty('title');
  });

  it('404s for an unknown id', async () => {
    const res = await request(buildApp()).get('/api/newsroom/articles/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/newsroom/articles/:id/publish (mock)', () => {
  it('publishes the fixture draft article', async () => {
    const app = buildApp();
    const before = await request(app).get('/api/newsroom/articles/art-004');
    expect(before.body.status).toBe('draft');
    const res = await request(app).post('/api/newsroom/articles/art-004/publish');
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/newsroom/articles/art-004');
    expect(after.body.status).toBe('published');
  });
});

describe('GET /api/newsroom/entities/:id (mock)', () => {
  it('returns appearances and co-mentions', async () => {
    const res = await request(buildApp()).get('/api/newsroom/entities/ent-nimbus-cloud');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nimbus Cloud');
    expect(res.body.appearances.length).toBeGreaterThan(0);
  });
});
