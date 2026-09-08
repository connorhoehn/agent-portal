// Judge calibration — /api/observability/calibration (routes/calibration.ts).
// A hand-graded corpus, re-judged on demand; when the mean absolute error
// creeps past ~0.15 the historical quality scores have lost their meaning.
//
// What is pinned:
//   * the auth floor: the four reads are open, all four mutations are
//     ManageCanary (they change what "the judge has drifted" is measured
//     against),
//   * the ARITHMETIC, which is the whole feature. `absError` is
//     |judge − human| per case; the run's `meanAbsError` averages ONLY the
//     cases that produced a score, and `maxAbsError` is the worst of them. A
//     judge failure must not be silently averaged in as a zero error — that
//     would make a broken judge look perfectly calibrated,
//   * a failed judge landing as a result row with NULL score and NULL error,
//     so the operator can see which case it failed on,
//   * the refusal to run over an empty set (always operator error) and the
//     503 when the set itself cannot be read — different causes, different
//     codes,
//   * the human score clamped into 0..1 on write,
//   * PATCH being genuinely partial — an absent key is left alone, an
//     explicit null CLEARS, and a body with nothing in it changes nothing
//     rather than blanking the row,
//   * DELETE being a SOFT delete (active=false) — a graded case is evidence,
//   * the two read routes degrading to empty rather than failing the page.

const gateActions: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// The router now has an offline branch gated on `config.mock.aurora`, so it
// imports config.ts — which reaches `import.meta` and is unloadable under the
// CJS test build (the same trap drift-routes.test.ts documents). Mocked with
// `aurora: false` on purpose: every case in this file is about the LIVE SQL
// path, and the offline branch is pinned separately in
// observability-mock-branch.test.ts.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false } },
}));
jest.mock('../../lib/judge.js', () => ({
  judgeResponse: jest.fn(),
  NOVA_PRO_MODEL_ID: 'amazon.nova-pro-v1:0',
}));

import express from 'express';
import request from '../../test-support/http.js';
import { calibrationRouter } from '../calibration.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { judgeResponse } from '../../lib/judge.js';

const execMock = exec as unknown as jest.Mock;
const judgeMock = judgeResponse as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const valOf = (call: number, name: string): Record<string, unknown> | undefined =>
  paramsOf(call).find((p) => p.name === name)?.value;

const BASE = '/api/observability/calibration';

function caseRow(over: Record<string, unknown> = {}) {
  return {
    calibration_id: 'cc-1', agent_id: 'orgiq-search',
    prompt: 'who owns auth', response: 'Nora Vance',
    human_score: '0.9', human_rationale: 'correct and grounded', active: true,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', notes: null,
    ...over,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, calibrationRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  execMock.mockReset();
  judgeMock.mockReset();
});

describe('auth floor', () => {
  it('gates all four mutations on ManageCanary and leaves the reads open', () => {
    expect(gateActions).toEqual(['ManageCanary', 'ManageCanary', 'ManageCanary', 'ManageCanary']);
  });
});

describe('GET /cases', () => {
  it('lists ACTIVE cases by default and maps the graded row', async () => {
    execMock.mockResolvedValue([caseRow()]);
    const res = await request(buildApp()).get('/api/observability/calibration/cases');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['cases']);
    expect(res.body.cases[0]).toMatchObject({
      calibrationId: 'cc-1', agentId: 'orgiq-search', humanScore: 0.9,
      humanRationale: 'correct and grounded', active: true,
    });
    expect(sqlOf(0)).toMatch(/WHERE active = true/);
  });

  it('includes soft-deleted cases only when asked', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/calibration/cases?includeInactive=1');
    await request(app).get('/api/observability/calibration/cases?includeInactive=true');
    await request(app).get('/api/observability/calibration/cases?includeInactive=yes');
    expect(sqlOf(0)).not.toMatch(/WHERE active = true/);
    expect(sqlOf(1)).not.toMatch(/WHERE active = true/);
    // Anything else is not "include" — the default stays safe.
    expect(sqlOf(2)).toMatch(/WHERE active = true/);
  });

  it('says the migration is missing rather than reporting an empty case set', async () => {
    // An unseeded calibration set and an unapplied migration both leave the
    // page with nothing to show; only one of them is something to go fix.
    execMock.mockResolvedValue([]);
    const unseeded = await request(buildApp()).get('/api/observability/calibration/cases');
    expect(unseeded.body).toEqual({ cases: [] });

    execMock.mockRejectedValue(new Error('relation "observability.calibration_set" does not exist'));
    const res = await request(buildApp()).get('/api/observability/calibration/cases');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cases: [], degraded: true,
      error: 'relation "observability.calibration_set" does not exist',
    });
  });
});

describe('GET /cases/:id', () => {
  it('binds the id and casts it in SQL rather than interpolating it', async () => {
    execMock.mockResolvedValue([caseRow()]);
    const res = await request(buildApp()).get('/api/observability/calibration/cases/cc-1');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['case']);
    expect(sqlOf(0)).toMatch(/WHERE calibration_id = CAST\(:id AS uuid\)/);
    expect(valOf(0, 'id')).toEqual({ stringValue: 'cc-1' });
  });

  it('404s a case that is not there', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/observability/calibration/cases/cc-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/calibration case not found/);
  });
});

describe('POST /cases', () => {
  it('requires an agent, a prompt, a response and a numeric human score', async () => {
    const app = buildApp();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /agentId is required/],
      [{ agentId: 'a' }, /prompt is required/],
      [{ agentId: 'a', prompt: 'p' }, /response is required/],
      [{ agentId: 'a', prompt: 'p', response: 'r' }, /humanScore is required/],
      [{ agentId: 'a', prompt: 'p', response: 'r', humanScore: 'high' }, /humanScore is required/],
    ];
    for (const [body, pattern] of cases) {
      const res = await request(app).post('/api/observability/calibration/cases').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    expect(execMock).not.toHaveBeenCalled();
  });

  it('accepts an EMPTY response — a refusal is a gradeable answer', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/calibration/cases')
      .send({ agentId: 'a', prompt: 'p', response: '', humanScore: 0 });
    expect(res.status).toBe(201);
    expect(valOf(0, 'response')).toEqual({ stringValue: '' });
  });

  it('clamps the human score into 0..1 and defaults active to true', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).post('/api/observability/calibration/cases')
      .send({ agentId: 'a', prompt: 'p', response: 'r', humanScore: 5 });
    await request(app).post('/api/observability/calibration/cases')
      .send({ agentId: 'a', prompt: 'p', response: 'r', humanScore: -2, active: false });
    expect(valOf(0, 'human_score')).toEqual({ doubleValue: 1 });
    expect(valOf(0, 'active')).toEqual({ booleanValue: true });
    expect(valOf(1, 'human_score')).toEqual({ doubleValue: 0 });
    expect(valOf(1, 'active')).toEqual({ booleanValue: false });
  });

  it('returns a generated id, and binds an absent rationale as SQL NULL', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/calibration/cases')
      .send({ agentId: 'a', prompt: 'p', response: 'r', humanScore: 0.5 });
    expect(res.status).toBe(201);
    expect(String(res.body.calibrationId)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(valOf(0, 'human_rationale')).toEqual({ isNull: true });
    expect(valOf(0, 'notes')).toEqual({ isNull: true });
  });
});

describe('PATCH /cases/:id', () => {
  it('changes NOTHING for an empty body rather than blanking the row', async () => {
    const res = await request(buildApp()).patch('/api/observability/calibration/cases/cc-1').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, changed: 0 });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('sets only the fields present, and touches updated_at', async () => {
    execMock.mockResolvedValue([{ calibration_id: 'cc-1' }]);
    const res = await request(buildApp()).patch('/api/observability/calibration/cases/cc-1')
      .send({ humanScore: 0.75 });
    expect(res.status).toBe(200);
    const sql = sqlOf(0);
    expect(sql).toMatch(/human_score = :human_score/);
    expect(sql).toMatch(/updated_at = now\(\)/);
    expect(sql).not.toMatch(/agent_id =/);
    expect(sql).not.toMatch(/prompt =/);
    expect(valOf(0, 'human_score')).toEqual({ doubleValue: 0.75 });
  });

  it('distinguishes an ABSENT nullable field from an explicit null', async () => {
    execMock.mockResolvedValue([{ calibration_id: 'cc-1' }]);
    const app = buildApp();
    await request(app).patch('/api/observability/calibration/cases/cc-1').send({ active: true });
    expect(sqlOf(0)).not.toMatch(/human_rationale =/);

    await request(app).patch('/api/observability/calibration/cases/cc-1')
      .send({ humanRationale: null, notes: null });
    expect(sqlOf(1)).toMatch(/human_rationale = :human_rationale/);
    expect(valOf(1, 'human_rationale')).toEqual({ isNull: true });
    expect(valOf(1, 'notes')).toEqual({ isNull: true });
  });

  it('clamps a patched human score too, and 404s an unknown case', async () => {
    execMock.mockResolvedValue([{ calibration_id: 'cc-1' }]);
    await request(buildApp()).patch('/api/observability/calibration/cases/cc-1').send({ humanScore: 9 });
    expect(valOf(0, 'human_score')).toEqual({ doubleValue: 1 });

    execMock.mockResolvedValue([]);
    const missing = await request(buildApp()).patch('/api/observability/calibration/cases/cc-x')
      .send({ active: false });
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /cases/:id', () => {
  it('SOFT deletes — a hand-graded case is evidence, not a row to drop', async () => {
    execMock.mockResolvedValue([{ calibration_id: 'cc-1' }]);
    const res = await request(buildApp()).delete('/api/observability/calibration/cases/cc-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sqlOf(0)).toMatch(/SET active = false/);
    expect(sqlOf(0)).not.toMatch(/DELETE FROM/);
  });

  it('404s a case that was never there', async () => {
    execMock.mockResolvedValue([]);
    expect((await request(buildApp()).delete('/api/observability/calibration/cases/cc-x')).status).toBe(404);
  });
});

describe('POST /runs', () => {
  function judgeReturns(scores: Array<number | null>) {
    for (const s of scores) {
      if (s === null) judgeMock.mockRejectedValueOnce(new Error('ThrottlingException'));
      else judgeMock.mockResolvedValueOnce({ score: s, rationale: `scored ${s}` });
    }
  }

  it('refuses to run over an EMPTY set — always operator error', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/calibration/runs').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no active calibration cases/);
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('503s — a different failure from an empty set — when the set cannot be read', async () => {
    execMock.mockRejectedValue(new Error('relation does not exist'));
    const res = await request(buildApp()).post('/api/observability/calibration/runs').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('calibration_set unavailable');
    expect(res.body.detail).toMatch(/relation does not exist/);
  });

  it('computes abs error per case, and MAE + max over the run', async () => {
    execMock
      .mockResolvedValueOnce([caseRow({ calibration_id: 'cc-1', human_score: '0.9' }),
                              caseRow({ calibration_id: 'cc-2', human_score: '0.2' })])
      .mockResolvedValue([]);
    judgeReturns([0.7, 0.8]);
    const res = await request(buildApp()).post('/api/observability/calibration/runs').send({});
    expect(res.status).toBe(201);
    // |0.7-0.9| = 0.2 ; |0.8-0.2| = 0.6 → mean 0.4, max 0.6
    expect(res.body.totalCases).toBe(2);
    expect(res.body.meanAbsError).toBeCloseTo(0.4, 10);
    expect(res.body.maxAbsError).toBeCloseTo(0.6, 10);
    expect(String(res.body.calibrationRunId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('does NOT average a failed judge in as a zero error', async () => {
    // A broken judge that scored nothing must not read as perfectly calibrated.
    execMock
      .mockResolvedValueOnce([caseRow({ calibration_id: 'cc-1', human_score: '0.9' }),
                              caseRow({ calibration_id: 'cc-2', human_score: '0.2' })])
      .mockResolvedValue([]);
    judgeReturns([0.7, null]);
    const res = await request(buildApp()).post('/api/observability/calibration/runs').send({});
    // Only the one scored case contributes: mean == its own error, not 0.1.
    expect(res.body.meanAbsError).toBeCloseTo(0.2, 10);
    expect(res.body.maxAbsError).toBeCloseTo(0.2, 10);

    // …and the failed case still lands as a row, with nulls, so the operator
    // can see WHICH case the judge failed on.
    const failedInsert = execMock.mock.calls.find((c, i) =>
      String(c[0]).includes('calibration_results')
      && (paramsOf(i).find((p) => p.name === 'calibration_id')?.value['stringValue']) === 'cc-2')!;
    const params = (failedInsert[1] ?? []) as Param[];
    expect(params.find((p) => p.name === 'judge_score')!.value).toEqual({ isNull: true });
    expect(params.find((p) => p.name === 'abs_error')!.value).toEqual({ isNull: true });
  });

  it('reports NULL — not 0 — for MAE when the judge scored nothing at all', async () => {
    execMock.mockResolvedValueOnce([caseRow()]).mockResolvedValue([]);
    judgeReturns([null]);
    const res = await request(buildApp()).post('/api/observability/calibration/runs').send({});
    expect(res.body.meanAbsError).toBeNull();
    expect(res.body.maxAbsError).toBeNull();
  });

  it('defaults the model to Nova Pro and auto-labels the run', async () => {
    execMock.mockResolvedValueOnce([caseRow()]).mockResolvedValue([]);
    judgeReturns([0.9]);
    await request(buildApp()).post('/api/observability/calibration/runs').send({});
    // Call 1 is the run insert (call 0 loaded the cases).
    expect(valOf(1, 'judge_model_id')).toEqual({ stringValue: 'amazon.nova-pro-v1:0' });
    expect(String(valOf(1, 'label')!['stringValue'])).toMatch(/^manual@/);
    expect(valOf(1, 'total_cases')).toEqual({ longValue: 1 });
  });

  it('honours an explicit label and judge model', async () => {
    execMock.mockResolvedValueOnce([caseRow()]).mockResolvedValue([]);
    judgeReturns([0.9]);
    await request(buildApp()).post('/api/observability/calibration/runs')
      .send({ label: '  nightly  ', judgeModelId: '  amazon.nova-lite-v1:0  ', notes: 'after the rubric change' });
    expect(valOf(1, 'label')).toEqual({ stringValue: 'nightly' });
    expect(valOf(1, 'judge_model_id')).toEqual({ stringValue: 'amazon.nova-lite-v1:0' });
    expect(valOf(1, 'notes')).toEqual({ stringValue: 'after the rubric change' });
  });

  it('upserts each result so a re-run of the same pair does not duplicate', async () => {
    execMock.mockResolvedValueOnce([caseRow()]).mockResolvedValue([]);
    judgeReturns([0.9]);
    await request(buildApp()).post('/api/observability/calibration/runs').send({});
    const resultInsert = execMock.mock.calls.find((c) => String(c[0]).includes('calibration_results'))!;
    expect(String(resultInsert[0])).toMatch(/ON CONFLICT \(calibration_run_id, calibration_id\) DO UPDATE/);
  });
});

describe('GET /runs', () => {
  it('lists newest first with a bound limit, and degrades to empty', async () => {
    execMock.mockResolvedValue([{
      calibration_run_id: 'cr-1', label: 'nightly', judge_model_id: 'amazon.nova-pro-v1:0',
      total_cases: 20, mean_abs_error: '0.11', max_abs_error: '0.3',
      started_at: '2026-08-20T09:00:00Z', finished_at: '2026-08-20T09:02:00Z', notes: null,
    }]);
    const res = await request(buildApp()).get('/api/observability/calibration/runs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['runs']);
    expect(res.body.runs[0].meanAbsError).toBe(0.11);
    expect(sqlOf(0)).toMatch(/ORDER BY started_at DESC/);
    expect(valOf(0, 'lim')!['longValue']).toBeGreaterThan(0);

    execMock.mockResolvedValue([]);
    const neverRun = await request(buildApp()).get('/api/observability/calibration/runs');
    expect(neverRun.body).toEqual({ runs: [] });

    execMock.mockRejectedValue(new Error('boom'));
    const degraded = await request(buildApp()).get('/api/observability/calibration/runs');
    expect(degraded.body).toEqual({ runs: [], degraded: true, error: 'boom' });
  });
});

describe('GET /runs/:id', () => {
  it('404s an unknown run WITHOUT going on to query its results', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/observability/calibration/runs/cr-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/calibration run not found/);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('joins the results onto the graded case so each row shows both scores', async () => {
    execMock
      .mockResolvedValueOnce([{
        calibration_run_id: 'cr-1', label: 'nightly', judge_model_id: 'amazon.nova-pro-v1:0',
        total_cases: 1, mean_abs_error: '0.2', max_abs_error: '0.2',
        started_at: 't0', finished_at: 't1', notes: null,
      }])
      .mockResolvedValueOnce([{
        calibration_run_id: 'cr-1', calibration_id: 'cc-1',
        judge_score: '0.7', judge_rationale: 'partially grounded', abs_error: '0.2',
        agent_id: 'orgiq-search', prompt: 'who owns auth', response: 'Nora Vance',
        human_score: '0.9', human_rationale: 'correct',
      }]);
    const res = await request(buildApp()).get('/api/observability/calibration/runs/cr-1');
    expect(res.status).toBe(200);
    const row = (res.body.results as Array<Record<string, unknown>>)[0]!;
    // Both halves of the comparison travel together, or the drawer cannot
    // show what the judge disagreed with.
    expect(row['judgeScore']).toBe(0.7);
    expect(row['humanScore']).toBe(0.9);
    expect(row['absError']).toBeCloseTo(0.2, 10);
    expect(Math.abs(Number(row['judgeScore']) - Number(row['humanScore'])))
      .toBeCloseTo(Number(row['absError']), 6);
  });
});
