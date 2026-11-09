// GET /api/graph/decisions and /:id — the wire contract of the Decisions
// register (portal/src/pages/decisions/).
//
// `decisions` is one table with one concept (schema/orgiq_schema.sql), and an
// initiative's Decisions tab reads the same rows filtered by `project_id`. This
// list used to contain none of what that tab showed and vice versa, because
// each seed filled only the columns its own reader looked at.
//
// What is pinned here: the list is a bare array (not `{ decisions: [...] }`),
// the detail is a bare object, an unknown id is 404 with an `error` key, and
// `limit` is clamped rather than trusted. `status` and `projectId` let the page
// tell an open call from a settled one and file it under its initiative; the
// detail's `decidedBy`, `rationale` and `history` are what G54's decide writes
// (routes/__tests__/decisions-decide-route.test.ts), and `viewerMayDecide`
// says whether that write would let this viewer through.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { decisionsRouter } from '../decisions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/graph/decisions', decisionsRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  fixtureRegistry.resetAll('default');
  execMock.mockReset();
});

describe('GET /api/graph/decisions', () => {
  it('answers with a bare array of summaries, most recently active first', async () => {
    const res = await request(buildApp()).get('/api/graph/decisions');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // ORDER BY COALESCE(decided_at, created_at) DESC — an undecided call sorts
    // by when it was raised, which for a freshly seeded row is today. Ordering
    // on decidedAt alone would sort the open ones last, the opposite of what
    // the query does.
    const activity: string[] = res.body.map(
      (d: { decidedAt: string | null }) => d.decidedAt ?? '9999-12-31',
    );
    expect(activity).toEqual([...activity].sort().reverse());

    for (const d of res.body) {
      expect(Object.keys(d).sort()).toEqual(
        ['decidedAt', 'id', 'outcome', 'participantCount', 'projectId', 'status', 'summary', 'topic'],
      );
      expect(typeof d.participantCount).toBe('number');
      expect(['open', 'escalated', 'resolved', 'rejected']).toContain(d.status);
      // null is org-wide, not unknown: a decision no single initiative owns.
      expect(d.projectId === null || typeof d.projectId === 'string').toBe(true);
    }
  });

  it('carries both halves of the table — org-wide calls and an initiative\'s', async () => {
    // The bug this route was found with: the list served eight org-graph ADRs
    // and nothing an initiative had raised, while the initiative tab served the
    // four raised decisions and none of the ADRs. One table, two disjoint reads.
    const res = await request(buildApp()).get('/api/graph/decisions?limit=200');
    const ids: string[] = res.body.map((d: { id: string }) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['d-aurora', 'd-otel-vendor']));
    expect(res.body.some((d: { projectId: string | null }) => d.projectId === null)).toBe(true);
    expect(res.body.some((d: { projectId: string | null }) => d.projectId !== null)).toBe(true);
    expect(res.body.some((d: { status: string }) => d.status !== 'resolved')).toBe(true);
  });

  it('clamps `limit` to 1..200 instead of trusting it', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/graph/decisions?limit=2')).body).toHaveLength(2);
    // 0 and a non-number both fall back to a usable page rather than an empty
    // one — an unconsumed route is the one most likely to be called by hand.
    expect((await request(app).get('/api/graph/decisions?limit=0')).body.length).toBeGreaterThan(0);
    expect((await request(app).get('/api/graph/decisions?limit=banana')).body.length).toBeGreaterThan(0);
  });

  it('filters on `since`', async () => {
    const res = await request(buildApp()).get('/api/graph/decisions?since=2026-04-01');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    // `WHERE decided_at >= :since OR (decided_at IS NULL AND created_at >= :since)`
    // — an undecided call is filtered by when it was raised, so it survives a
    // `since` in the past rather than dropping out for having no date.
    for (const d of res.body) expect((d.decidedAt ?? '9999-12-31') >= '2026-04-01').toBe(true);
  });

  it('is an empty array, not a 404, when nothing is seeded', async () => {
    fixtureRegistry.resetAll('empty');
    const res = await request(buildApp()).get('/api/graph/decisions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/graph/decisions/:id', () => {
  it('hands back the decision and its participant thread', async () => {
    const list = await request(buildApp()).get('/api/graph/decisions');
    const first = list.body.find((d: { participantCount: number }) => d.participantCount > 0);
    expect(first).toBeDefined();

    const res = await request(buildApp()).get(`/api/graph/decisions/${first.id}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['decidedAt', 'decidedBy', 'history', 'id', 'options', 'outcome', 'participants', 'projectId', 'status', 'summary', 'topic', 'viewerMayDecide'],
    );
    expect(Array.isArray(res.body.history)).toBe(true);
    expect(typeof res.body.viewerMayDecide).toBe('boolean');
    expect(Array.isArray(res.body.options)).toBe(true);
    expect(res.body.participants).toHaveLength(first.participantCount);
    for (const p of res.body.participants) {
      expect(Object.keys(p).sort()).toEqual(['avatarUrl', 'name', 'personId', 'role', 'title', 'weight']);
      // The SQL JOINs `people`, so a participant always resolves to a name.
      expect(p.name).not.toBe('');
    }
  });

  it('a settled decision says what was decided and who decided it; a waiting one says neither (G54)', async () => {
    // The owner's second example: d-otel-vendor read as "nothing", a date and no outcome.
    const settled = await request(buildApp()).get('/api/graph/decisions/d-otel-vendor');
    expect(settled.body).toEqual(expect.objectContaining({
      status: 'resolved',
      outcome: 'Self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend.',
      decidedBy: { id: 'p-004', name: 'Nora DaSilva' },
      history: [],
    }));
    expect(settled.body.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Every settled row carries an outcome and its decider; no waiting row carries either.
    const list = await request(buildApp()).get('/api/graph/decisions?limit=200');
    for (const d of list.body as Array<{ id: string; status: string; outcome: string | null }>) {
      if (d.status === 'resolved' || d.status === 'rejected') expect(d.outcome).toEqual(expect.any(String));
      else expect(d.outcome).toBeNull();
    }
    const waiting = await request(buildApp()).get('/api/graph/decisions/d-eval-judge-model');
    expect(waiting.body).toEqual(expect.objectContaining({ status: 'open', outcome: null, decidedBy: null, decidedAt: null }));
  });

  it('404s an unknown id with an `error` key rather than null', async () => {
    const res = await request(buildApp()).get('/api/graph/decisions/d-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Decision not found' });
  });
});
