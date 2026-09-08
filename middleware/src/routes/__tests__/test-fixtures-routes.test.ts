// E2E test fixtures — /api/observability/test-fixtures (routes/test-fixtures.ts).
//
// These two routes are mounted UNGATED (the Playwright specs run before any
// session exists) and they WRITE to the observability schema. The only thing
// standing between them and a production database is the NODE_ENV check, so
// that check is what this file is mostly about: both routes must refuse in
// production, and must refuse BEFORE issuing any statement.
//
// Also pinned:
//   * the reset really resets — decision audit rows are cleared and both
//     approvals go back to PENDING with their decision columns nulled, or a
//     rerun of the approval spec starts from a decided state,
//   * the seed-timestamp refresh spreads rows across the window rather than
//     stacking them on one instant (a single cluster gives the drift chart one
//     bucket and nothing to plot), and only touches `seed:%` rows,
//   * a failure is reported as a 500 that NAMES the cause rather than an
//     opaque one — these run in CI, where the message is the whole diagnosis.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { testFixturesRouter } from '../test-fixtures.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);

const BASE = '/api/observability/test-fixtures';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, testFixturesRouter);
  app.use(errorHandler);
  return app;
}

const originalEnv = process.env['NODE_ENV'];

beforeEach(() => { execMock.mockReset(); });
afterEach(() => { process.env['NODE_ENV'] = originalEnv; });

describe('the production guard', () => {
  it('refuses BOTH routes in production, without issuing a statement', async () => {
    process.env['NODE_ENV'] = 'production';
    const app = buildApp();
    for (const path of ['/api/observability/test-fixtures/reset-approvals', '/api/observability/test-fixtures/refresh-seed-timestamps']) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden in production' });
    }
    // The guard runs first — nothing reached the database.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('allows them in development and test', async () => {
    execMock.mockResolvedValue([]);
    for (const env of ['development', 'test']) {
      process.env['NODE_ENV'] = env;
      const res = await request(buildApp()).post('/api/observability/test-fixtures/reset-approvals').send({});
      expect(res.status).toBe(200);
    }
  });
});

describe('POST /reset-approvals', () => {
  beforeEach(() => { process.env['NODE_ENV'] = 'test'; });

  it('clears the decision audit and returns BOTH seeded approvals to PENDING', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/test-fixtures/reset-approvals').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(sqlOf(0)).toMatch(/DELETE FROM observability\.approval_decisions/);
    const update = sqlOf(1);
    expect(update).toMatch(/UPDATE observability\.approvals/);
    expect(update).toMatch(/status = 'PENDING'/);
    // Every decision column is nulled — a leftover decided_by would make the
    // spec's "undecided" assertion pass against a decided row.
    for (const col of ['decided_at', 'decided_by', 'decided_note']) {
      expect(update).toMatch(new RegExp(`${col} = NULL`));
    }
  });

  it('clears the audit BEFORE resetting the rows it audits', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).post('/api/observability/test-fixtures/reset-approvals').send({});
    expect(sqlOf(0)).toMatch(/approval_decisions/);
    expect(sqlOf(1)).toMatch(/UPDATE observability\.approvals/);
  });

  it('500s with the underlying reason when the reset fails', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.approvals" does not exist'));
    const res = await request(buildApp()).post('/api/observability/test-fixtures/reset-approvals').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('reset failed');
    expect(res.body.detail).toMatch(/observability\.approvals/);
  });
});

describe('POST /refresh-seed-timestamps', () => {
  beforeEach(() => { process.env['NODE_ENV'] = 'test'; });

  it('SPREADS the seed rows across a window instead of stacking them on one instant', async () => {
    // One cluster gives the drift time-series a single bucket and nothing to
    // plot; the random offset is what makes the chart renderable.
    execMock.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await request(buildApp()).post('/api/observability/test-fixtures/refresh-seed-timestamps').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rowsAffected: 2 });
    const sql = sqlOf(0);
    expect(sql).toMatch(/random\(\) \* INTERVAL '6 hours'/);
    expect(sql).toMatch(/UPDATE observability\.invocation_traces/);
  });

  it('touches ONLY seeded rows — real traffic keeps its real timestamps', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).post('/api/observability/test-fixtures/refresh-seed-timestamps').send({});
    expect(sqlOf(0)).toMatch(/WHERE prompt_snippet LIKE 'seed:%'/);
  });

  it('reports 0 rows honestly when there is nothing seeded to slide', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/test-fixtures/refresh-seed-timestamps').send({});
    expect(res.body).toEqual({ ok: true, rowsAffected: 0 });
  });

  it('500s with the underlying reason when the refresh fails', async () => {
    execMock.mockRejectedValue(new Error('permission denied for table invocation_traces'));
    const res = await request(buildApp()).post('/api/observability/test-fixtures/refresh-seed-timestamps').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('refresh failed');
    expect(res.body.detail).toMatch(/permission denied/);
  });
});
