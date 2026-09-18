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

// ── Edit and soft-delete ────────────────────────────────────────────────────
//
// `ChatPanel` renders the action bar, the inline editor, the "(edited)" marker
// and the tombstone itself — it needed somewhere to write to, which is what
// PATCH and DELETE are. Two decisions are pinned here:
//
//   * authorship is read from the SESSION, never the body, so naming someone
//     else does not let you rewrite their words;
//   * delete is SOFT. The row keeps its place and carries `deleted_at`,
//     because removing it outright leaves a hole in a thread other people are
//     part-way through reading, and the panel is built to render the stub.
describe('PATCH / DELETE /knowledge/doc/comment', () => {
  const patch = (body: unknown, session?: Partial<Session>) =>
    request(buildApp(session)).patch('/api/assessment/knowledge/doc/comment').send(body as object);
  const del = (body: unknown, session?: Partial<Session>) =>
    request(buildApp(session)).delete('/api/assessment/knowledge/doc/comment').send(body as object);

  const mine = async () => {
    await post({ id: DOC, body: 'Mine.' });
    const all = (await list()).body.comments;
    return all[all.length - 1] as { id: string; author: string };
  };

  it('the author can edit their own comment, and it is stamped', async () => {
    const c = await mine();
    const res = await patch({ commentId: c.id, body: 'Rewritten.' });
    expect(res.status).toBe(200);
    expect(res.body.edited_at).toEqual(expect.any(String));
    const after = (await list()).body.comments.find((x: { id: string }) => x.id === c.id);
    expect(after.body).toBe('Rewritten.');
    expect(after.edited_at).toEqual(expect.any(String));
  });

  it('403s an edit of someone else\'s comment', async () => {
    // kc-classify-01 is u-asha's; this session is u-test.
    const res = await patch({ commentId: 'kc-classify-01', body: 'hijack' });
    expect(res.status).toBe(403);
    const after = (await list()).body.comments.find((x: { id: string }) => x.id === 'kc-classify-01');
    expect(after.body).not.toBe('hijack');
  });

  it('a soft delete keeps the row and stamps it', async () => {
    const before = (await list()).body.comments.length;
    const c = await mine();
    const res = await del({ commentId: c.id });
    expect(res.status).toBe(200);
    const all = (await list()).body.comments;
    // The row is still there — that is the point of a soft delete.
    expect(all.length).toBe(before + 1);
    expect(all.find((x: { id: string }) => x.id === c.id).deleted_at).toEqual(expect.any(String));
  });

  it('deleting twice is idempotent rather than an error', async () => {
    const c = await mine();
    const first = await del({ commentId: c.id });
    const second = await del({ commentId: c.id });
    expect(second.status).toBe(200);
    expect(second.body.deleted_at).toBe(first.body.deleted_at);
  });

  it('refuses to edit a deleted comment', async () => {
    const c = await mine();
    await del({ commentId: c.id });
    expect((await patch({ commentId: c.id, body: 'zombie' })).status).toBe(400);
  });

  it('403s a delete of someone else\'s comment', async () => {
    expect((await del({ commentId: 'kc-classify-01' })).status).toBe(403);
  });

  it('404s an unknown comment, and 400s a malformed body', async () => {
    expect((await patch({ commentId: 'nope', body: 'x' })).status).toBe(404);
    expect((await del({ commentId: 'nope' })).status).toBe(404);
    expect((await patch({ body: 'x' })).status).toBe(400);
    expect((await del({})).status).toBe(400);
  });

  it('refuses an empty edit rather than blanking the comment', async () => {
    const c = await mine();
    expect((await patch({ commentId: c.id, body: '   ' })).status).toBe(400);
    const after = (await list()).body.comments.find((x: { id: string }) => x.id === c.id);
    expect(after.body).toBe('Mine.');
  });
});
