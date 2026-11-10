// Work-items route tests (routes/work-items.ts) with the provider and the
// Cedar gate mocked.
//
// Every case here is an input the API used to accept and then ignore: a `team`
// filter the Aurora path never applied, a `period` value outside the closed set
// that silently widened the search to all time, a `storyPoints` patch dropped
// behind a 200, a status move no matrix ever checked, and a typo'd parent id
// answered `200 []` instead of 404.

const mockGateActions: string[] = [];

// Stubbed so the real provider module can be loaded for its pure helpers
// without dragging in config.ts or an RDS client.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    mockGateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: jest.fn(),
}));

jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/sprints.js', () => ({
  getSprint: jest.fn(async (id: string) => (
    id === 'spr-obs-s2' || id === 'spr-obs-s3' ? { id, orgProjectId: 'p-observability' }
      : id === 'spr-auth-s2' ? { id, orgProjectId: 'p-auth-migration' } : null)),
}));
const scopeDeny = new Set<string>();
jest.mock('../../lib/initiative-scope.js', () => ({
  requireInitiativeScope: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, initiativeId: string | null) => {
    if (initiativeId && scopeDeny.has(initiativeId)) { res.status(403).json({ error: 'not your initiative' }); return false; }
    return true;
  }),
}));
jest.mock('../../lib/initiative-comments.js', () => ({ postInitiativeWorkComment: jest.fn() }));

jest.mock('../../providers/activity.js', () => ({
  getProjectActivitySeries: jest.fn(),
}));

jest.mock('../../providers/work-items.js', () => ({
  searchWorkItems: jest.fn(),
  getProjectWorkTree: jest.fn(),
  getProjectActivity: jest.fn(),
  getProjectDecisions: jest.fn(),
  getPersonWorkItems: jest.fn(),
  getWorkItem: jest.fn(),
  createWorkItem: jest.fn(),
  updateWorkItem: jest.fn(),
  countOpenChangeRequests: jest.fn(),
  wouldCreateParentCycle: jest.fn(),
  projectExists: jest.fn(),
  personExists: jest.fn(),
  // The transition matrix is a pure function; the route gets the real one so
  // these tests exercise the rules end to end rather than a stub of them.
  decideStatusTransition: jest.requireActual('../../providers/work-items.js').decideStatusTransition,
}));

import express from 'express';
import request from '../../test-support/http.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  searchWorkItems, getProjectWorkTree, getProjectActivity, getProjectDecisions,
  getPersonWorkItems, getWorkItem, createWorkItem, updateWorkItem,
  countOpenChangeRequests, wouldCreateParentCycle, projectExists, personExists,
  type WorkItem,
} from '../../providers/work-items.js';
import { getProjectActivitySeries } from '../../providers/activity.js';
import { resolveSession } from '../../lib/authz.js';
import { getUser } from '../../providers/identity.js';
import { postInitiativeWorkComment } from '../../lib/initiative-comments.js';

const resolveSessionMock = resolveSession as unknown as jest.Mock;
const getUserMock = getUser as unknown as jest.Mock;
const postCommentMock = postInitiativeWorkComment as unknown as jest.Mock;
const seriesMock = getProjectActivitySeries as unknown as jest.Mock;
const searchMock = searchWorkItems as unknown as jest.Mock;
const treeMock = getProjectWorkTree as unknown as jest.Mock;
const activityMock = getProjectActivity as unknown as jest.Mock;
const decisionsMock = getProjectDecisions as unknown as jest.Mock;
const personWorkMock = getPersonWorkItems as unknown as jest.Mock;
const getMock = getWorkItem as unknown as jest.Mock;
const createMock = createWorkItem as unknown as jest.Mock;
const updateMock = updateWorkItem as unknown as jest.Mock;
const openCrMock = countOpenChangeRequests as unknown as jest.Mock;
const cycleMock = wouldCreateParentCycle as unknown as jest.Mock;
const projectExistsMock = projectExists as unknown as jest.Mock;
const personExistsMock = personExists as unknown as jest.Mock;

const ITEM: WorkItem = {
  id: 'wi-obs-e1-s1', projectId: 'p-observability', projectName: 'Observability Platform',
  parentId: 'wi-obs-e1', type: 'story', title: 'Roll out collector fleet', description: null,
  status: 'in_progress', priority: 'high', assigneeId: 'p-008', assigneeName: 'Dana Okafor',
  assigneeDept: 'Platform Engineering', labels: ['otel'], storyPoints: 8,
  summary: null, blockedReason: null, nextStep: null, nextStepDetail: null, blockedByDecisionId: null,
  sprintId: 'spr-obs-s3', estimatedCostUsd: 10.47,
  // Estimated once, on Haiku, and not reviewed — the ordinary shape.
  estimatedBy: 'u-rachel', estimatedByName: 'Rachel Kowalski', estimatedAt: '2026-08-01T00:00:00Z',
  estimateModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  estimateForecast: { costUsdP25: 0.03, costUsdP75: 0.3, minutesP25: 1, minutesP75: 6 },
  estimateReviewedBy: null, estimateReviewedByName: null, estimateReviewedAt: null,
  prUrl: null, prStatus: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', completedAt: null,
  childCount: 0, childDoneCount: 0,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/graph', workItemsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  [searchMock, treeMock, activityMock, decisionsMock, personWorkMock, getMock,
    createMock, updateMock, openCrMock, cycleMock, projectExistsMock, personExistsMock, seriesMock,
    resolveSessionMock, getUserMock, postCommentMock,
  ].forEach((m) => m.mockReset());
  projectExistsMock.mockResolvedValue(true);
  personExistsMock.mockResolvedValue(true);
  openCrMock.mockResolvedValue(0);
  cycleMock.mockResolvedValue(false);
});

describe('gating', () => {
  it('puts board writes behind DispatchAgentRun and comments behind ViewWorkItems (§9 item 8d)', () => {
    expect(mockGateActions).toEqual(['DispatchAgentRun', 'ViewWorkItems']);
  });
});

// ── 1. The filter that was accepted and ignored ──────────────────────────────

describe('GET /api/graph/work', () => {
  beforeEach(() => searchMock.mockResolvedValue([ITEM]));

  it('forwards team to the provider instead of dropping it', async () => {
    const res = await request(buildApp()).get('/api/graph/work?team=Platform%20Engineering');
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ team: 'Platform Engineering' }));
  });

  it('forwards sprint, label and status too', async () => {
    await request(buildApp()).get('/api/graph/work?sprint=spr-obs-s3&label=otel&status=open');
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({
      sprintId: 'spr-obs-s3', label: 'otel', status: 'open',
    }));
  });

  it.each(['today', 'week'])('accepts period=%s', async (period) => {
    const res = await request(buildApp()).get(`/api/graph/work?period=${period}`);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ period }));
  });

  it('rejects an unknown period rather than quietly searching all time', async () => {
    const res = await request(buildApp()).get('/api/graph/work?period=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/period must be one of/);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('treats an omitted period as all time', async () => {
    const res = await request(buildApp()).get('/api/graph/work');
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ period: undefined }));
  });

  it('leaves an unknown status alone — it honestly matches nothing', async () => {
    searchMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/graph/work?status=bogus');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('clamps limit to the 1..200 window', async () => {
    await request(buildApp()).get('/api/graph/work?limit=9999');
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it('returns the sprint and the dollar estimate on every item', async () => {
    const res = await request(buildApp()).get('/api/graph/work');
    expect(res.body[0]).toMatchObject({ sprintId: 'spr-obs-s3', estimatedCostUsd: 10.47 });
  });
});

// ── 5. Not-found semantics on the collections ────────────────────────────────

describe('collection endpoints under a parent that does not exist', () => {
  it.each([
    ['/api/graph/projects/p-nope/work', () => treeMock],
    ['/api/graph/projects/p-nope/activity', () => activityMock],
    ['/api/graph/projects/p-nope/decisions', () => decisionsMock],
  ])('404s %s instead of answering 200 []', async (path, provider) => {
    projectExistsMock.mockResolvedValue(false);
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
    expect(provider()).not.toHaveBeenCalled();
  });

  it('404s a person work list for an unknown person', async () => {
    personExistsMock.mockResolvedValue(false);
    const res = await request(buildApp()).get('/api/graph/people/p-nope/work');
    expect(res.status).toBe(404);
    expect(personWorkMock).not.toHaveBeenCalled();
  });

  it('still answers 200 [] for a real project with no work yet', async () => {
    treeMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/graph/projects/p-observability/work');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('still answers 200 [] for a real person with nothing assigned', async () => {
    personWorkMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/graph/people/p-008/work');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // A scale audit flagged both of these as unbounded per-project reads (no
  // LIMIT at the SQL layer at all). `limit` is optional, clamped into
  // 1..500, and defaults to 500 so a normal project's tree/queue is
  // unaffected.
  it('threads a clamped `limit` through to getProjectWorkTree', async () => {
    treeMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/graph/projects/p-observability/work');
    await request(app).get('/api/graph/projects/p-observability/work?limit=10');
    await request(app).get('/api/graph/projects/p-observability/work?limit=999999');
    expect(treeMock.mock.calls.map((c) => c[1])).toEqual([500, 10, 500]);
  });

  it('threads a clamped `limit` through to getProjectDecisions', async () => {
    decisionsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/graph/projects/p-observability/decisions');
    await request(app).get('/api/graph/projects/p-observability/decisions?limit=10');
    await request(app).get('/api/graph/projects/p-observability/decisions?limit=999999');
    expect(decisionsMock.mock.calls.map((c) => c[1])).toEqual([500, 10, 500]);
  });
});

// ── Activity time series ──────────────────────────────────────────────────────

describe('GET /api/graph/projects/:id/activity/series', () => {
  const SERIES = {
    days: 30, from: '2026-08-03', to: '2026-09-01',
    series: { runs: new Array(30).fill(0), spendUsd: new Array(30).fill(0), completed: new Array(30).fill(0) },
    totals: { runs: 0, spendUsd: 0, completed: 0 },
  };

  it('404s an unknown initiative instead of a bare empty series', async () => {
    seriesMock.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/graph/projects/p-nope/activity/series');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it('defaults to 30 days', async () => {
    seriesMock.mockResolvedValue(SERIES);
    const res = await request(buildApp()).get('/api/graph/projects/p-observability/activity/series');
    expect(res.status).toBe(200);
    expect(seriesMock).toHaveBeenCalledWith('p-observability', 30);
    expect(res.body).toEqual(SERIES);
  });

  it('clamps an out-of-range days value to the 1..90 window', async () => {
    seriesMock.mockResolvedValue(SERIES);
    await request(buildApp()).get('/api/graph/projects/p-observability/activity/series?days=999');
    expect(seriesMock).toHaveBeenCalledWith('p-observability', 90);

    await request(buildApp()).get('/api/graph/projects/p-observability/activity/series?days=0');
    expect(seriesMock).toHaveBeenCalledWith('p-observability', 1);

    await request(buildApp()).get('/api/graph/projects/p-observability/activity/series?days=-5');
    expect(seriesMock).toHaveBeenCalledWith('p-observability', 1);

    await request(buildApp()).get('/api/graph/projects/p-observability/activity/series?days=not-a-number');
    expect(seriesMock).toHaveBeenCalledWith('p-observability', 30);
  });
});

// ── 2 + 3. Create: the columns that were not settable ────────────────────────

describe('POST /api/graph/work-items', () => {
  const BASE = { projectId: 'p-observability', type: 'story', title: 'New item' };

  it('forwards sprintId and estimatedCostUsd', async () => {
    createMock.mockResolvedValue(ITEM);
    const res = await request(buildApp())
      .post('/api/graph/work-items')
      .send({ ...BASE, sprintId: 'spr-obs-s3', estimatedCostUsd: 12.5 });
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      sprintId: 'spr-obs-s3', estimatedCostUsd: 12.5,
    }));
  });

  it('accepts an estimate of zero as a real value', async () => {
    createMock.mockResolvedValue(ITEM);
    await request(buildApp()).post('/api/graph/work-items').send({ ...BASE, estimatedCostUsd: 0 });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ estimatedCostUsd: 0 }));
  });

  it.each([
    ['negative', -1],
    // Infinity/NaN cannot survive JSON, so the wire-level bad values are
    // wrong-typed ones; Number.isFinite still guards the provider-side call.
    ['a coercible string', '12.5'],
    ['a boolean', true],
  ])('rejects %s estimatedCostUsd', async (_label, estimatedCostUsd) => {
    const res = await request(buildApp()).post('/api/graph/work-items').send({ ...BASE, estimatedCostUsd });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/estimatedCostUsd/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognised field by name', async () => {
    const res = await request(buildApp()).post('/api/graph/work-items').send({ ...BASE, estimatedHours: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/estimatedHours/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('maps a sprint foreign-key violation to a 400 naming the sprint', async () => {
    createMock.mockRejectedValue(new Error(
      'insert or update on table "work_items" violates foreign key constraint "work_items_sprint_id_fkey"'));
    const res = await request(buildApp()).post('/api/graph/work-items').send({ ...BASE, sprintId: 'spr-nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no such sprint');
  });
});

describe('sprint moves ask what the sprints route asks (DE-44 row 22)', () => {
  beforeEach(() => { scopeDeny.clear(); getMock.mockResolvedValue(ITEM); updateMock.mockResolvedValue(ITEM); createMock.mockResolvedValue(ITEM); });
  afterEach(() => { scopeDeny.clear(); });

  it('refuses a sprint on another initiative, on create and on patch', async () => {
    const created = await request(buildApp()).post('/api/graph/work-items')
      .send({ projectId: 'p-observability', type: 'story', title: 'x', sprintId: 'spr-auth-s2' });
    expect(created.status).toBe(400);
    const patched = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ sprintId: 'spr-auth-s2' });
    expect(patched.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a sprint move by someone who does not steward the initiative, and lets them clear nothing else', async () => {
    scopeDeny.add('p-observability');
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ sprintId: 'spr-obs-s2' });
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
    // Clearing the sprint, or leaving it as it is, asks nothing.
    expect((await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ sprintId: null })).status).toBe(200);
    expect((await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ sprintId: ITEM.sprintId, title: 'Retitled' })).status).toBe(200);
  });
});

// ── 3. Patch: the fields that were silently discarded ────────────────────────

describe('PATCH /api/graph/work-items/:id', () => {
  beforeEach(() => {
    getMock.mockResolvedValue(ITEM);
    updateMock.mockResolvedValue(ITEM);
  });

  it.each([
    ['storyPoints', { storyPoints: 13 }],
    ['title', { title: 'Retitled' }],
    ['description', { description: 'why this exists' }],
    ['labels', { labels: ['otel', 'infra'] }],
    ['parentId', { parentId: 'wi-obs-e2' }],
    ['sprintId', { sprintId: 'spr-obs-s2' }],
    ['estimatedCostUsd', { estimatedCostUsd: 4.25 }],
  ])('now writes %s instead of answering 200 with it discarded', async (_label, body) => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send(body);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('wi-obs-e1-s1', expect.objectContaining(body));
  });

  it('still writes the five fields it always forwarded', async () => {
    await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({
      status: 'in_review', priority: 'critical', assigneeId: 'p-004',
      prUrl: 'https://example.test/pr/1', prStatus: 'open',
    });
    expect(updateMock).toHaveBeenCalledWith('wi-obs-e1-s1', expect.objectContaining({
      status: 'in_review', priority: 'critical', assigneeId: 'p-004',
      prUrl: 'https://example.test/pr/1', prStatus: 'open',
    }));
  });

  it('clears a nullable field when sent null, rather than ignoring it', async () => {
    await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1')
      .send({ sprintId: null, estimatedCostUsd: null, storyPoints: null });
    expect(updateMock).toHaveBeenCalledWith('wi-obs-e1-s1',
      expect.objectContaining({ sprintId: null, estimatedCostUsd: null, storyPoints: null }));
  });

  it('sends only the keys the body carried', async () => {
    await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ storyPoints: 5 });
    expect(Object.keys(updateMock.mock.calls[0]![1])).toEqual(['storyPoints']);
  });

  it('rejects unrecognised fields by name', async () => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1')
      .send({ storyPoints: 5, estimatedHours: 3, owner: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/estimatedHours/);
    expect(res.body.error).toMatch(/owner/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects an empty patch instead of bumping updated_at for nothing', async () => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields to update/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['storyPoints', { storyPoints: 0 }, /storyPoints/],
    ['storyPoints', { storyPoints: 2.5 }, /storyPoints/],
    ['labels', { labels: 'otel' }, /labels/],
    ['labels', { labels: [1, 2] }, /labels/],
    ['title', { title: '   ' }, /title/],
    ['sprintId', { sprintId: 42 }, /sprintId/],
  ])('rejects a malformed %s', async (_label, body, pattern) => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(pattern);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('404s an unknown item before validating anything against it', async () => {
    getMock.mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-nope').send({ storyPoints: 5 });
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a reparent that would close a cycle', async () => {
    cycleMock.mockResolvedValue(true);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1')
      .send({ parentId: 'wi-child' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subtree/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses an item as its own parent', async () => {
    cycleMock.mockResolvedValue(true);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1')
      .send({ parentId: 'wi-obs-e1-s1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/its own parent/);
  });

  it('allows detaching to a root with parentId null without a cycle check', async () => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-obs-e1-s1').send({ parentId: null });
    expect(res.status).toBe(200);
    expect(cycleMock).not.toHaveBeenCalled();
  });
});

// ── 4. Status transitions ────────────────────────────────────────────────────

describe('PATCH status transitions', () => {
  beforeEach(() => updateMock.mockResolvedValue(ITEM));

  it('allows in_progress -> in_review', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_progress' });
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'in_review' });
    expect(res.status).toBe(200);
  });

  it('refuses done -> open with 400', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'done' });
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'open' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in_progress/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses open -> done with 400', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'open' });
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'done' });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses in_review -> done with 409 while a change request is open', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_review' });
    openCrMock.mockResolvedValue(1);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'done' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/change request/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows in_review -> done once no change request is open', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_review' });
    openCrMock.mockResolvedValue(0);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'done' });
    expect(res.status).toBe(200);
  });

  it('only pays for the change-request lookup when moving to done', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_progress' });
    await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'in_review' });
    expect(openCrMock).not.toHaveBeenCalled();
  });

  it('treats a status equal to the current one as a no-op, not a transition', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'done' });
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(openCrMock).not.toHaveBeenCalled();
    expect(updateMock.mock.calls[0]![1]).not.toHaveProperty('expectStatus');
  });

  it('compare-and-swaps on the status it decided against', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_progress' });
    await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'in_review' });
    expect(updateMock).toHaveBeenCalledWith('wi-1', expect.objectContaining({ expectStatus: 'in_progress' }));
  });

  it('does not compare-and-swap a patch that leaves the status alone', async () => {
    getMock.mockResolvedValue(ITEM);
    await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ title: 'Retitled' });
    expect(updateMock.mock.calls[0]![1]).not.toHaveProperty('expectStatus');
  });

  it('409s when the item moved between the read and the write', async () => {
    getMock.mockResolvedValue({ ...ITEM, status: 'in_progress' });
    updateMock.mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'in_review' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed while this update was in flight/);
  });

  it('still rejects a status outside the enum before reading the item', async () => {
    const res = await request(buildApp()).patch('/api/graph/work-items/wi-1').send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });
});

// ── Initiative discussion comments ───────────────────────────────────────────

describe('POST /api/graph/projects/:id/discussion/comments', () => {
  const URL = '/api/graph/projects/p-observability/discussion/comments';
  const GOOD = { body: '  Collector rollout looks good  ', workItemId: 'wi-obs-e1-s1', clientDeliveryId: 'del_1-a' };
  const USER = { id: 'u-rachel', displayName: 'Rachel Kowalski', personId: 'p-008' };

  beforeEach(() => {
    resolveSessionMock.mockReturnValue({ sub: 'u-rachel' });
    getUserMock.mockResolvedValue(USER);
  });

  it('400s unknown keys', async () => {
    const res = await request(buildApp()).post(URL).send({ ...GOOD, extra: 1 });
    expect(res.status).toBe(400);
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it('400s a bad clientDeliveryId', async () => {
    const res = await request(buildApp()).post(URL).send({ ...GOOD, clientDeliveryId: 'has spaces!' });
    expect(res.status).toBe(400);
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    resolveSessionMock.mockReturnValue(null);
    const res = await request(buildApp()).post(URL).send(GOOD);
    expect(res.status).toBe(401);
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it('401s when the session user no longer exists', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await request(buildApp()).post(URL).send(GOOD);
    expect(res.status).toBe(401);
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it('201s with the provider message and passes the signed-in identity', async () => {
    const message = { id: 'm-1', body: 'Collector rollout looks good' };
    postCommentMock.mockResolvedValue(message);
    const res = await request(buildApp()).post(URL).send(GOOD);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(message);
    expect(postCommentMock).toHaveBeenCalledWith({
      projectId: 'p-observability', workItemId: 'wi-obs-e1-s1',
      userId: 'u-rachel', displayName: 'Rachel Kowalski', personId: 'p-008',
      body: 'Collector rollout looks good', deliveryId: 'del_1-a',
    });
  });
});
