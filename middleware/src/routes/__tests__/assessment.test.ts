// Assessment route tests (routes/assessment.ts) against the real router,
// real provider, and real mock fixture (MOCK_AURORA path) — only config.js
// is stubbed to force the mock path on. Cedar gating runs for real too (no
// policy store in tests -> the seed-policy fallback reads the actual
// middleware/seeds/roles/assessment/*.cedar files), so role checks here are
// the real ones, not a stand-in.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

// role-registry.ts reads import.meta.url at module scope (and stats the seeds
// directory on load), which ts-jest's CommonJS transform cannot import — same
// constraint documented in routes/__tests__/identity.test.ts. Rather than
// bypass requireAction entirely (that would test nothing about role gating),
// this mocks role-registry.js's OUTPUT to exactly the capability lists in
// middleware/seeds/roles/assessment/*.cedar, so requireAction's real
// seed-policy fallback (lib/authz.ts evaluate(), no AVP policy store in
// tests) makes the real per-role decision against real data.
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
import http from 'node:http';
import request, { attachToSharedServer } from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Session } from '../../lib/session.js';
import { assessmentBroker, type AssessmentEvent } from '../../lib/assessment-broker.js';

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

describe('GET /teams — TeamSummary shape', () => {
  it('returns every seeded team with the TeamSummary field list', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const t002 = res.body.find((t: { id: string }) => t.id === 'TEAM-002');
    expect(t002).toMatchObject({
      id: 'TEAM-002', name: expect.any(String), cohort: expect.any(String),
      cohort_label: expect.any(String), status: expect.any(String),
      assessment_lead: expect.any(String), workflow_step: expect.any(Number),
      workflow_step_label: expect.any(String), dimensions_assessed: expect.any(Number),
      dimensions_total: 17, followups_open: expect.any(Number), updated_at: expect.any(String),
    });
    expect(t002.certification).toMatchObject({ target_level: expect.any(Number), headline: expect.any(String) });
    expect(Array.isArray(t002.contributors)).toBe(true);
  });
});

describe('GET /teams/:id — TeamDetailResponse shape', () => {
  it('returns team + workflow_steps + all 17 dimensions for TEAM-002', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-002');
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({
      id: 'TEAM-002', name: expect.any(String), cohort: expect.any(String), contacts: expect.any(Array), repos: expect.any(Array),
    });
    expect(res.body.workflow_steps).toHaveLength(6);
    expect(res.body.dimensions).toHaveLength(17);
    const dim1 = res.body.dimensions.find((d: { id: string }) => d.id === '1');
    expect(dim1).toMatchObject({
      id: '1', title: expect.any(String), definition: expect.any(String), na_description: expect.any(String),
      confidence: expect.any(String), rubric_levels: expect.any(Array), evidence: expect.any(Array),
      follow_up_questions: expect.any(Array), history: expect.any(Array),
    });
    expect(dim1.rubric_levels).toHaveLength(6);
    expect(dim1.certification).toMatchObject({ target_level: expect.any(Number) });
  });

  it('404s an unknown team', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-999');
    expect(res.status).toBe(404);
  });
});

describe('team id validation (400, not a 500 or a path traversal)', () => {
  it('rejects an id with no TEAM- prefix', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/nope');
    expect(res.status).toBe(400);
  });

  it('rejects a traversal-shaped id (dots are not in the allowed charset)', async () => {
    const res = await request(buildApp()).get('/api/assessment/teams/TEAM-..');
    expect(res.status).toBe(400);
  });
});

describe('exceptions PATCH: separation of duties', () => {
  it('403s an assessor', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .patch('/api/assessment/teams/TEAM-001/exceptions/7')
      .send({ status: 'approved' });
    expect(res.status).toBe(403);
  });

  it('200s a lead-assessor and flips the requested exception to approved', async () => {
    const res = await request(buildApp({ role: 'lead-assessor' }))
      .patch('/api/assessment/teams/TEAM-001/exceptions/7')
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dimension_id: '7', status: 'approved' });
  });
});

describe('POST /teams/:id/scores/apply — per-entry validation', () => {
  it('reports rejected entries for an unknown dimension and an invalid confidence, without 500ing', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/teams/TEAM-006/scores/apply')
      .send({
        relevant_dimension_ids: ['18', '2'],
        scores: [
          { dimension_id: '18', suggested_level: 3, confidence: 'moderate', rationale: 'bad dim' },
          { dimension_id: '2', suggested_level: 3, confidence: 'medium', rationale: 'bad confidence' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toHaveLength(0);
    expect(res.body.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension_id: '18', reason: expect.stringMatching(/unknown dimension/) }),
      expect.objectContaining({ dimension_id: '2', reason: expect.stringMatching(/invalid confidence/) }),
    ]));
  });

  it('caps a self-rating-only suggestion at Level 3', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/teams/TEAM-007/scores/apply')
      .send({
        relevant_dimension_ids: ['6'],
        scores: [{ dimension_id: '6', suggested_level: 5, confidence: 'low', rationale: 'self-report', evidence_class: 'attested' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([{ dimension_id: '6', current_level: 3, cap_applied: true }]);
  });
});

describe('POST /runs — duplicate guard and concurrency cap', () => {
  it('202s, then 409s an identical (command, team) while it is still running', async () => {
    const first = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/runs')
      .send({ command: 'score-dimensions', team_id: 'TEAM-005' });
    expect(first.status).toBe(202);
    expect(first.body.run_id).toMatch(/^run-/);

    const second = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/runs')
      .send({ command: 'score-dimensions', team_id: 'TEAM-005' });
    expect(second.status).toBe(409);
  });

  it('429s once three runs are already in flight', async () => {
    // The mock fixture seeds one running record (TEAM-003 score-dimensions);
    // the test above added a second (TEAM-005 score-dimensions). One more
    // distinct (command, team) pair reaches the cap of 3.
    await request(buildApp({ role: 'assessor' })).post('/api/assessment/runs')
      .send({ command: 'classify-transcript', team_id: 'TEAM-004' });

    const capped = await request(buildApp({ role: 'assessor' })).post('/api/assessment/runs')
      .send({ command: 'draw-diagram', team_id: 'TEAM-001' });
    expect(capped.status).toBe(429);
  });

  it('400s an unrecognized command', async () => {
    const res = await request(buildApp({ role: 'assessor' })).post('/api/assessment/runs').send({ command: 'rm-rf' });
    expect(res.status).toBe(400);
  });
});

describe('knowledge doc: PUT creates a version, restore brings old content back', () => {
  const DOC_ID = 'ec:tooling/approved-tools.md';

  it('round-trips through PUT -> versions -> restore', async () => {
    const before = await request(buildApp()).get(`/api/assessment/knowledge/doc?id=${encodeURIComponent(DOC_ID)}`);
    expect(before.status).toBe(200);
    const originalMarkdown = before.body.markdown;

    const put = await request(buildApp({ role: 'lead-assessor' }))
      .put('/api/assessment/knowledge/doc')
      .send({ id: DOC_ID, markdown: '# replaced content\n' });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    const versions = await request(buildApp()).get(`/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(DOC_ID)}`);
    expect(versions.status).toBe(200);
    const snapshot = versions.body.versions.find((v: { markdown: string }) => v.markdown === originalMarkdown);
    expect(snapshot).toBeTruthy();

    const restore = await request(buildApp({ role: 'lead-assessor' }))
      .post('/api/assessment/knowledge/doc/restore')
      .send({ id: DOC_ID, stamp: snapshot.stamp });
    expect(restore.status).toBe(200);

    const after = await request(buildApp()).get(`/api/assessment/knowledge/doc?id=${encodeURIComponent(DOC_ID)}`);
    expect(after.body.markdown).toBe(originalMarkdown);
  });

  it('403s an assessor writing to knowledge (ManageKnowledge is lead-assessor+)', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .put('/api/assessment/knowledge/doc')
      .send({ id: DOC_ID, markdown: 'nope' });
    expect(res.status).toBe(403);
  });
});

describe('gating: program-lead-only configuration', () => {
  it('403s a lead-assessor changing the target level', async () => {
    const res = await request(buildApp({ role: 'lead-assessor' }))
      .put('/api/assessment/configuration')
      .send({ target_level: 4 });
    expect(res.status).toBe(403);
  });

  it('200s a program-lead', async () => {
    const res = await request(buildApp({ role: 'program-lead' }))
      .put('/api/assessment/configuration')
      .send({ target_level: 4 });
    expect(res.status).toBe(200);
    expect(res.body.target_level).toBe(4);
  });
});

describe('agent commands + stop', () => {
  it('GET /agent/commands lists every launchable command with its allowlist', async () => {
    const res = await request(buildApp({ role: 'lead-assessor' })).get('/api/assessment/agent/commands');
    expect(res.status).toBe(200);
    const commands = res.body.commands as Array<{ name: string; allowed_tools: string[] }>;
    expect(commands.map((c) => c.name)).toHaveLength(9);
    expect(commands.map((c) => c.name)).toContain('score-dimensions');
    // Read-only tools are the floor for every command.
    for (const c of commands) expect(c.allowed_tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    // develop-jira-story drafts only — the push verb is deliberately withheld.
    const story = commands.find((c) => c.name === 'develop-jira-story')!;
    expect(story.allowed_tools.some((t) => t.includes('jira push-story'))).toBe(false);
  });

  it('POST /runs/:id/stop fails a running run and refuses a terminal one', async () => {
    const app = buildApp({ role: 'lead-assessor' });
    // Order-independent: the ledger is shared across this file and an earlier
    // test may have filled the concurrency cap, so stop whatever is running
    // rather than launching something new — which is the real scenario anyway.
    const running = await request(app).get('/api/assessment/runs?status=running');
    expect(running.status).toBe(200);
    const target = (running.body.runs as Array<{ id: string }>)[0];
    expect(target).toBeDefined();
    const stop = await request(app).post(`/api/assessment/runs/${target!.id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('failed');
    expect(stop.body.error).toBe('stopped by operator');
    expect(stop.body.finished_at).toEqual(expect.any(String));
    // The record is the truth of what happened: "stopped" never overwrites a terminal status.
    const again = await request(app).post(`/api/assessment/runs/${target!.id}/stop`);
    expect(again.status).toBe(409);
    const missing = await request(app).post('/api/assessment/runs/run-nope/stop');
    expect(missing.status).toBe(404);
  });
});

// ─── Realtime: assessment-broker wiring on knowledge mutations ─────────────

function collectOnce(): { events: AssessmentEvent[]; unsubscribe: () => void } {
  const events: AssessmentEvent[] = [];
  const unsubscribe = assessmentBroker.subscribe(({ event }) => events.push(event));
  return { events, unsubscribe };
}

describe('knowledge doc PUT/restore publish knowledge.doc.saved', () => {
  const DOC_ID = 'rule:na-exception-policy.md';

  it('PUT emits knowledge.doc.saved with the actor and a version stamp', async () => {
    const { events, unsubscribe } = collectOnce();
    try {
      const res = await request(buildApp({ role: 'lead-assessor', sub: 'u-lead' }))
        .put('/api/assessment/knowledge/doc')
        .send({ id: DOC_ID, markdown: '# updated\n', label: 'v2 — tightened wording' });
      expect(res.status).toBe(200);
      const saved = events.find((e) => e.type === 'knowledge.doc.saved') as Extract<AssessmentEvent, { type: 'knowledge.doc.saved' }>;
      expect(saved).toBeDefined();
      expect(saved.id).toBe(DOC_ID);
      expect(saved.by).toBe('u-lead');
      expect(saved.stamp).toEqual(expect.any(String));

      // The label now actually lands on the version it describes.
      const versions = await request(buildApp()).get(`/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(DOC_ID)}`);
      const labeled = versions.body.versions.find((v: { stamp: string; label: string | null }) => v.stamp === saved.stamp);
      expect(labeled?.label).toBe('v2 — tightened wording');
    } finally {
      unsubscribe();
    }
  });

  it('restore emits knowledge.doc.saved too', async () => {
    const versions = await request(buildApp()).get(`/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(DOC_ID)}`);
    const stamp = versions.body.versions[0]?.stamp;
    expect(stamp).toBeDefined();

    const { events, unsubscribe } = collectOnce();
    try {
      const res = await request(buildApp({ role: 'lead-assessor', sub: 'u-lead-2' }))
        .post('/api/assessment/knowledge/doc/restore')
        .send({ id: DOC_ID, stamp });
      expect(res.status).toBe(200);
      const saved = events.find((e) => e.type === 'knowledge.doc.saved') as Extract<AssessmentEvent, { type: 'knowledge.doc.saved' }>;
      expect(saved?.by).toBe('u-lead-2');
    } finally {
      unsubscribe();
    }
  });
});

describe('knowledge doc publish — pushes a local doc into the synced section', () => {
  const DOC_ID = 'ec:organization/raci.md';

  it('creates a page node under the synced section and emits knowledge.published; republishing bumps the version', async () => {
    const { events, unsubscribe } = collectOnce();
    try {
      const first = await request(buildApp({ role: 'lead-assessor' }))
        .post('/api/assessment/knowledge/doc/publish')
        .send({ id: DOC_ID });
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ ok: true, version: 1 });
      const pageId = first.body.page_id as string;

      const tree = await request(buildApp()).get('/api/assessment/knowledge/tree');
      const synced = tree.body.sections.find((s: { kind: string }) => s.kind === 'synced');
      expect(synced.nodes.some((n: { id: string }) => n.id === `page:${pageId}`)).toBe(true);

      const second = await request(buildApp({ role: 'lead-assessor' }))
        .post('/api/assessment/knowledge/doc/publish')
        .send({ id: DOC_ID });
      expect(second.body).toMatchObject({ ok: true, page_id: pageId, version: 2 });

      const published = events.filter((e) => e.type === 'knowledge.published');
      expect(published).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('404s an unknown doc id', async () => {
    const res = await request(buildApp({ role: 'lead-assessor' }))
      .post('/api/assessment/knowledge/doc/publish')
      .send({ id: 'ec:nope.md' });
    expect(res.status).toBe(404);
  });

  it('403s an assessor (ManageKnowledge is lead-assessor+)', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/knowledge/doc/publish')
      .send({ id: DOC_ID });
    expect(res.status).toBe(403);
  });
});

describe('knowledge pull — mock Confluence sync', () => {
  it('202s immediately, then emits knowledge.pulled for the section after the mock sync delay', async () => {
    const { events, unsubscribe } = collectOnce();
    try {
      const res = await request(buildApp({ role: 'lead-assessor' }))
        .post('/api/assessment/knowledge/pull')
        .send({ section: 'confluence-eng' });
      expect(res.status).toBe(202);
      expect(events.some((e) => e.type === 'knowledge.pulled')).toBe(false);

      // pullKnowledgeSection's mock delay is short but real (see
      // KNOWLEDGE_PULL_DELAY_MS in providers/assessment.ts) — wait it out
      // rather than faking timers, matching how the run-duration timers in
      // this same file are already left un-mocked.
      await new Promise((r) => setTimeout(r, 1800));
      const pulled = events.find((e) => e.type === 'knowledge.pulled') as Extract<AssessmentEvent, { type: 'knowledge.pulled' }>;
      expect(pulled).toBeDefined();
      expect(pulled.section).toBe('confluence-eng');
      expect(pulled.files_pulled).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  }, 10_000);

  it('404s an unknown section', async () => {
    const res = await request(buildApp({ role: 'lead-assessor' }))
      .post('/api/assessment/knowledge/pull')
      .send({ section: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('knowledge doc comment', () => {
  it('201s and emits knowledge.comment.created — any viewer, not just ManageKnowledge', async () => {
    const { events, unsubscribe } = collectOnce();
    try {
      const res = await request(buildApp({ role: 'assessor', sub: 'u-assessor' }))
        .post('/api/assessment/knowledge/doc/comment')
        .send({ id: 'rule:na-exception-policy.md', body: 'Looks right to me.' });
      expect(res.status).toBe(201);
      const created = events.find((e) => e.type === 'knowledge.comment.created') as Extract<AssessmentEvent, { type: 'knowledge.comment.created' }>;
      expect(created?.by).toBe('u-assessor');
      expect(created?.body).toBe('Looks right to me.');
    } finally {
      unsubscribe();
    }
  });

  it('404s an unknown doc id', async () => {
    const res = await request(buildApp({ role: 'assessor' }))
      .post('/api/assessment/knowledge/doc/comment')
      .send({ id: 'ec:nope.md', body: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('GET /events — SSE with Last-Event-ID catch-up', () => {
  // supertest buffers a full response before resolving, which never happens
  // for a long-lived SSE stream — this exercises the real handler over a
  // real socket instead, reading raw chunks and destroying the request once
  // it has what it needs (mirrors the client's own reconnect behavior:
  // EventSource sends back the last `id:` line as Last-Event-ID).
  // The socket is raw (supertest buffers), but it goes to the file's ONE
  // shared server rather than a listener of this describe block's own — see
  // src/test-support/http.ts. `attachToSharedServer` registers the app and
  // hands back the port plus the header that routes to it.
  function readChunks(app: express.Express, headers: Record<string, string>, onData: (chunk: string) => boolean): Promise<string> {
    const { port, headers: appHeaders } = attachToSharedServer(app);
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/assessment/events', headers: { ...appHeaders, ...headers } }, (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (onData(buf)) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on('error', () => resolve(buf));
      });
      req.on('error', (err) => {
        // destroy()ing the request above triggers an ECONNRESET here — expected.
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve('');
        else reject(err);
      });
    });
  }

  // DEFECTS #5 (assessor) / #8 (lead-assessor) / #7 (program-lead, admin):
  // a fresh tab (no Last-Event-ID at all) used to replay the whole ring
  // buffer, which is how a brand-new connection was told about a save from
  // 101 minutes ago. It now gets nothing but live events, each still
  // carrying an id: line.
  it('does NOT replay prior history on a fresh connection (no Last-Event-ID) — only live events arrive, each with an id: line', async () => {
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'stale-before-connect', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const gotLive = readChunks(buildApp({ role: 'assessor' }), {}, (buf) => buf.includes('"section":"live-after-connect"'));
    // Give the connection a beat to attach its subscriber before publishing.
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'live-after-connect', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const buf = await gotLive;
    expect(buf).not.toContain('"section":"stale-before-connect"');
    expect(/^id: [a-z0-9]+-\d+$/m.test(buf)).toBe(true);
    expect(buf).toContain('"type":"knowledge.pulled"');
  });

  it('Last-Event-ID limits replay to events published after that seq, then streams a live one', async () => {
    const before = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'before-connect', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const gotLive = readChunks(buildApp({ role: 'assessor' }), { 'Last-Event-ID': assessmentBroker.frameId(before.seq) }, (buf) => {
      return buf.includes('"section":"after-connect"');
    });
    // Give the connection a beat to attach its subscriber before publishing.
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'after-connect', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const finalBuf = await gotLive;
    // The pre-connect "before" section is <= Last-Event-ID and must not replay.
    expect(finalBuf).not.toContain('"section":"before-connect"');
    expect(finalBuf).toContain('"section":"after-connect"');
  });
});

describe('POST /reports/publish', () => {
  it('is a lead-assessor call, refused to an assessor', async () => {
    const asAssessor = await request(buildApp({ role: 'assessor' })).post('/api/assessment/reports/publish');
    expect(asAssessor.status).toBe(403);
    const asLead = await request(buildApp({ role: 'lead-assessor' })).post('/api/assessment/reports/publish');
    expect(asLead.status).toBe(201);
    expect(asLead.body).toMatchObject({ published_by: 'u-test', target_level: expect.any(Number), teams_total: expect.any(Number) });
  });
});

describe('GET /knowledge/doc — synced pages', () => {
  it('serves a synced page node as a read-only doc instead of 404ing', async () => {
    const res = await request(buildApp()).get('/api/assessment/knowledge/doc?id=page%3A100002');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'page:100002', title: 'Rubric Overview', editable: false, classification: 'synced' });
    expect(res.body.markdown).toContain('17 dimensions');
    // Read-only means read-only: a PUT to a synced page is refused.
    const put = await request(buildApp({ role: 'lead-assessor' })).put('/api/assessment/knowledge/doc').send({ id: 'page:100002', markdown: 'x' });
    expect([403, 404, 409]).toContain(put.status);
  });
});
