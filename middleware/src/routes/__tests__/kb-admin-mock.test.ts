// KB registry admin routes (routes/kb-admin.ts) under MOCK_AURORA.
//
// listKbs() (providers/kb-registry.ts) called `exec` directly with no mock
// branch, so GET /api/admin/kb-registry/health — which calls listKbs()
// before ever reaching Bedrock — threw straight through asyncHandler into a
// 500 offline (KBHealthBadge renders on every admin page). This pins: the
// mock fixture (mock/kb-registry.ts) is served instead of hitting the Data
// API, /health reports a healthy-with-one-drift summary synthesized from the
// fixture without constructing a real BedrockAgentClient, and /reconcile
// (kb-reconcile.ts) shows that same drifted row as 'missing' rather than an
// empty registry.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    knowledgeBase: { id: '', serviceRoleArn: '' },
    foundation: { documentsBucket: '' },
  },
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { kbAdminRouter } from '../kb-admin.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { role: 'admin', tenant: 'orgiq', sub: 'u-1' }; next(); });
  app.use('/api/admin/kb-registry', kbAdminRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockFlag.value = true;
  execMock.mockReset();
});

describe('GET /api/admin/kb-registry/health (mock)', () => {
  it('returns a healthy-with-one-drift summary without touching the Data API or Bedrock', async () => {
    const res = await request(buildApp()).get('/api/admin/kb-registry/health');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.kbs.length).toBeGreaterThanOrEqual(3);
    expect(res.body.healthy).toBeGreaterThanOrEqual(2);
    expect(res.body.broken).toBe(1);
    const drifted = res.body.kbs.find((k: { reachable: boolean }) => k.reachable === false);
    expect(drifted.problem).toMatch(/no longer exists in AWS/);
  });
});

describe('GET /api/admin/kb-registry (mock)', () => {
  it('lists the fixture registry', async () => {
    const res = await request(buildApp()).get('/api/admin/kb-registry');
    expect(res.status).toBe(200);
    expect(res.body.kbs.length).toBeGreaterThanOrEqual(3);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/kb-registry/reconcile (mock)', () => {
  it('flags the drifted row as missing without a real Bedrock call', async () => {
    const res = await request(buildApp()).get('/api/admin/kb-registry/reconcile');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    const missing = res.body.entries.find((e: { drift: string }) => e.drift === 'missing');
    expect(missing).toBeTruthy();
    expect(missing.detail).toMatch(/does not exist in this account/);
  });
});
