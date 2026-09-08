// REVIEW-2026-09-05 finding 1, route level: PATCH /teams/:id/exceptions/:id
// used to accept an approve/deny from the SAME identity that staged the
// is_na claim via POST /teams/:id/scores/apply — a lead-assessor or
// program-lead holds both ScoreAssessment and ApproveException. Now:
//   - self-approval 409s with a { gate, confirmFlag } body the UI can key on
//   - a DIFFERENT lead-assessor may approve normally
//   - only admin may pass { override: true } to push past it (audit-logged)
//   - a non-admin sending override:true gets a 400, not a bypass
//
// Same harness as assessment-routes.test.ts (real router/provider/mock
// fixture; role-registry.js mocked to the real assessment .cedar capability
// lists so requireAction's seed-policy fallback makes a real decision).

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
    ] },
    { id: 'lead-assessor', tenant: 'assessment', label: 'Lead Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
      'ApproveException', 'PublishReport', 'ManageKnowledge', 'ViewObservability',
    ] },
    // '*' mirrors how role-registry.ts really records admin.cedar's
    // unconstrained permit (see lib/authz.ts's seedPolicyDecision) — without
    // this row the mocked registry would 403 admin on every requireAction
    // gate, which is the exact open-mode wildcard bug CLAUDE.md documents.
    { id: 'admin', tenant: 'assessment', label: 'Admin', summary: '', capabilities: ['*'] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Session } from '../../lib/session.js';
import * as M from '../../mock/assessment.js';

function buildApp(session: Partial<Session> = { role: 'lead-assessor', sub: 'u-lead' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-lead', role: 'lead-assessor', tenant: 'assessment', grants: {}, iat: 0, ...session } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

function freeDimensionFor(teamId: string): string {
  const team = M.findTeam(teamId)!;
  const used = new Set(team.exceptions.map((e) => e.dimension_id));
  return M.DIMENSION_IDS.find((d) => !used.has(d))!;
}

async function openException(app: express.Express, teamId: string, dim: string) {
  await request(app)
    .post(`/api/assessment/teams/${teamId}/scores/apply`)
    .send({
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 1, confidence: 'low', rationale: 'claims N/A' }],
    });
}

describe('PATCH /teams/:id/exceptions/:dimensionId — self-approval refusal', () => {
  it('409s when the same session that opened the exception tries to approve it', async () => {
    const app = buildApp({ role: 'lead-assessor', sub: 'u-lead-self' });
    const dim = freeDimensionFor('TEAM-002');
    await openException(app, 'TEAM-002', dim);

    const res = await request(app)
      .patch(`/api/assessment/teams/TEAM-002/exceptions/${dim}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ gate: 'self-approval', confirmFlag: 'override' });
  });

  it('200s when a DIFFERENT lead-assessor approves it', async () => {
    const opener = buildApp({ role: 'lead-assessor', sub: 'u-lead-a' });
    const dim = freeDimensionFor('TEAM-003');
    await openException(opener, 'TEAM-003', dim);

    const approver = buildApp({ role: 'lead-assessor', sub: 'u-lead-b' });
    const res = await request(approver)
      .patch(`/api/assessment/teams/TEAM-003/exceptions/${dim}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dimension_id: dim, status: 'approved' });
  });

  it('400s a non-admin lead-assessor who sends { override: true } — override never bypasses for a non-admin', async () => {
    const app = buildApp({ role: 'lead-assessor', sub: 'u-lead-self' });
    const dim = freeDimensionFor('TEAM-004');
    await openException(app, 'TEAM-004', dim);

    const res = await request(app)
      .patch(`/api/assessment/teams/TEAM-004/exceptions/${dim}`)
      .send({ status: 'approved', override: true });
    expect(res.status).toBe(400);
  });

  it('an existing seeded exception with no requested_by (TEAM-001 dim 7) is unaffected — still approvable by any lead-assessor', async () => {
    const res = await request(buildApp({ role: 'lead-assessor', sub: 'u-test' }))
      .patch('/api/assessment/teams/TEAM-001/exceptions/7')
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /teams/:id/exceptions/:dimensionId — admin override', () => {
  it('lets admin override a self-approval refusal with { override: true }, and refuses it silently changing nothing without the flag', async () => {
    const app = buildApp({ role: 'admin', sub: 'u-admin' });
    const dim = freeDimensionFor('TEAM-005');
    await openException(app, 'TEAM-005', dim);

    const blocked = await request(app)
      .patch(`/api/assessment/teams/TEAM-005/exceptions/${dim}`)
      .send({ status: 'approved' });
    expect(blocked.status).toBe(409);

    const overridden = await request(app)
      .patch(`/api/assessment/teams/TEAM-005/exceptions/${dim}`)
      .send({ status: 'approved', override: true });
    expect(overridden.status).toBe(200);
    expect(overridden.body).toMatchObject({ dimension_id: dim, status: 'approved' });
  });
});
