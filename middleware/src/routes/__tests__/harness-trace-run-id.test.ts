// POST /api/observability/harness/trace carries the AG-UI run (pipelines P1).
//
// The agent callback is the door every bundle comes through when the
// middleware is reachable (instrumentation.py `post_trace`); the route copies
// each field it knows onto the sink input, and a field it does not copy is
// silently lost. So the run link is pinned at the door: `runId`, `threadId`,
// `tenant` and `steps` reach the stored row, and a bundle without them stores
// exactly as before. The callback stays sessionless (optional service auth —
// never a session floor, CLAUDE.md).

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    auth: {},
  },
}));
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
}));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(), putQualityMetric: jest.fn(), putSchemaMetric: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { harnessRouter } from '../harness.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { sinkTraceById } from '../../mock/trace-sink.js';
import { _resetCachesForTest } from '../../lib/trace-sink.js';

const app = express();
app.use(express.json());
app.use('/api/observability/harness', harnessRouter);
app.use(errorHandler);

beforeEach(() => { fixtureRegistry.resetAll('default'); _resetCachesForTest(); });
afterAll(() => fixtureRegistry.resetAll('default'));

const BASE = { agentId: 'orgiq-supervisor', prompt: 'who knows auth', response: 'Theo does.', modelId: 'amazon.nova-pro-v1:0' };

it('stores the run id, thread, tenant and steps the bundle carried — with no session', async () => {
  const steps = [{ stepId: 'search-1', name: 'search', status: 'completed', startedAt: null, finishedAt: null,
    toolCalls: [{ toolCallId: 'tc1', name: 'search_organization', status: 'completed', startedAt: null, finishedAt: null }] }];
  const res = await request(app).post('/api/observability/harness/trace')
    .send({ ...BASE, runId: 'run-door', threadId: 'sess-9', tenant: 'orgiq', steps });
  expect(res.status).toBe(200);
  const row = sinkTraceById(res.body.invocationId);
  expect(row).toMatchObject({ agui_run_id: 'run-door', agui_thread_id: 'sess-9', tenant: 'orgiq' });
  expect(row?.steps?.[0]).toMatchObject({ stepId: 'search-1', name: 'search', toolCalls: [expect.objectContaining({ toolCallId: 'tc1' })] });
});

it('a bundle without a run stores exactly as before — nulls, not invented values', async () => {
  const res = await request(app).post('/api/observability/harness/trace').send(BASE);
  expect(res.status).toBe(200);
  expect(sinkTraceById(res.body.invocationId)).toMatchObject({ agui_run_id: null, agui_thread_id: null, steps: null, tenant: null });
});
