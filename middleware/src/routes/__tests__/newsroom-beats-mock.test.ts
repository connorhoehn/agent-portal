// Newsroom beats route (routes/newsroom-beats.ts).
//
// Pins two fixes: (1) the router had no handler for its own mount root, so
// GET /api/newsroom/beats (bare) fell through to the sibling
// /api/newsroom mount and 404'd there instead of in its own router — this
// checks the router in isolation resolves '/' rather than relying on mount
// order to save it. (2) getBeatCoverage/getTopBeats had no mock branch, so
// under MOCK_AURORA the beats card silently rendered zero beats even though
// it didn't 500 (both wrap exec in try/catch) — now derives from the shared
// newsroom article fixture so beat counts agree with what /articles shows.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
  },
}));

import express from 'express';
import request from 'supertest';
import { newsroomBeatsRouter } from '../newsroom-beats.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/newsroom/beats', newsroomBeatsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { mockFlag.value = true; });

describe('GET /api/newsroom/beats (bare mount root)', () => {
  it('resolves inside its own router instead of 404ing', async () => {
    const res = await request(buildApp()).get('/api/newsroom/beats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('beats');
    expect(Array.isArray(res.body.beats)).toBe(true);
  });
});

describe('GET /api/newsroom/beats/top (mock)', () => {
  it('reports beats from the shared article fixture, not zero', async () => {
    const res = await request(buildApp()).get('/api/newsroom/beats/top');
    expect(res.status).toBe(200);
    expect(res.body.beats.length).toBeGreaterThan(0);
    expect(res.body.beats[0]).toHaveProperty('name');
    expect(res.body.beats[0]).toHaveProperty('count');
  });
});

describe('GET /api/newsroom/beats/coverage (mock)', () => {
  it('returns a heatmap with at least one populated beat', async () => {
    const res = await request(buildApp()).get('/api/newsroom/beats/coverage?days=14');
    expect(res.status).toBe(200);
    expect(res.body.beats.length).toBeGreaterThan(0);
    expect(res.body.days.length).toBe(14);
    expect(res.body.matrix.length).toBe(res.body.beats.length);
  });
});
