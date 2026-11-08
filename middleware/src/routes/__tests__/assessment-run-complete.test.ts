// REVIEW-2026-09-05 finding 3, route wiring: POST /runs/:runId/complete is
// an AGENT CALLBACK — a deployed (or `agentcore dev`-run) orgiq-assessment-
// scorer hits it with NO session, same shape as
// POST /api/observability/harness/trace (requireTraceAuth). Two things this
// asserts that a plain requireAction/requireTenant gate would get wrong:
//   1. It must be reachable with no session cookie at all (open when
//      ASSESSMENT_RUN_COMPLETE_SECRET is unset — the dev default).
//   2. When the secret IS set, a missing/wrong header is a 401, a matching
//      header succeeds — and every OTHER route on this router still 401s a
//      sessionless caller (the tenant gate was moved INTO the router to
//      carve out this one exemption, not disabled wholesale).
//
// providers/assessment.js is mocked (route-unit test — the actual
// mock/Aurora completion logic is covered in
// assessment-run-completion(.aurora).test.ts) so this isolates the route's
// auth gate, validation, and status-code mapping.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../providers/assessment.js', () => ({
  ...jest.requireActual('../../providers/assessment.js'),
  completeRun: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { completeRun } from '../../providers/assessment.js';

const completeRunMock = completeRun as unknown as jest.Mock;

function buildApp() {
  // No session middleware at all — mirrors the real deployment, where this
  // route is hit by a service with no cookie.
  const app = express();
  app.use(express.json());
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

const ORIGINAL_SECRET = process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
afterEach(() => {
  completeRunMock.mockReset();
  if (ORIGINAL_SECRET === undefined) delete process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
  else process.env['ASSESSMENT_RUN_COMPLETE_SECRET'] = ORIGINAL_SECRET;
});

describe('POST /runs/:runId/complete — sessionless agent callback', () => {
  it('is reachable with no session cookie when no secret is configured (INSECURE_DEV_MODE, the jest setup)', async () => {
    delete process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
    completeRunMock.mockResolvedValueOnce({
      ok: true,
      run: { id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-002', args: {}, status: 'completed', source: 'agent', started_at: 't0', finished_at: 't1', summary: 'done', error: null, files_written: [] },
    });
    const res = await request(buildApp()).post('/api/assessment/runs/run-1/complete').send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'run-1', status: 'completed' });
    expect(completeRunMock).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'completed' }));
  });

  it('401s when a secret is configured and no header is sent', async () => {
    process.env['ASSESSMENT_RUN_COMPLETE_SECRET'] = 'topsecret';
    const res = await request(buildApp()).post('/api/assessment/runs/run-1/complete').send({ status: 'completed' });
    expect(res.status).toBe(401);
    expect(completeRunMock).not.toHaveBeenCalled();
  });

  it('401s a wrong header value', async () => {
    process.env['ASSESSMENT_RUN_COMPLETE_SECRET'] = 'topsecret';
    const res = await request(buildApp())
      .post('/api/assessment/runs/run-1/complete')
      .set('x-assessment-run-auth', 'nope')
      .send({ status: 'completed' });
    expect(res.status).toBe(401);
  });

  it('200s with the matching static header only while SERVICE_AUTH_LEGACY_HEADERS=accept (unset refuses it)', async () => {
    process.env['ASSESSMENT_RUN_COMPLETE_SECRET'] = 'topsecret';
    const unsetFlag = await request(buildApp())
      .post('/api/assessment/runs/run-1/complete')
      .set('x-assessment-run-auth', 'topsecret')
      .send({ status: 'completed' });
    expect(unsetFlag.status).toBe(401);
    process.env['SERVICE_AUTH_LEGACY_HEADERS'] = 'accept';
    completeRunMock.mockResolvedValueOnce({
      ok: true,
      run: { id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-002', args: {}, status: 'completed', source: 'agent', started_at: 't0', finished_at: 't1', summary: 'done', error: null, files_written: [] },
    });
    const res = await request(buildApp())
      .post('/api/assessment/runs/run-1/complete')
      .set('x-assessment-run-auth', 'topsecret')
      .send({ status: 'completed' });
    delete process.env['SERVICE_AUTH_LEGACY_HEADERS'];
    expect(res.status).toBe(200);
  });

  it('400s an invalid status', async () => {
    delete process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
    const res = await request(buildApp()).post('/api/assessment/runs/run-1/complete').send({ status: 'done' });
    expect(res.status).toBe(400);
    expect(completeRunMock).not.toHaveBeenCalled();
  });

  it('passes summary/error/files_written/scoring_log through to the provider', async () => {
    delete process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
    completeRunMock.mockResolvedValueOnce({
      ok: true,
      run: { id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-002', args: {}, status: 'failed', source: 'agent', started_at: 't0', finished_at: 't1', summary: '', error: 'boom', files_written: [] },
    });
    const body = {
      status: 'failed', error: 'boom', files_written: ['workspace/x.json'],
      scoring_log: [{ dimension_id: '10', is_na: false, suggested_level: 3, confidence: 'moderate', rationale: 'x', evidence_excerpts: [], follow_up_questions: [], na_claimed: false, self_claimed_level: null, evidence_class: null, cap_applied: false }],
    };
    const res = await request(buildApp()).post('/api/assessment/runs/run-1/complete').send(body);
    expect(res.status).toBe(200);
    expect(completeRunMock).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'failed', error: 'boom', files_written: ['workspace/x.json'], scoring_log: body.scoring_log,
    }));
  });

  it('maps a provider 404/409 straight through', async () => {
    delete process.env['ASSESSMENT_RUN_COMPLETE_SECRET'];
    completeRunMock.mockResolvedValueOnce({ ok: false, status: 409, reason: 'run is already completed' });
    const res = await request(buildApp()).post('/api/assessment/runs/run-1/complete').send({ status: 'completed' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'run is already completed' });
  });

  it('every OTHER route on this router still gates a sessionless caller — the exemption is scoped to /complete only', async () => {
    // No cookie -> resolveSession() falls back to the dev-only demo
    // identity (tenant 'orgiq', role 'member'), which requireTenant then
    // rejects for the 'assessment' tenant this router requires — a 403,
    // not a 401, but still definitively NOT a 200: the tenant gate this
    // router now applies itself (moved off the index.ts mount to carve out
    // /complete) is still doing its job for every other route.
    const res = await request(buildApp()).get('/api/assessment/teams');
    expect(res.status).toBe(403);
  });
});
