// REVIEW-2026-09-05 finding 4 (route half): POST /submissions/commit's
// "selections" shape used to just `res.json(await provider.commitSubmissions(...))`
// with no status mapping — a lost envelope_id race (see
// assessment-commit-atomicity.test.ts for the provider-level atomicity fix)
// would have come back as a 200 with a `conflict: true` row buried in the
// body, indistinguishable from success to anything that only checks the
// HTTP status. The route now 409s whenever any result row conflicted.
//
// providers/assessment.js is mocked wholesale here (route-unit test, not an
// integration test — the Aurora orchestration itself is covered by
// assessment-commit-atomicity.test.ts) so this isolates exactly the route's
// status-mapping logic added at routes/assessment.ts's
// POST /submissions/commit "selections" branch.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
    ] },
  ],
}));

jest.mock('../../providers/assessment.js', () => ({
  ...jest.requireActual('../../providers/assessment.js'),
  commitSubmissions: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { commitSubmissions } from '../../providers/assessment.js';
import { type Session } from '../../lib/session.js';

const commitMock = commitSubmissions as unknown as jest.Mock;

function buildApp(session: Partial<Session> = { role: 'assessor' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', role: 'assessor', tenant: 'assessment', grants: {}, iat: 0, ...session } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => commitMock.mockReset());

describe('POST /submissions/commit — conflict maps to 409, not a bare 200', () => {
  const BODY = { staging_token: 'tok-1', selections: [{ row_index: 0, team_id: 'TEAM-001' }] };

  it('409s when any result row carries conflict: true', async () => {
    commitMock.mockResolvedValueOnce({
      committed: [],
      results: [{ row_index: 0, team_id: 'TEAM-001', envelope_id: 'sub-x', links: [], skipped: true, conflict: true, reason: 'race' }],
    });
    const res = await request(buildApp()).post('/api/assessment/submissions/commit').send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.results[0]).toMatchObject({ conflict: true });
  });

  it('200s a normal, non-conflicting commit', async () => {
    commitMock.mockResolvedValueOnce({
      committed: ['sub-x'],
      results: [{ row_index: 0, team_id: 'TEAM-001', envelope_id: 'sub-x', links: [] }],
    });
    const res = await request(buildApp()).post('/api/assessment/submissions/commit').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['sub-x']);
  });

  it('200s when results is entirely absent (legacy-shaped result)', async () => {
    commitMock.mockResolvedValueOnce({ committed: ['sub-x'] });
    const res = await request(buildApp()).post('/api/assessment/submissions/commit').send(BODY);
    expect(res.status).toBe(200);
  });
});
