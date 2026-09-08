// routes/assessment.ts — code-review findings around missing input
// validation, against the real router, real provider, and real mock fixture
// (MOCK_AURORA path). Only config.js is stubbed to force the mock path on,
// same pattern as assessment.test.ts / assessment-tenant-gate.test.ts.
//
// Covers:
//  - PATCH /teams/:id validates cohort/name/status instead of forwarding
//    them straight into the store (a bogus cohort used to make every caller
//    of GET /rollup throw).
//  - PUT /configuration validates `motions` shape and that target_level is
//    an integer, instead of the `as { motions?: never }` cast letting
//    anything through.
//  - POST /submissions/parse rows, POST /submissions/clear targets, and
//    POST /teams/:id/scores/apply scores entries all 400 on a non-object
//    array element instead of 500ing when the route reads a property off it.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
    ] },
    { id: 'program-lead', tenant: 'assessment', label: 'Program Lead', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
      'ApproveException', 'PublishReport', 'ManageKnowledge', 'ViewObservability',
      'ManageAssessmentConfig', 'ManageUsers',
    ] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Session } from '../../lib/session.js';

function buildApp(session: Partial<Session> = { role: 'program-lead' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', role: 'program-lead', tenant: 'assessment', grants: {}, iat: 0, ...session } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

describe('PATCH /teams/:id — cohort/name/status validation', () => {
  it('400s a bogus cohort, and GET /rollup still 200s afterward', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/assessment/teams/TEAM-003').send({ cohort: 'made_up' });
    expect(res.status).toBe(400);

    const rollup = await request(app).get('/api/assessment/rollup');
    expect(rollup.status).toBe(200);
  });

  it('400s a bogus status', async () => {
    const res = await request(buildApp()).patch('/api/assessment/teams/TEAM-003').send({ status: 'MADE_UP' });
    expect(res.status).toBe(400);
  });

  it('400s a blank name', async () => {
    const res = await request(buildApp()).patch('/api/assessment/teams/TEAM-003').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('200s a legitimate patch', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/teams/TEAM-003')
      .send({ cohort: 'general', status: 'IN_PROGRESS', name: 'Renamed Team' });
    expect(res.status).toBe(200);
    expect(res.body.cohort).toBe('general');
  });
});

describe('PUT /configuration — target_level and motions validation', () => {
  it('400s a non-integer target_level', async () => {
    const res = await request(buildApp()).put('/api/assessment/configuration').send({ target_level: 2.5 });
    expect(res.status).toBe(400);
  });

  it('400s motions that are not an array', async () => {
    const res = await request(buildApp()).put('/api/assessment/configuration').send({ motions: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400s a motion missing required MotionConfig keys', async () => {
    const res = await request(buildApp())
      .put('/api/assessment/configuration')
      .send({ motions: [{ cohort: 'general', title: 'General' }] }); // missing tag/accent/description
    expect(res.status).toBe(400);
  });

  it('400s a motion with an invalid cohort', async () => {
    const res = await request(buildApp())
      .put('/api/assessment/configuration')
      .send({ motions: [{ cohort: 'made_up', title: 'T', tag: 'TAG', accent: '#000', description: 'd' }] });
    expect(res.status).toBe(400);
  });

  it('200s a well-formed motions array', async () => {
    const res = await request(buildApp())
      .put('/api/assessment/configuration')
      .send({ motions: [{ cohort: 'general', title: 'General', tag: 'STANDARD', accent: '#5B6472', description: 'd' }] });
    expect(res.status).toBe(200);
  });
});

describe('POST /submissions/parse — row shape validation', () => {
  it('400s a non-object row', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ rows: ['not-an-object'] });
    expect(res.status).toBe(400);
  });

  it('400s a row missing team_name_raw', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ rows: [{}] });
    expect(res.status).toBe(400);
  });

  it('200s a well-formed row', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ rows: [{ team_name_raw: 'Some Team' }] });
    expect(res.status).toBe(200);
  });
});

describe('POST /submissions/clear — targets shape validation', () => {
  it('400s a non-object target', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/clear').send({ targets: [null] });
    expect(res.status).toBe(400);
  });

  it('200s an empty targets array', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/clear').send({ targets: [] });
    expect(res.status).toBe(200);
  });
});

describe('POST /teams/:id/scores/apply — scores entry shape validation', () => {
  it('400s a non-object scores entry', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams/TEAM-006/scores/apply')
      .send({ relevant_dimension_ids: ['1'], scores: ['nope'] });
    expect(res.status).toBe(400);
  });

  it('400s evidence_excerpts that is not an array', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams/TEAM-006/scores/apply')
      .send({
        relevant_dimension_ids: ['1'],
        scores: [{ dimension_id: '1', suggested_level: 2, confidence: 'moderate', rationale: 'x', evidence_excerpts: 'not-an-array' }],
      });
    expect(res.status).toBe(400);
  });

  it('200s a well-formed scores entry', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams/TEAM-006/scores/apply')
      .send({
        relevant_dimension_ids: ['1'],
        scores: [{ dimension_id: '1', suggested_level: 2, confidence: 'moderate', rationale: 'x' }],
      });
    expect(res.status).toBe(200);
  });
});
