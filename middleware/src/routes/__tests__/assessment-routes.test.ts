// Route <-> test parity fill-in for routes/assessment.ts. Everything here is
// a route the validator (scripts/validate-assessment-tenant.sh, "route <->
// test parity" section) found mounted with no test calling its literal path.
// Same harness as assessment.test.ts: real router, real provider, real mock
// fixture (MOCK_AURORA path); only config.js is stubbed and role-registry.js
// is mocked to the exact assessment .cedar capability lists so requireAction
// makes a real seed-policy decision. A role with NONE of those capabilities
// ('member' — not a role this tenant's registry knows at all) is the "may
// not call it" side of every gated-route pair.

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
import { upsertSubmission, removeSubmission } from '../../mock/assessment.js';

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

// 'member' holds none of the capabilities in the mocked registry above (it
// isn't even a row in it), so every requireAction gate denies it — the
// "role that may not" half of every pair below.
const OUTSIDE_ROLE = 'member';

// ─── Feedback (HITL) ────────────────────────────────────────────────────────

describe('GET /feedback', () => {
  it('200s an assessor and lists the seeded tasks, filterable by status/team/kind', async () => {
    const res = await request(buildApp()).get('/api/assessment/feedback');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks.some((t: { task_id: string }) => t.task_id === 'fb-f66662469029')).toBe(true);

    const filtered = await request(buildApp()).get('/api/assessment/feedback?status=RESOLVED&team=TEAM-003&kind=clarification');
    expect(filtered.status).toBe(200);
    expect(filtered.body.tasks.every((t: { status: string }) => t.status === 'RESOLVED')).toBe(true);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/feedback');
    expect(res.status).toBe(403);
  });
});

describe('POST /feedback', () => {
  it('201s an assessor creating a task', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/feedback')
      .send({ team_id: 'TEAM-001', kind: 'general', question: 'Does the on-call rotation cover both repos?' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ task_id: expect.stringMatching(/^fb-/), status: 'OPEN', team_id: 'TEAM-001' });
  });

  it('400s a missing question', async () => {
    const res = await request(buildApp()).post('/api/assessment/feedback').send({ team_id: 'TEAM-001' });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/feedback').send({ question: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('GET /feedback/:taskId', () => {
  it('200s a seeded task', async () => {
    const res = await request(buildApp()).get('/api/assessment/feedback/fb-f66662469029');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_id: 'fb-f66662469029', team_id: 'TEAM-001', kind: 'exception_review' });
  });

  it('404s an unknown task id', async () => {
    const res = await request(buildApp()).get('/api/assessment/feedback/fb-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/feedback/fb-f66662469029');
    expect(res.status).toBe(403);
  });
});

describe('POST /feedback/:taskId/resolve', () => {
  it('200s an assessor resolving an OPEN task it just created', async () => {
    const created = await request(buildApp())
      .post('/api/assessment/feedback')
      .send({ team_id: 'TEAM-002', kind: 'clarification', question: 'Which repo owns the release pipeline?' });
    const taskId = created.body.task_id as string;

    const res = await request(buildApp())
      .post(`/api/assessment/feedback/${taskId}/resolve`)
      .send({ response: 'The api repo owns it — confirmed with the lead.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_id: taskId, status: 'RESOLVED', response: 'The api repo owns it — confirmed with the lead.' });
  });

  it('400s a missing response', async () => {
    const res = await request(buildApp()).post('/api/assessment/feedback/fb-f66662469029/resolve').send({});
    expect(res.status).toBe(400);
  });

  it('404s an unknown task id', async () => {
    const res = await request(buildApp()).post('/api/assessment/feedback/fb-nope/resolve').send({ response: 'x' });
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/feedback/fb-f66662469029/resolve').send({ response: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('POST /feedback/:taskId/dismiss', () => {
  it('200s an assessor dismissing an OPEN task it just created', async () => {
    const created = await request(buildApp())
      .post('/api/assessment/feedback')
      .send({ team_id: 'TEAM-003', kind: 'general', question: 'Is this still relevant post-migration?' });
    const taskId = created.body.task_id as string;

    const res = await request(buildApp()).post(`/api/assessment/feedback/${taskId}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_id: taskId, status: 'DISMISSED' });
  });

  it('404s an unknown task id', async () => {
    const res = await request(buildApp()).post('/api/assessment/feedback/fb-nope/dismiss');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).post('/api/assessment/feedback/fb-f66662469029/dismiss');
    expect(res.status).toBe(403);
  });
});

// ─── Cross-team recommendations ────────────────────────────────────────────

describe('GET /recommendations (portfolio)', () => {
  it('200s an assessor with a per-team rollup, filterable by cohort', async () => {
    const res = await request(buildApp()).get('/api/assessment/recommendations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.teams)).toBe(true);
    expect(res.body.teams.some((t: { id: string }) => t.id === 'TEAM-001')).toBe(true);

    const filtered = await request(buildApp()).get('/api/assessment/recommendations?cohort=white_glove');
    expect(filtered.status).toBe(200);
    expect(filtered.body.teams.every((t: { cohort: string }) => t.cohort === 'white_glove')).toBe(true);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/recommendations');
    expect(res.status).toBe(403);
  });
});

// ─── Per-team: recommendations, stories, evidence, provenance, scoring logs,
//     intake, reset ──────────────────────────────────────────────────────────

describe('GET /teams/:id/recommendations', () => {
  it('200s TEAM-001 with a ranked plan', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/recommendations');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ team_id: 'TEAM-001', target_level: expect.any(Number) });
    expect(Array.isArray(res.body.recommendations)).toBe(true);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../recommendations');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999/recommendations');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/teams/TEAM-001/recommendations');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/stories', () => {
  it('200s TEAM-001 with the seeded story draft', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/stories');
    expect(res.status).toBe(200);
    expect(res.body.stories.some((s: { filename: string }) => s.filename === 'story-dim1-ci-evidence.md')).toBe(true);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../stories');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999/stories');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/teams/TEAM-001/stories');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/stories/:file', () => {
  it('200s the seeded story for TEAM-001', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/stories/story-dim1-ci-evidence.md');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ filename: 'story-dim1-ci-evidence.md', team_id: 'TEAM-001', dimension_id: '1' });
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../stories/nope.md');
    expect(res.status).toBe(400);
  });

  it('404s an unknown filename', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/stories/does-not-exist.md');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .get('/api/assessment/teams/TEAM-001/stories/story-dim1-ci-evidence.md');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/evidence', () => {
  it('200s TEAM-001 with an evidence array', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/evidence');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.evidence)).toBe(true);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../evidence');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999/evidence');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/teams/TEAM-001/evidence');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/provenance', () => {
  it('200s TEAM-001 with its lineage ledger — grouped capture events, not raw evidence rows', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/provenance');
    expect(res.status).toBe(200);
    expect(res.body.team_id).toBe('TEAM-001');
    expect(res.body.items.length).toBeGreaterThan(0);
    const item = res.body.items[0];
    expect(item).toMatchObject({
      provenance_id: expect.any(String), source_uri: expect.any(String), name: expect.any(String),
      captured_at: expect.any(String), captured_by: expect.any(String), content_hash: expect.any(String),
      evidence_count: expect.any(Number), dimensions_touched: expect.any(Array),
    });
    // At least one seeded provenance record backs real scored evidence.
    expect(res.body.items.some((i: { evidence_count: number }) => i.evidence_count > 0)).toBe(true);
  });

  it('a fresh intake/text touchpoint immediately shows up as its own ledger row', async () => {
    await request(buildApp())
      .post('/api/assessment/teams/TEAM-005/intake/text')
      .send({ source_type: 'touchpoint', text: 'Discussed on-call runbook coverage.', title: 'On-call 1:1', captured_by: 'Priya Natarajan' });
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-005/provenance');
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { name: string }) => i.name === 'On-call 1:1');
    expect(row).toMatchObject({ source_type: 'touchpoint', captured_by: 'Priya Natarajan', evidence_count: 1 });
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../provenance');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999/provenance');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/teams/TEAM-001/provenance');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/scoring-logs', () => {
  it('200s TEAM-001 with the seeded scoring pass', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/scoring-logs');
    expect(res.status).toBe(200);
    expect(res.body.logs.some((l: { stamp: string }) => l.stamp === '20260831T080015Z')).toBe(true);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../scoring-logs');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999/scoring-logs');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/teams/TEAM-001/scoring-logs');
    expect(res.status).toBe(403);
  });
});

describe('GET /teams/:id/scoring-logs/:stamp', () => {
  it('200s the seeded scoring log for TEAM-001', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/scoring-logs/20260831T080015Z');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ team_id: 'TEAM-001', stamp: '20260831T080015Z', source: 'agent' });
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-../scoring-logs/20260831T080015Z');
    expect(res.status).toBe(400);
  });

  it('404s an unknown stamp', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-001/scoring-logs/19700101T000000Z');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .get('/api/assessment/teams/TEAM-001/scoring-logs/20260831T080015Z');
    expect(res.status).toBe(403);
  });
});

describe('POST /teams/:id/intake/text', () => {
  it('201s an assessor logging a text excerpt for TEAM-001', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams/TEAM-001/intake/text')
      .send({ dimension_id: '3', text: 'Runbook covers failover for both regions.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dimension_id: '3', source_type: 'document', status: 'PENDING' });
  });

  it('400s a missing text field', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-001/intake/text').send({});
    expect(res.status).toBe(400);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-../intake/text').send({ text: 'x' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-999/intake/text').send({ text: 'x' });
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/teams/TEAM-001/intake/text').send({ text: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('POST /teams/:id/intake/image', () => {
  it('201s an assessor logging a pasted screenshot for TEAM-001', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams/TEAM-001/intake/image')
      .send({ dimension_id: '5', filename: 'ci-dashboard.png' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dimension_id: '5', source_type: 'artifact', status: 'PENDING' });
    expect(res.body.excerpt).toContain('ci-dashboard.png');
  });

  it('400s a missing filename', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-001/intake/image').send({});
    expect(res.status).toBe(400);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-../intake/image').send({ filename: 'x.png' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-999/intake/image').send({ filename: 'x.png' });
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/teams/TEAM-001/intake/image').send({ filename: 'x.png' });
    expect(res.status).toBe(403);
  });
});

describe('POST /teams/:id/reset-assessment', () => {
  it('200s an assessor resetting TEAM-003 back to NEW', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-003/reset-assessment');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await request(buildApp()).get('/api/assessment/teams/TEAM-003');
    expect(after.body.team.status).toBe('NEW');
    expect(after.body.dimensions.every((d: { current_level: number | null }) => d.current_level === null)).toBe(true);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-../reset-assessment');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams/TEAM-999/reset-assessment');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).post('/api/assessment/teams/TEAM-004/reset-assessment');
    expect(res.status).toBe(403);
  });
});

// ─── Submissions ────────────────────────────────────────────────────────────

describe('GET /submissions', () => {
  it('200s an assessor with the envelope listing and grouped-by-base view', async () => {
    const res = await request(buildApp()).get('/api/assessment/submissions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.envelopes)).toBe(true);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(res.body.envelopes.some((e: { envelope_id: string }) => e.envelope_id === 'sub-20260810T091500Z-form5-jordan-lee')).toBe(true);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/submissions');
    expect(res.status).toBe(403);
  });
});

describe('GET /submissions/:team/:envelope', () => {
  it('200s the seeded TEAM-002 envelope', async () => {
    const res = await request(buildApp())
      .get('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ envelope_id: 'sub-20260810T091500Z-form5-jordan-lee', team_id: 'TEAM-002' });
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).get('/api/assessment/submissions/TEAM-../whatever');
    expect(res.status).toBe(400);
  });

  it('404s an unknown envelope on a real team', async () => {
    const res = await request(buildApp()).get('/api/assessment/submissions/TEAM-002/sub-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .get('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee');
    expect(res.status).toBe(403);
  });
});

describe('PATCH /submissions/:team/:envelope/links', () => {
  it('200s an assessor marking a dimension link fetched', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee/links')
      .send({ dimension_id: '5', status: 'fetched' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ envelope_id: 'sub-20260810T091500Z-form5-jordan-lee' });
  });

  it('400s a missing status', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee/links')
      .send({ dimension_id: '5' });
    expect(res.status).toBe(400);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/submissions/TEAM-../nope/links').send({});
    expect(res.status).toBe(400);
  });

  it('404s an unknown envelope', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/submissions/TEAM-002/sub-nope/links')
      .send({ dimension_id: '5', status: 'fetched' });
    expect(res.status).toBe(404);
  });

  it('403s a role with no ManageSubmissions', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .patch('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee/links')
      .send({ dimension_id: '5', status: 'fetched' });
    expect(res.status).toBe(403);
  });
});

// Matching semantics against a real envelope carrying `links[]` — the seeded
// TEAM-002 fixture above predates evidence links, so it can only exercise the
// "no matching link, still 200" no-op path. `dimension_id` is nullable on an
// unmatched link, so url must work as an identifier on its own too.
describe('PATCH /submissions/:team/:envelope/links — url/dimension_id matching', () => {
  const teamId = 'TEAM-002';
  const envelopeId = 'sub-test-links-fixture';

  beforeEach(() => {
    upsertSubmission({
      schema_version: '1.0',
      envelope_id: envelopeId,
      source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: 'x.csv', origin_row: 1, form_submission_id: '1' },
      team_id: teamId,
      team_name_raw: 'Kubernetes Operator',
      submitter: { name: 'Test User', email: 'test@example.com', is_primary_contact: true },
      submitted_at: '1/1/2026 00:00',
      ingested_at: new Date().toISOString(),
      assessment_date: '1/1/2026 00:00',
      self_certified: true,
      supersedes: null,
      dimension_hints: [],
      links: [
        { url: 'https://example.com/evidence-a', label: 'Evidence A', dimension_id: '3', status: 'pending' },
        { url: 'https://example.com/evidence-b', label: 'Evidence B', dimension_id: null, status: 'pending' },
      ],
      status: 'committed',
      revision: 1,
    });
  });

  afterEach(() => {
    removeSubmission(teamId, envelopeId);
  });

  it('matches and updates a link by url, including one with a null dimension_id', async () => {
    const res = await request(buildApp())
      .patch(`/api/assessment/submissions/${teamId}/${envelopeId}/links`)
      .send({ url: 'https://example.com/evidence-b', dimension_id: null, status: 'skipped' });
    expect(res.status).toBe(200);
    const link = (res.body.links as Array<{ url: string; status: string }>).find((l) => l.url === 'https://example.com/evidence-b');
    expect(link?.status).toBe('skipped');
  });

  it('matches and updates a link by dimension_id when no url is given', async () => {
    const res = await request(buildApp())
      .patch(`/api/assessment/submissions/${teamId}/${envelopeId}/links`)
      .send({ dimension_id: '3', status: 'fetched' });
    expect(res.status).toBe(200);
    const link = (res.body.links as Array<{ dimension_id: string | null; status: string }>).find((l) => l.dimension_id === '3');
    expect(link?.status).toBe('fetched');
  });

  it('400s when neither url nor dimension_id is given', async () => {
    const res = await request(buildApp())
      .patch(`/api/assessment/submissions/${teamId}/${envelopeId}/links`)
      .send({ status: 'fetched' });
    expect(res.status).toBe(400);
  });
});

describe('POST /submissions/parse', () => {
  it('200s an assessor classifying rows against known teams', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/parse')
      .send({ rows: [{ team_name_raw: 'Kubernetes Operator' }, { team_name_raw: 'No Such Team' }] });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { team_id: 'TEAM-002', team_name_raw: 'Kubernetes Operator', classification: 'seen' },
      { team_id: null, team_name_raw: 'No Such Team', classification: 'unknown' },
    ]);
  });

  it('400s a non-array rows field', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ rows: 'nope' });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ManageSubmissions', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/submissions/parse').send({ rows: [] });
    expect(res.status).toBe(403);
  });
});

describe('POST /submissions/commit', () => {
  it('200s an assessor committing a real envelope', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit')
      .send({ team_id: 'TEAM-002', envelope_ids: ['sub-20260810T091500Z-form5-jordan-lee'] });
    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['sub-20260810T091500Z-form5-jordan-lee']);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit').send({ team_id: 'TEAM-..', envelope_ids: ['x'] });
    expect(res.status).toBe(400);
  });

  it('400s an empty envelope_ids array', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit').send({ team_id: 'TEAM-002', envelope_ids: [] });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/submissions/commit').send({ team_id: 'TEAM-002', envelope_ids: ['x'] });
    expect(res.status).toBe(403);
  });
});

// A small, realistic Microsoft Forms export for dimension 1 (Continuous
// Integration): metadata + self-cert + the two positional question columns
// preceding "Evidence / Additional Context for Dimension 1" + a rating-matrix
// column, mirroring forms_mapping.yaml's real header text.
const FORMS_HEADERS_ROW = {
  Id: '5',
  'Completion time': '8/20/2026 09:00',
  Email: 'jamie.lee@example.com',
  Name: 'Jamie Lee',
  'What is your team name?': 'Kubernetes Operator',
  'What went well with CI this quarter?': 'Good CI coverage across services.',
  'What obstacles remain for CI?': 'Occasional flaky tests.',
  'Evidence / Additional Context for Dimension 1': 'See https://github.com/example/k8s-operator/actions for pipeline history.',
  'Upload Evidence for Dimension 1': '',
  "How would you rate your team's SDLC maturity?.Continuous Integration (CI)": 'Leading',
  'I confirm that the information provided is accurate to the best of my knowledge': 'I confirm this is accurate.',
};
const FORMS_UNKNOWN_TEAM_ROW = {
  Id: '99',
  'Completion time': '8/21/2026 10:00',
  Email: 'taylor@example.com',
  Name: 'Taylor Fox',
  'What is your team name?': 'Ghost Team',
  'What went well with CI this quarter?': '',
  'What obstacles remain for CI?': '',
  'Evidence / Additional Context for Dimension 1': '',
  'Upload Evidence for Dimension 1': '',
  "How would you rate your team's SDLC maturity?.Continuous Integration (CI)": '',
  'I confirm that the information provided is accurate to the best of my knowledge': '',
};

describe('POST /submissions/parse — Forms CSV records', () => {
  it('200s and maps a real Forms export into ParsedRow shape, seen/unknown_team, links, and dimensions_informed', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/parse')
      .send({ source_file: 'forms-export.csv', records: [FORMS_HEADERS_ROW, FORMS_UNKNOWN_TEAM_ROW] });

    expect(res.status).toBe(200);
    expect(typeof res.body.staging_token).toBe('string');
    expect(res.body.staging_token.length).toBeGreaterThan(0);
    expect(res.body.source_file).toBe('forms-export.csv');
    expect(res.body.mapping_warnings).toEqual([]);
    expect(res.body.rows).toEqual([
      {
        row_index: 0, form_id: '5', status: 'seen', team_id: 'TEAM-002', team_name_raw: 'Kubernetes Operator',
        classification: 'seen', submitter_name: 'Jamie Lee', submitter_email: 'jamie.lee@example.com',
        submitted_at: '8/20/2026 09:00', self_certified: true, dimensions_informed: 1,
        links: [{ url: 'https://github.com/example/k8s-operator/actions', label: 'Evidence / Additional Context for Dimension 1', dimension_id: '1' }],
      },
      {
        row_index: 1, form_id: '99', status: 'unknown_team', team_id: null, team_name_raw: 'Ghost Team',
        classification: 'unknown', submitter_name: 'Taylor Fox', submitter_email: 'taylor@example.com',
        submitted_at: '8/21/2026 10:00', self_certified: false, dimensions_informed: 0, links: [],
      },
    ]);
  });

  it('400s a non-array records field', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ records: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400s a non-object records element', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/parse').send({ records: ['nope'] });
    expect(res.status).toBe(400);
  });
});

describe('POST /submissions/commit — staging_token / selections', () => {
  it('commits a staged row into a new envelope, superseding the prior committed revision, then it is visible via GET /submissions', async () => {
    const parseRes = await request(buildApp())
      .post('/api/assessment/submissions/parse')
      .send({ source_file: 'forms-export.csv', records: [FORMS_HEADERS_ROW] });
    const stagingToken = parseRes.body.staging_token as string;

    const commitRes = await request(buildApp())
      .post('/api/assessment/submissions/commit')
      .send({ staging_token: stagingToken, selections: [{ row_index: 0, team_id: 'TEAM-002' }] });

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.committed).toEqual(['sub-20260810T091500Z-form5-jordan-lee-r4']);
    expect(commitRes.body.results).toEqual([
      {
        row_index: 0, team_id: 'TEAM-002', envelope_id: 'sub-20260810T091500Z-form5-jordan-lee-r4',
        links: [{ url: 'https://github.com/example/k8s-operator/actions', label: 'Evidence / Additional Context for Dimension 1', dimension_id: '1', status: 'pending' }],
      },
    ]);

    const detail = await request(buildApp())
      .get('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee-r4');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      revision: 4, status: 'committed', supersedes: 'sub-20260810T091500Z-form5-jordan-lee-r3',
      team_name_raw: 'Kubernetes Operator', submitter: { name: 'Jamie Lee', email: 'jamie.lee@example.com' },
    });
    expect(detail.body.dimension_hints).toEqual([
      {
        dimension_id: '1', main_answer: 'Good CI coverage across services.', matched_level: null,
        follow_up_answer: 'Occasional flaky tests.',
        evidence_context: 'See https://github.com/example/k8s-operator/actions for pipeline history.',
        self_rating: 'Leading', self_rating_aspect: 'Continuous Integration (CI)', claimed_na: false,
      },
    ]);

    const superseded = await request(buildApp())
      .get('/api/assessment/submissions/TEAM-002/sub-20260810T091500Z-form5-jordan-lee-r3');
    expect(superseded.body.status).toBe('superseded');
  });

  it('404s an unknown or expired staging token', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit')
      .send({ staging_token: 'not-a-real-token', selections: [{ row_index: 0, team_id: 'TEAM-002' }] });
    expect(res.status).toBe(404);
  });

  it('400s a selection missing team_id', async () => {
    const parseRes = await request(buildApp())
      .post('/api/assessment/submissions/parse')
      .send({ source_file: 'forms-export.csv', records: [FORMS_HEADERS_ROW] });
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit')
      .send({ staging_token: parseRes.body.staging_token, selections: [{ row_index: 0 }] });
    expect(res.status).toBe(400);
  });

  it('skips a selection whose row_index is not in the staged parse, without failing the whole commit', async () => {
    const parseRes = await request(buildApp())
      .post('/api/assessment/submissions/parse')
      .send({ source_file: 'forms-export.csv', records: [FORMS_HEADERS_ROW] });
    const res = await request(buildApp())
      .post('/api/assessment/submissions/commit')
      .send({ staging_token: parseRes.body.staging_token, selections: [{ row_index: 99, team_id: 'TEAM-002' }] });
    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual([]);
    expect(res.body.results[0]).toMatchObject({ row_index: 99, skipped: true });
  });
});

describe('POST /submissions/clear', () => {
  it('200s an assessor clearing targets, reporting how many actually existed', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/clear')
      .send({ targets: [{ team_id: 'TEAM-002', envelope_id: 'sub-does-not-exist' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: 0 });
  });

  it('400s a traversal-shaped team id inside a target', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/submissions/clear')
      .send({ targets: [{ team_id: 'TEAM-..', envelope_id: 'x' }] });
    expect(res.status).toBe(400);
  });

  it('400s a non-array targets field', async () => {
    const res = await request(buildApp()).post('/api/assessment/submissions/clear').send({ targets: 'nope' });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ManageSubmissions', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/submissions/clear').send({ targets: [] });
    expect(res.status).toBe(403);
  });
});

// ─── Team lifecycle — the backend the (not-yet-wired) TeamActionsMenu /
//     CohortActionsMenu need: create, rename/reassign lead, delete. The
//     validator's path-only matcher already considered these "tested" via
//     GET /teams(/:id) sharing the same literal path, but the verbs
//     themselves had no assertions until now. ────────────────────────────────

describe('POST /teams (create)', () => {
  it('201s an assessor creating a team with a deterministic TEAM-0NN id', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/teams')
      .send({ name: 'Fraud Detection ML', cohort: 'self_service', assessment_lead: 'Dana Osei' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^TEAM-\d{3}$/), name: 'Fraud Detection ML', cohort: 'self_service',
      assessment_lead: 'Dana Osei', status: 'NEW', workflow_step: 1,
    });

    const detail = await request(buildApp()).get(`/api/assessment/teams/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.dimensions).toHaveLength(17);
  });

  it('400s a missing name', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams').send({ cohort: 'general' });
    expect(res.status).toBe(400);
  });

  it('400s an invalid cohort', async () => {
    const res = await request(buildApp()).post('/api/assessment/teams').send({ name: 'x', cohort: 'nope' });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/teams').send({ name: 'x', cohort: 'general' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /teams/:id (rename / reassign lead / status)', () => {
  it('200s an assessor updating name, lead and status', async () => {
    const res = await request(buildApp())
      .patch('/api/assessment/teams/TEAM-004')
      .send({ name: 'Renamed Team', assessment_lead: 'New Lead', status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'TEAM-004', name: 'Renamed Team', assessment_lead: 'New Lead', status: 'IN_PROGRESS' });
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).patch('/api/assessment/teams/TEAM-..').send({ name: 'x' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).patch('/api/assessment/teams/TEAM-999').send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).patch('/api/assessment/teams/TEAM-004').send({ name: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /teams/:id', () => {
  it('200s an assessor deleting a freshly created team, and it is gone after', async () => {
    const created = await request(buildApp())
      .post('/api/assessment/teams').send({ name: 'Throwaway', cohort: 'general' });
    const id = created.body.id as string;

    const res = await request(buildApp()).delete(`/api/assessment/teams/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await request(buildApp()).get(`/api/assessment/teams/${id}`);
    expect(after.status).toBe(404);
  });

  it('400s a traversal-shaped team id', async () => {
    const res = await request(buildApp()).delete('/api/assessment/teams/TEAM-..');
    expect(res.status).toBe(400);
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).delete('/api/assessment/teams/TEAM-999');
    expect(res.status).toBe(404);
  });

  it('403s a role with no ScoreAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).delete('/api/assessment/teams/TEAM-006');
    expect(res.status).toBe(403);
  });
});

// ─── Workspace (knowledge tree alias) ───────────────────────────────────────

describe('GET /workspace', () => {
  it('200s an assessor with the same shape as /knowledge/tree', async () => {
    const [workspace, tree] = await Promise.all([
      request(buildApp()).get('/api/assessment/workspace'),
      request(buildApp()).get('/api/assessment/knowledge/tree'),
    ]);
    expect(workspace.status).toBe(200);
    expect(Array.isArray(workspace.body.sections)).toBe(true);
    expect(workspace.body).toEqual(tree.body);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE })).get('/api/assessment/workspace');
    expect(res.status).toBe(403);
  });
});
