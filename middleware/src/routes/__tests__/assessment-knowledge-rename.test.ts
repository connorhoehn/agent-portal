// POST /knowledge/doc/rename — the other half of "the tree has no renaming".
//
// Unlike the move, this one genuinely IS a library gap: `TreeViewProps` has
// `onReorder` but no `onRename`, so a row cannot become an input in place
// without reimplementing the row. The affordance is therefore the library's
// own `renderTrailing` slot holding an `IconButton` into a `Modal`. That is a
// portal concern; what this pins is the server contract underneath it.
//
// The load-bearing decision here is that a rename changes the TITLE and not
// the id. Ids in this tree look like paths — `ec:standards/ci-cd-standards.md`
// — and the doc fixture, the version list, the per-document comment channel
// and any URL a person has already shared all key off them. Deriving a new id
// from the new title would rename the document and break every one of those in
// the same motion, so the id is explicitly asserted to survive.
//
// A consequence worth stating: because ids do not move, two siblings sharing a
// title would not actually collide. It is still refused — a rail with two
// identically-named rows is unreadable even when it is unambiguous underneath.

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

const rename = (body: unknown, session?: Partial<Session>) =>
  request(buildApp(session)).post('/api/assessment/knowledge/doc/rename').send(body as object);

const nodeById = async (id: string) => {
  const res = await request(buildApp()).get('/api/assessment/knowledge/tree');
  return res.body.sections
    .flatMap((s: { nodes: unknown[] }) => s.nodes)
    .find((n: { id: string }) => n.id === id);
};

const TARGET = 'ec:standards/security-baseline.md';

afterEach(() => { knowledgeSectionsFixture.reset(); });

describe('POST /knowledge/doc/rename', () => {
  it('refuses to rename a prompt: they are read-only fleet instructions (2026-09-29 regression)', async () => {
    const res = await rename({ id: 'prompt:draw-diagram.md', title: 'Renamed prompt' });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/read-only/);
  });

  it('changes the title and leaves the id alone', async () => {
    const res = await rename({ id: TARGET, title: 'Security Baseline (2026)' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: TARGET, title: 'Security Baseline (2026)' });

    const node = await nodeById(TARGET);
    expect(node.title).toBe('Security Baseline (2026)');
    // The whole point: links, versions and the comment channel keep working.
    expect(node.id).toBe(TARGET);
  });

  it('trims surrounding whitespace rather than storing it', async () => {
    const res = await rename({ id: TARGET, title: '   Padded Name   ' });
    expect(res.status).toBe(200);
    expect((await nodeById(TARGET)).title).toBe('Padded Name');
  });

  it('accepts the current title as a no-op instead of a false clash', async () => {
    const before = (await nodeById(TARGET)).title;
    const res = await rename({ id: TARGET, title: before });
    // The sibling-clash check must not fire against the node's own name.
    expect(res.status).toBe(200);
    expect((await nodeById(TARGET)).title).toBe(before);
  });

  it('refuses a name a sibling already has, and says which', async () => {
    const sibling = (await nodeById('ec:standards/ci-cd-standards.md')).title;
    const res = await rename({ id: TARGET, title: sibling });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(sibling);
    expect((await nodeById(TARGET)).title).not.toBe(sibling);
  });

  it('allows a name that exists under a DIFFERENT parent', async () => {
    // Uniqueness is per-parent, like a filesystem — not per-section.
    const other = await nodeById('ec:process/intake-checklist.md');
    const res = await rename({ id: TARGET, title: other.title });
    expect(res.status).toBe(200);
  });

  it('refuses an empty or whitespace-only title', async () => {
    expect((await rename({ id: TARGET, title: '' })).status).toBe(400);
    expect((await rename({ id: TARGET, title: '   ' })).status).toBe(400);
  });

  it('refuses a multi-line title — the row it renders in is one line', async () => {
    expect((await rename({ id: TARGET, title: 'one\ntwo' })).status).toBe(400);
    expect((await rename({ id: TARGET, title: 'one\ttwo' })).status).toBe(400);
  });

  it('refuses an over-long title', async () => {
    expect((await rename({ id: TARGET, title: 'x'.repeat(121) })).status).toBe(400);
    expect((await rename({ id: TARGET, title: 'x'.repeat(120) })).status).toBe(200);
  });

  it('refuses a rename inside a synced section, naming the remote that owns it', async () => {
    const tree = (await request(buildApp()).get('/api/assessment/knowledge/tree')).body;
    const synced = tree.sections.find((s: { kind: string }) => s.kind !== 'local');
    const res = await rename({ id: synced.nodes[0].id, title: 'Renamed' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/mirrors/);
  });

  it('404s an unknown node', async () => {
    expect((await rename({ id: 'ec:nope.md', title: 'Whatever' })).status).toBe(404);
  });

  it('400s a body missing id or title', async () => {
    expect((await rename({ title: 'x' })).status).toBe(400);
    expect((await rename({ id: TARGET })).status).toBe(400);
  });

  it('403s a role without ManageKnowledge', async () => {
    expect((await rename({ id: TARGET, title: 'Nope' }, { role: 'assessor' })).status).toBe(403);
  });
});
