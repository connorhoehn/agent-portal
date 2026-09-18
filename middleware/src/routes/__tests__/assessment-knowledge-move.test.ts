// POST /knowledge/doc/move — the endpoint TreeView's drag-and-drop needs.
//
// The library's `TreeView` has shipped `onReorder` ("Enables HTML5
// drag-and-drop reorder/reparent when provided") and a `TreeNode.status` of
// 'pending' | 'moved' for the optimistic window the whole time. What did not
// exist was anywhere to put the result, so the portal passed no handler and
// the tree was inert. This pins the server half.
//
// The interesting half is what it REFUSES. Four moves are rejected because
// each would leave the tree asserting something untrue, and three of them are
// only reachable through drag-and-drop — nobody would type them:
//
//   * inside a SYNCED section — those nodes mirror Confluence, so a move here
//     lands nowhere real and the next pull silently reverts it;
//   * across sections — `publish` is the sanctioned way a doc leaves local,
//     and it mints a page rather than relocating a file;
//   * onto a leaf — only a directory can be a parent;
//   * into the node's own subtree — which detaches it from the root.
//
// The cycle case needs a tree two directories deep, which the seed is not, so
// the test builds one with a legal move first. That ordering matters: an
// earlier pass of this checked the cycle against a LEAF descendant and the
// "not a folder" rule answered first, so the cycle guard was never executed
// and would have passed while broken.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'Search',
    ] },
    { id: 'program-lead', tenant: 'assessment', label: 'Program Lead', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'Search', 'ManageKnowledge', 'PublishReport',
    ] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Session } from '../../lib/session.js';
import { knowledgeSectionsFixture } from '../../mock/assessment.js';

function buildApp(session: Partial<Session> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      sub: 'u-test', role: 'program-lead', tenant: 'assessment', grants: {}, iat: 0, ...session,
    } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

const move = (body: unknown, session?: Partial<Session>) =>
  request(buildApp(session)).post('/api/assessment/knowledge/doc/move').send(body as object);

const tree = async () => (await request(buildApp()).get('/api/assessment/knowledge/tree')).body;

/** Sibling order as the portal derives it: array order, filtered by parent. */
async function childrenOf(parentId: string | null): Promise<string[]> {
  const t = await tree();
  const sec = t.sections.find((s: { kind: string }) => s.kind === 'local');
  return sec.nodes
    .filter((n: { parent_id: string | null }) => n.parent_id === parentId)
    .map((n: { id: string }) => n.id);
}

// Every test mutates the registered fixture, which is exactly what the mock
// floor asks of a write — and why each one has to put it back.
afterEach(() => { knowledgeSectionsFixture.reset(); });

describe('POST /knowledge/doc/move', () => {
  it('reparents a doc and reports where it landed', async () => {
    const res = await move({ id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:process', position: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'ec:standards/ci-cd-standards.md', parent_id: 'ec:process', position: 0 });
    expect(await childrenOf('ec:process')).toContain('ec:standards/ci-cd-standards.md');
    expect(await childrenOf('ec:standards')).not.toContain('ec:standards/ci-cd-standards.md');
  });

  it('places the node at the requested index among its new siblings', async () => {
    const before = await childrenOf('ec:process');
    expect(before.length).toBeGreaterThan(0);
    await move({ id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:process', position: 0 });
    expect((await childrenOf('ec:process'))[0]).toBe('ec:standards/ci-cd-standards.md');

    knowledgeSectionsFixture.reset();
    await move({ id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:process', position: 99 });
    const after = await childrenOf('ec:process');
    // Past the end clamps to last rather than 404ing or leaving a hole.
    expect(after[after.length - 1]).toBe('ec:standards/ci-cd-standards.md');
  });

  it('moves a node to the section root with parentId null', async () => {
    const res = await move({ id: 'ec:standards/ci-cd-standards.md', parentId: null, position: 0 });
    expect(res.status).toBe(200);
    expect(res.body.parent_id).toBeNull();
    expect(await childrenOf(null)).toContain('ec:standards/ci-cd-standards.md');
  });

  it('carries the subtree: a moved directory keeps its children', async () => {
    const kids = await childrenOf('ec:process');
    const res = await move({ id: 'ec:process', parentId: 'ec:standards', position: 0 });
    expect(res.status).toBe(200);
    expect(await childrenOf('ec:process')).toEqual(kids);
  });

  it('refuses a move inside a synced section, naming the provider that owns it', async () => {
    const t = await tree();
    const synced = t.sections.find((s: { kind: string }) => s.kind !== 'local');
    const res = await move({ id: synced.nodes[0].id, parentId: null, position: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/mirrors/);
  });

  it('refuses a move across sections and points at publish instead', async () => {
    const t = await tree();
    const synced = t.sections.find((s: { kind: string }) => s.kind !== 'local');
    const res = await move({
      id: 'ec:standards/ci-cd-standards.md', parentId: synced.nodes[0].id, position: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/publish/);
  });

  it('refuses dropping onto a leaf', async () => {
    const res = await move({
      id: 'ec:process/intake-checklist.md', parentId: 'ec:standards/ci-cd-standards.md', position: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not a folder/);
  });

  it('refuses a node onto itself', async () => {
    const res = await move({ id: 'ec:standards', parentId: 'ec:standards', position: 0 });
    expect(res.status).toBe(409);
  });

  it('refuses a directory into its own DESCENDANT directory', async () => {
    // Nest first — the seed is only one directory deep, and against a leaf
    // descendant the "not a folder" rule answers before the cycle check ever
    // runs. This is the ordering that makes the assertion mean something.
    expect((await move({ id: 'ec:process', parentId: 'ec:standards', position: 0 })).status).toBe(200);
    const res = await move({ id: 'ec:standards', parentId: 'ec:process', position: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/inside itself/);
  });

  it('404s an unknown node and an unknown parent, distinguishably', async () => {
    expect((await move({ id: 'ec:nope.md', parentId: null, position: 0 })).body.error).toMatch(/node/);
    expect((await move({ id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:ghost', position: 0 })).body.error)
      .toMatch(/parent/);
  });

  it('400s a malformed body rather than guessing', async () => {
    expect((await move({ parentId: null, position: 0 })).status).toBe(400);
    expect((await move({ id: 'ec:standards/ci-cd-standards.md', position: 0 })).status).toBe(400);
    expect((await move({ id: 'ec:standards/ci-cd-standards.md', parentId: null })).status).toBe(400);
    expect((await move({ id: 'ec:standards/ci-cd-standards.md', parentId: null, position: -1 })).status).toBe(400);
    expect((await move({ id: 'ec:standards/ci-cd-standards.md', parentId: null, position: 1.5 })).status).toBe(400);
  });

  it('403s a role without ManageKnowledge', async () => {
    const res = await move(
      { id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:process', position: 0 },
      { role: 'assessor' },
    );
    expect(res.status).toBe(403);
  });

  it('leaves the tree untouched when it refuses', async () => {
    const before = await childrenOf('ec:standards');
    await move({ id: 'ec:standards/ci-cd-standards.md', parentId: 'ec:ghost', position: 0 });
    expect(await childrenOf('ec:standards')).toEqual(before);
  });
});
