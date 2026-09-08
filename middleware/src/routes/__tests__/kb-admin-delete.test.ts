// DELETE /api/admin/kb-registry/:id (routes/kb-admin.ts) had no test.
// Worth closing specifically because of the KB registry drift class of bug
// CLAUDE.md documents: "a knowledge base deleted out-of-band cannot be
// replaced via CFN without a multi-stack teardown" — this route is the
// in-app trigger for exactly that kind of deletion, fired from an admin
// screen, for a resource four other CDK stacks import by id.
//
// The route's own contract (kb-admin.ts's DELETE /:id) is narrow and worth
// pinning on its own, separately from whatever deprovisionKb actually does
// to Bedrock/Aurora (that belongs to kb-registry.ts, not this route):
//   1. 404 before touching anything, for an id that is not in the registry.
//   2. 200 `{ ok: true, message: 'deprovisioning started' }` for one that is.
//   3. Deprovisioning is FIRE-AND-FORGET — the response resolves without
//      awaiting deprovisionKb, so a slow or hanging teardown (Bedrock/Aurora
//      calls) can never make this endpoint hang or fail the request that
//      kicked it off.
//   4. It calls deprovisionKb with the RIGHT id — the registry row's `id`,
//      not the raw `:id` param the caller passed (relevant once the route
//      grows alias/slug lookup and someone forwards the wrong value).
//
// providers/kb-registry.js is mocked wholesale rather than exercised through
// MOCK_AURORA (the path kb-admin-mock.test.ts uses for reads) because the
// real deprovisionKb constructs a live BedrockAgentClient and calls AWS even
// under config.mock.aurora — fine to fire-and-forget in production, not
// something a unit test should let run in the background.

jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    knowledgeBase: { id: '', serviceRoleArn: '' },
    foundation: { documentsBucket: '' },
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/kb-registry.js', () => ({
  listKbs: jest.fn(),
  getKb: jest.fn(),
  getKbBySlug: jest.fn(),
  createKbEntry: jest.fn(),
  updateKbEntry: jest.fn(),
  deleteKbEntry: jest.fn(),
  provisionKb: jest.fn(),
  deprovisionKb: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { kbAdminRouter } from '../kb-admin.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getKb, deprovisionKb } from '../../providers/kb-registry.js';

const getKbMock = getKb as jest.Mock;
const deprovisionMock = deprovisionKb as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/kb-registry', kbAdminRouter);
  app.use(errorHandler);
  return app;
}

const ROW = { id: 'kb-eng-1', tenant: 'orgiq', slug: 'orgiq-onboarding', name: 'Onboarding', bedrockKbId: 'KBABC123' };

beforeEach(() => {
  getKbMock.mockReset();
  deprovisionMock.mockReset();
});

describe('DELETE /api/admin/kb-registry/:id', () => {
  it('404s before deprovisioning anything, for an id not in the registry', async () => {
    getKbMock.mockResolvedValue(null);
    const res = await request(buildApp()).delete('/api/admin/kb-registry/kb-nope');
    expect(res.status).toBe(404);
    expect(deprovisionMock).not.toHaveBeenCalled();
  });

  it('200s and starts deprovisioning for a row that exists', async () => {
    getKbMock.mockResolvedValue(ROW);
    // Never resolves within the test — proves the response does not await it.
    deprovisionMock.mockReturnValue(new Promise(() => {}));
    const res = await request(buildApp()).delete(`/api/admin/kb-registry/${ROW.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'deprovisioning started' });
    expect(deprovisionMock).toHaveBeenCalledWith(ROW.id);
  });

  it('a rejected deprovision runs in the background and does not surface as a failed request', async () => {
    getKbMock.mockResolvedValue(ROW);
    deprovisionMock.mockRejectedValue(new Error('Bedrock DeleteKnowledgeBase failed'));
    const res = await request(buildApp()).delete(`/api/admin/kb-registry/${ROW.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'deprovisioning started' });
  });
});
