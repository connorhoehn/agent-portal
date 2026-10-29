// DE-4 prompt pointers — /api/iq/prompts/:agent/{candidate,promote,rollback}
// (routes/prompt-pointers.ts), against the offline fixtures.
//
// Pinned: the ManageCanary gate on all three writes; a candidate that fails
// the gate (unpublished version, eval rate under the bar, DRAFT) is refused
// 409 and writes nothing; candidate -> promote writes live, deletes the
// candidate and moves the lifecycle rows (promoted, old live superseded);
// rollback deletes only the candidate (rolled_back); reset restores the seed.

const gateActions: string[] = [];
jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../config.js', () => ({
  config: { mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true }, region: 'us-east-1' },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { promptPointersRouter } from '../prompt-pointers.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { mockPublishVersion } from '../../mock/canary-library.js';
import { promptLifecycle, mockGetLifecycle } from '../../mock/prompt-pointers.js';

const PROMPT = 'mock-search-system-prompt';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/iq/prompts', promptPointersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { fixtureRegistry.resetAll(); });

describe('auth floor', () => {
  it('gates the three writes on ManageCanary', () => {
    expect(gateActions).toEqual(['ManageCanary', 'ManageCanary', 'ManageCanary']);
  });
});

describe('candidate', () => {
  it('refuses a version that was never published', async () => {
    const res = await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: '9' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not exist/);
    const after = await request(buildApp()).get('/api/iq/prompts/search/pointers');
    expect(after.body.candidate).toBeNull();
  });

  it('refuses DRAFT', async () => {
    const res = await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: 'DRAFT' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DRAFT/);
  });

  it('refuses a version whose recorded eval rate is under the bar', async () => {
    const v = mockPublishVersion(PROMPT)!.version.version;
    promptLifecycle.rows().push({ promptId: PROMPT, version: v, lifecycleStatus: 'published', evalPassRate: 0.5, updatedAt: '2026-10-29T00:00:00.000Z' });
    const res = await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: v });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/50% is below the 80% bar/);
    expect((await request(buildApp()).get('/api/iq/prompts/search/pointers')).body.candidate).toBeNull();
  });

  it('writes the candidate at the default weight and marks it deployed', async () => {
    const v = mockPublishVersion(PROMPT)!.version.version;
    const res = await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: v });
    expect(res.status).toBe(200);
    expect(res.body.pointers.candidate).toEqual({ promptId: PROMPT, version: v, weight: 10 });
    expect(mockGetLifecycle(PROMPT, v)?.lifecycleStatus).toBe('deployed');
  });

  it('refuses a second candidate while one is in flight', async () => {
    const v1 = mockPublishVersion(PROMPT)!.version.version;
    const v2 = mockPublishVersion(PROMPT)!.version.version;
    await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: v1 });
    const res = await request(buildApp()).post('/api/iq/prompts/search/candidate').send({ version: v2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already the candidate/);
  });

  it('404s an agent with no prompt', async () => {
    const res = await request(buildApp()).post('/api/iq/prompts/assessment-scorer/candidate').send({ version: '1' });
    expect(res.status).toBe(404);
  });
});

describe('promote and rollback', () => {
  it('promote copies candidate to live, deletes it, supersedes the old live', async () => {
    const app = buildApp();
    const v1 = mockPublishVersion(PROMPT)!.version.version;
    const v2 = mockPublishVersion(PROMPT)!.version.version;
    await request(app).post('/api/iq/prompts/search/candidate').send({ version: v1 });
    await request(app).post('/api/iq/prompts/search/promote');
    await request(app).post('/api/iq/prompts/search/candidate').send({ version: v2, weight: 25 });
    const res = await request(app).post('/api/iq/prompts/search/promote');
    expect(res.status).toBe(200);
    expect(res.body.pointers).toEqual({ live: { promptId: PROMPT, version: v2 }, candidate: null });
    expect(mockGetLifecycle(PROMPT, v2)?.lifecycleStatus).toBe('promoted');
    expect(mockGetLifecycle(PROMPT, v1)?.lifecycleStatus).toBe('superseded');
  });

  it('promote with no candidate is a 409', async () => {
    expect((await request(buildApp()).post('/api/iq/prompts/search/promote')).status).toBe(409);
  });

  it('rollback deletes the candidate, keeps live, marks rolled_back', async () => {
    const app = buildApp();
    const v1 = mockPublishVersion(PROMPT)!.version.version;
    const v2 = mockPublishVersion(PROMPT)!.version.version;
    await request(app).post('/api/iq/prompts/search/candidate').send({ version: v1 });
    await request(app).post('/api/iq/prompts/search/promote');
    await request(app).post('/api/iq/prompts/search/candidate').send({ version: v2 });
    const res = await request(app).post('/api/iq/prompts/search/rollback');
    expect(res.status).toBe(200);
    expect(res.body.pointers).toEqual({ live: { promptId: PROMPT, version: v1 }, candidate: null });
    expect(mockGetLifecycle(PROMPT, v2)?.lifecycleStatus).toBe('rolled_back');
    expect(mockGetLifecycle(PROMPT, v1)?.lifecycleStatus).toBe('promoted');
  });

  it('a mock reset restores the no-pointer seed', async () => {
    const app = buildApp();
    const v = mockPublishVersion(PROMPT)!.version.version;
    await request(app).post('/api/iq/prompts/search/candidate').send({ version: v });
    fixtureRegistry.resetAll();
    expect((await request(app).get('/api/iq/prompts/search/pointers')).body).toEqual({ agent: 'search', live: null, candidate: null });
  });
});
