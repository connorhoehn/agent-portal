// POST /api/observability/quality/feedback by RUN — LabelFeedback unblocked (pipelines P1).
//
// The Ask page holds the AG-UI run id of the answer it streamed; the trace row
// holds `agui_run_id` since the bundle began carrying `runId`. Labelling by run
// resolves to the run's own trace (the earliest row with that id) among the
// CALLER'S OWN runs only, and a run whose bundle has not landed is a 404 that
// says so. Both row sources are pinned: the live SQL (bound parameters, the
// user scope in the statement) and the offline fixture (a seeded Ask run).

let mockAurora = false;
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', get mock() { return { aurora: mockAurora, agentcore: mockAurora }; } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { qualityRouter } from '../quality.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { traceRows } from '../../mock/observability.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const execMock = exec as unknown as jest.Mock;

function buildApp(sub: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (sub) (req as unknown as { session: unknown }).session = { sub, role: 'member', tenant: 'orgiq' }; next(); });
  app.use('/api/observability/quality', qualityRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); mockAurora = false; fixtureRegistry.resetAll('default'); });
afterAll(() => fixtureRegistry.resetAll('default'));

describe('live SQL', () => {
  it('labels the caller\'s own run\'s trace, scoped by user in the statement', async () => {
    execMock.mockResolvedValue([{ invocation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]);
    const res = await request(buildApp('u-theo')).post('/api/observability/quality/feedback')
      .send({ runId: 'run-1', label: 'good' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, runId: 'run-1', invocationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', label: 'good' });
    const sql = String(execMock.mock.calls[0]![0]);
    expect(sql).toMatch(/agui_run_id = :rid AND user_id = :sub/);
    expect(sql).toMatch(/ORDER BY ts ASC LIMIT 1/);
    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: { stringValue?: string } }>;
    expect(params.find((p) => p.name === 'sub')?.value.stringValue).toBe('u-theo');
  });

  it('is a 404 that says the bundle may still be on its way, not a 500', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp('u-theo')).post('/api/observability/quality/feedback')
      .send({ runId: 'run-pending', label: 'bad' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/may still be on its way/);
  });

  it('refuses a bad label and an anonymous caller before any SQL', async () => {
    expect((await request(buildApp('u-theo')).post('/api/observability/quality/feedback').send({ runId: 'r', label: 'meh' })).status).toBe(400);
    expect((await request(buildApp(null)).post('/api/observability/quality/feedback').send({ runId: 'r', label: 'good' })).status).toBe(400);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('offline (dev:mock)', () => {
  it('labels a seeded Ask run for its own user, and not for anyone else', async () => {
    mockAurora = true;
    const row = traceRows().find((r) => r.agui_run_id && r.user_id)!;
    expect(row).toBeTruthy();
    const other = await request(buildApp('u-not-them')).post('/api/observability/quality/feedback')
      .send({ runId: row.agui_run_id, label: 'good' });
    expect(other.status).toBe(404);

    const res = await request(buildApp(row.user_id)).post('/api/observability/quality/feedback')
      .send({ runId: row.agui_run_id, label: 'good' });
    expect(res.status).toBe(200);
    expect(res.body.invocationId).toBe(row.invocation_id);
    expect(traceRows().find((r) => r.invocation_id === row.invocation_id)?.human_label).toBe('good');
    expect(execMock).not.toHaveBeenCalled();
  });
});
