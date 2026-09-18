// GET /knowledge/doc/comments — the read that did not exist.
//
// `POST /knowledge/doc/comment` had an INSERT (Aurora) or a broker publish
// (mock) and NOTHING anywhere had a SELECT. A comment was write-only. The pane
// rebuilt its thread from this session's SSE echoes plus the realtime
// gateway's channel, so with the gateway offline — which is its state here,
// and the banner says so — a comment vanished on reload and the drawer then
// read "No comments on this document yet", about a comment the reader had just
// written. An empty state asserting something false, on the one surface whose
// job is to carry what people said to each other.
//
// Two properties are load-bearing beyond "it returns rows":
//
//   * a write mutates the REGISTERED fixture, so POST /api/__mock/reset undoes
//     it. That is the mock floor's contract for a write, and without it an
//     auditor's comments would accumulate into the seed forever.
//   * the stored row and its SSE echo share ONE id. The pane merges both
//     sources, and an id that differed between them would show every comment
//     twice for as long as the session lasted.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'Search',
    ] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Session } from '../../lib/session.js';
import { knowledgeCommentsFixture } from '../../mock/assessment.js';

function buildApp(session: Partial<Session> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      sub: 'u-test', role: 'assessor', tenant: 'assessment', grants: {}, iat: 0, ...session,
    } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

const DOC = 'prompt:classify-transcript.md';
const list = (id = DOC) =>
  request(buildApp()).get(`/api/assessment/knowledge/doc/comments?id=${encodeURIComponent(id)}`);
const post = (body: unknown) =>
  request(buildApp()).post('/api/assessment/knowledge/doc/comment').send(body as object);

afterEach(() => { knowledgeCommentsFixture.reset(); });

describe('GET /knowledge/doc/comments', () => {
  it('returns the seeded thread for a document', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.comments.length).toBeGreaterThanOrEqual(2);
    for (const c of res.body.comments) {
      expect(c.doc_id).toBe(DOC);
      expect(typeof c.id).toBe('string');
      expect(typeof c.body).toBe('string');
      expect(typeof c.author).toBe('string');
    }
  });

  it('is scoped to the document asked for', async () => {
    const other = await list('rule:what-counts-as-evidence.md');
    expect(other.status).toBe(200);
    expect(other.body.comments.length).toBeGreaterThan(0);
    expect(other.body.comments.every((c: { doc_id: string }) => c.doc_id === 'rule:what-counts-as-evidence.md'))
      .toBe(true);
  });

  it('reads oldest first, because a thread reads top-down', async () => {
    const stamps = (await list()).body.comments.map((c: { created_at: string }) => c.created_at);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('404s a document that does not exist, rather than an empty thread', async () => {
    // "No comments" and "no such document" are different answers and the pane
    // renders them differently.
    expect((await list('prompt:nope.md')).status).toBe(404);
  });

  it('400s without an id', async () => {
    expect((await request(buildApp()).get('/api/assessment/knowledge/doc/comments')).status).toBe(400);
  });

  it('a posted comment is readable back — the whole point', async () => {
    const before = (await list()).body.comments.length;
    expect((await post({ id: DOC, body: 'Read me back.' })).status).toBe(201);
    const after = (await list()).body.comments;
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].body).toBe('Read me back.');
    expect(after[after.length - 1].author).toBe('u-test');
  });

  it('reset undoes a posted comment, so an audit does not silt up the seed', async () => {
    const before = (await list()).body.comments.length;
    await post({ id: DOC, body: 'Temporary.' });
    expect((await list()).body.comments.length).toBe(before + 1);
    knowledgeCommentsFixture.reset();
    expect((await list()).body.comments.length).toBe(before);
  });

  it('404s a post to an unknown document', async () => {
    expect((await post({ id: 'prompt:nope.md', body: 'x' })).status).toBe(404);
  });

  it('400s a post with no body', async () => {
    expect((await post({ id: DOC })).status).toBe(400);
    expect((await post({ id: DOC, body: '' })).status).toBe(400);
  });
});
