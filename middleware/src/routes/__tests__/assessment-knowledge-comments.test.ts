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
import { knowledgeCommentsFixture, knowledgeReactionsFixture } from '../../mock/assessment.js';

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

// ── Reactions ───────────────────────────────────────────────────────────────
//
// Reactions used to exist only over the realtime gateway: no endpoint, no
// broker event, no persistence. With the gateway down — this environment's
// state — the control could not reach anything, and even with it up a reaction
// did not survive a restart. These pin the durable replacement.
//
// The key IS the toggle: one row per (target, emoji, actor), so reacting twice
// is an add then a remove and never a count of two. That is what the `mine`
// flag on the summary depends on.
describe('reactions on a document and its comments', () => {
  const reactions = (id = DOC) =>
    request(buildApp()).get(`/api/assessment/knowledge/doc/reactions?id=${encodeURIComponent(id)}`);
  const toggle = (body: unknown, session?: Partial<Session>) =>
    request(buildApp(session)).post('/api/assessment/knowledge/doc/reaction').send(body as object);

  afterEach(() => { knowledgeReactionsFixture.reset(); });

  it('returns the reactions for the document AND its comments in one read', async () => {
    const res = await reactions();
    expect(res.status).toBe(200);
    const targets = new Set(res.body.reactions.map((r: { target_id: string }) => r.target_id));
    expect(targets.has(DOC)).toBe(true);
    // A comment on this document, not just the document itself.
    expect([...targets].some((t) => String(t).startsWith('kc-'))).toBe(true);
  });

  it('toggles on and back off rather than counting twice', async () => {
    const count = async () => (await reactions()).body.reactions
      .filter((r: { target_id: string; emoji: string }) => r.target_id === DOC && r.emoji === '🎯').length;
    const before = await count();
    expect((await toggle({ id: DOC, targetId: DOC, emoji: '🎯' })).body.reacted).toBe(true);
    expect(await count()).toBe(before + 1);
    expect((await toggle({ id: DOC, targetId: DOC, emoji: '🎯' })).body.reacted).toBe(false);
    expect(await count()).toBe(before);
  });

  it('two people reacting with the same emoji is a count of two', async () => {
    const mine = await toggle({ id: DOC, targetId: DOC, emoji: '🚀' }, { sub: 'u-one' });
    const theirs = await toggle({ id: DOC, targetId: DOC, emoji: '🚀' }, { sub: 'u-two' });
    expect(mine.body.reacted).toBe(true);
    expect(theirs.body.reacted).toBe(true);
    const rows = (await reactions()).body.reactions
      .filter((r: { emoji: string }) => r.emoji === '🚀');
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r: { actor: string }) => r.actor))).toEqual(new Set(['u-one', 'u-two']));
  });

  it('reacts on a comment of that document', async () => {
    const res = await toggle({ id: DOC, targetId: 'kc-classify-02', emoji: '👍' });
    expect(res.status).toBe(200);
    expect((await reactions()).body.reactions
      .some((r: { target_id: string }) => r.target_id === 'kc-classify-02')).toBe(true);
  });

  it('404s a target that is neither this document nor one of its comments', async () => {
    // kc-evidence-01 is a real comment — on a DIFFERENT document.
    const res = await toggle({ id: DOC, targetId: 'kc-evidence-01', emoji: '👍' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not this document/);
  });

  it('404s an unknown document and 400s a missing or empty emoji', async () => {
    expect((await toggle({ id: 'prompt:nope.md', targetId: 'prompt:nope.md', emoji: '👍' })).status).toBe(404);
    expect((await toggle({ id: DOC, targetId: DOC, emoji: '   ' })).status).toBe(400);
    expect((await toggle({ id: DOC, targetId: DOC })).status).toBe(400);
    expect((await toggle({ id: DOC, emoji: '👍' })).status).toBe(400);
  });

  it('reset undoes a reaction', async () => {
    const before = (await reactions()).body.reactions.length;
    await toggle({ id: DOC, targetId: DOC, emoji: '🎉' });
    expect((await reactions()).body.reactions.length).toBe(before + 1);
    knowledgeReactionsFixture.reset();
    expect((await reactions()).body.reactions.length).toBe(before);
  });
});

it('synced workspace pages accept durable comments and expose document/comment reactions', async () => {
  const doc = 'page:100002';
  expect((await list(doc)).status).toBe(200);
  expect((await post({ id: doc, body: 'Review this synced page' })).status).toBe(201);
  const thread = await list(doc);
  expect(thread.body.comments.some((c: { body: string }) => c.body === 'Review this synced page')).toBe(true);
  const reactions = await request(buildApp()).get(`/api/assessment/knowledge/doc/reactions?id=${encodeURIComponent(doc)}`);
  expect(reactions.status).toBe(200);
});
