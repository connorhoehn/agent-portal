// Work-item criteria + comments routes (routes/work-items.ts).
//
// The provider is mocked here — providers/__tests__/work-item-criteria-comments.test.ts
// pins the renumbering logic against the real fixtures. This file pins the
// HTTP contract: status codes, request/response shapes, the writeGate on every
// mutation, the 404/400 ordering, and the session -> person resolution a
// comment POST goes through (never trusting an authorId in the body).

const manageAllow = { value: true };

// Stubbed so the real provider module can be loaded for its pure helper
// (decideStatusTransition, required actual below) without dragging in
// config.ts or an RDS client — same as routes/__tests__/work-items.test.ts.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  requireAction: (action: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (action === 'DispatchAgentRun' && !manageAllow.value) {
        res.status(403).json({ error: 'Forbidden', action });
        return;
      }
      next();
    },
}));

jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));

jest.mock('../../providers/activity.js', () => ({ getProjectActivitySeries: jest.fn() }));

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
  decideStatusTransition: jest.requireActual('../../providers/work-items.js').decideStatusTransition,
  listWorkItemCriteria: jest.fn(),
  createWorkItemCriterion: jest.fn(),
  updateWorkItemCriterion: jest.fn(),
  deleteWorkItemCriterion: jest.fn(),
  listWorkItemComments: jest.fn(),
  createWorkItemComment: jest.fn(),
  addWorkItemComment: jest.fn(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  getWorkItem,
  listWorkItemCriteria,
  createWorkItemCriterion,
  updateWorkItemCriterion,
  deleteWorkItemCriterion,
  listWorkItemComments,
  createWorkItemComment,
  type WorkItem,
  type WorkItemCriterion,
  type WorkItemCommentView,
} from '../../providers/work-items.js';
import { getUser } from '../../providers/identity.js';

const getWorkItemMock = getWorkItem as unknown as jest.Mock;
const listCriteriaMock = listWorkItemCriteria as unknown as jest.Mock;
const createCriterionMock = createWorkItemCriterion as unknown as jest.Mock;
const updateCriterionMock = updateWorkItemCriterion as unknown as jest.Mock;
const deleteCriterionMock = deleteWorkItemCriterion as unknown as jest.Mock;
const listCommentsMock = listWorkItemComments as unknown as jest.Mock;
const createCommentMock = createWorkItemComment as unknown as jest.Mock;
const getUserMock = getUser as unknown as jest.Mock;

const ITEM: WorkItem = {
  id: 'wi-obs-e1-s4', projectId: 'p-observability', projectName: 'Observability Platform',
  parentId: 'wi-obs-e1', type: 'story', title: 'Decommission the legacy StatsD bridge', description: null,
  status: 'open', priority: 'medium', assigneeId: 'p-008', assigneeName: 'Layla Hassan',
  assigneeDept: 'Platform Engineering', labels: ['decom'], storyPoints: 5,
  summary: 'Move remaining service metrics to OpenTelemetry.', blockedReason: null, nextStep: null, nextStepDetail: null,
  sprintId: 'spr-obs-s3', estimatedCostUsd: 5.77,
  estimatedBy: null, estimatedByName: null, estimatedAt: null,
  estimateModel: null, estimateForecast: null,
  estimateReviewedBy: null, estimateReviewedByName: null, estimateReviewedAt: null,
  prUrl: null, prStatus: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', completedAt: null,
  childCount: 0, childDoneCount: 0,
};

const CRITERION: WorkItemCriterion = {
  id: 'wicr-obs-e1-s4-1', workItemId: 'wi-obs-e1-s4', text: 'Route metrics through the collector',
  done: false, position: 0, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
};

const COMMENT: WorkItemCommentView = {
  id: 'wic-prog-9', workItemId: 'wi-obs-e1-s4', authorId: 'p-004', authorName: 'Nora DaSilva',
  authorTitle: 'Senior Engineer', body: 'Start with low-risk services after the collector rollout.',
  isSystem: false, createdAt: '2026-09-21T00:00:00Z',
};

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/graph', workItemsRouter);
  app.use(errorHandler);
  return app;
}

const sme = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const member = { sub: 'u-x', role: 'member', tenant: 'orgiq' };

beforeEach(() => {
  manageAllow.value = true;
  [getWorkItemMock, listCriteriaMock, createCriterionMock, updateCriterionMock, deleteCriterionMock,
    listCommentsMock, createCommentMock, getUserMock,
  ].forEach((m) => m.mockReset());
  getWorkItemMock.mockResolvedValue(ITEM);
  listCriteriaMock.mockResolvedValue([CRITERION]);
  createCriterionMock.mockResolvedValue(CRITERION);
  updateCriterionMock.mockResolvedValue({ ...CRITERION, done: true });
  deleteCriterionMock.mockResolvedValue(true);
  listCommentsMock.mockResolvedValue({ comments: [COMMENT], total: 1 });
  createCommentMock.mockResolvedValue(COMMENT);
  getUserMock.mockResolvedValue({ id: 'u-nora', displayName: 'Nora DaSilva', personId: 'p-004' });
});

// ── GET criteria ───────────────────────────────────────────────────────────────

describe('GET /api/graph/work-items/:id/criteria', () => {
  it('returns the checklist for a real work item', async () => {
    const res = await request(buildApp(null)).get('/api/graph/work-items/wi-obs-e1-s4/criteria');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ criteria: [CRITERION] });
    expect(listCriteriaMock).toHaveBeenCalledWith('wi-obs-e1-s4');
  });

  it('404s an unknown work item before ever asking the provider for criteria', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(null)).get('/api/graph/work-items/wi-nope/criteria');
    expect(res.status).toBe(404);
    expect(listCriteriaMock).not.toHaveBeenCalled();
  });

  it('needs no session — reads on this router are tenant-open', async () => {
    const res = await request(buildApp(null)).get('/api/graph/work-items/wi-obs-e1-s4/criteria');
    expect(res.status).toBe(200);
  });
});

// ── POST criteria ──────────────────────────────────────────────────────────────

describe('POST /api/graph/work-items/:id/criteria', () => {
  it('creates a criterion at the end of the list', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: 'Confirm no consumer still reads the old topic' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(CRITERION);
    expect(createCriterionMock).toHaveBeenCalledWith('wi-obs-e1-s4', 'Confirm no consumer still reads the old topic');
  });

  it('trims the text before handing it to the provider', async () => {
    await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: '  padded  ' });
    expect(createCriterionMock).toHaveBeenCalledWith('wi-obs-e1-s4', 'padded');
  });

  it('rejects an empty text', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(createCriterionMock).not.toHaveBeenCalled();
  });

  it('rejects text over 500 characters', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('rejects an unrecognised field by name', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: 'ok', done: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/done/);
    expect(createCriterionMock).not.toHaveBeenCalled();
  });

  it('404s an unknown work item', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-nope/criteria')
      .send({ text: 'ok' });
    expect(res.status).toBe(404);
    expect(createCriterionMock).not.toHaveBeenCalled();
  });

  it('refuses a member session — writeGate', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(member))
      .post('/api/graph/work-items/wi-obs-e1-s4/criteria')
      .send({ text: 'ok' });
    expect(res.status).toBe(403);
    expect(createCriterionMock).not.toHaveBeenCalled();
  });
});

// ── PATCH criteria ─────────────────────────────────────────────────────────────

describe('PATCH /api/graph/work-items/:id/criteria/:criterionId', () => {
  it('checks a criterion done', async () => {
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
    expect(updateCriterionMock).toHaveBeenCalledWith('wi-obs-e1-s4', 'wicr-obs-e1-s4-1', { done: true });
  });

  it('moves a criterion by position', async () => {
    await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ position: 2 });
    expect(updateCriterionMock).toHaveBeenCalledWith('wi-obs-e1-s4', 'wicr-obs-e1-s4-1', { position: 2 });
  });

  it('rejects an empty patch', async () => {
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({});
    expect(res.status).toBe(400);
    expect(updateCriterionMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean done', async () => {
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ done: 'yes' });
    expect(res.status).toBe(400);
  });

  it('rejects a negative position', async () => {
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ position: -1 });
    expect(res.status).toBe(400);
  });

  it('rejects an unrecognised field', async () => {
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ bogus: 1 });
    expect(res.status).toBe(400);
  });

  it('404s when the work item does not exist', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-nope/criteria/wicr-x')
      .send({ done: true });
    expect(res.status).toBe(404);
    expect(updateCriterionMock).not.toHaveBeenCalled();
  });

  it('404s when the criterion does not exist', async () => {
    updateCriterionMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-nope')
      .send({ done: true });
    expect(res.status).toBe(404);
  });

  it('refuses a member session — writeGate', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(member))
      .patch('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1')
      .send({ done: true });
    expect(res.status).toBe(403);
    expect(updateCriterionMock).not.toHaveBeenCalled();
  });
});

// ── DELETE criteria ────────────────────────────────────────────────────────────

describe('DELETE /api/graph/work-items/:id/criteria/:criterionId', () => {
  it('deletes and answers 204', async () => {
    const res = await request(buildApp(sme))
      .delete('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1');
    expect(res.status).toBe(204);
    expect(deleteCriterionMock).toHaveBeenCalledWith('wi-obs-e1-s4', 'wicr-obs-e1-s4-1');
  });

  it('404s an unknown criterion', async () => {
    deleteCriterionMock.mockResolvedValue(false);
    const res = await request(buildApp(sme))
      .delete('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-nope');
    expect(res.status).toBe(404);
  });

  it('404s an unknown work item before touching the provider', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .delete('/api/graph/work-items/wi-nope/criteria/wicr-x');
    expect(res.status).toBe(404);
    expect(deleteCriterionMock).not.toHaveBeenCalled();
  });

  it('refuses a member session — writeGate', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(member))
      .delete('/api/graph/work-items/wi-obs-e1-s4/criteria/wicr-obs-e1-s4-1');
    expect(res.status).toBe(403);
    expect(deleteCriterionMock).not.toHaveBeenCalled();
  });
});

// ── GET comments ───────────────────────────────────────────────────────────────

describe('GET /api/graph/work-items/:id/comments', () => {
  it('returns comments and the total', async () => {
    const res = await request(buildApp(null)).get('/api/graph/work-items/wi-obs-e1-s4/comments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ comments: [COMMENT], total: 1 });
  });

  it('404s an unknown work item', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(null)).get('/api/graph/work-items/wi-nope/comments');
    expect(res.status).toBe(404);
    expect(listCommentsMock).not.toHaveBeenCalled();
  });
});

// ── POST comments ──────────────────────────────────────────────────────────────

describe('POST /api/graph/work-items/:id/comments', () => {
  it('resolves the author from the session, not the body', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'Looks right to me.', authorId: 'p-999' });
    // authorId is not in the allowed key list, so this is a 400 naming it —
    // proof the route never reads an author off the wire.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/authorId/);
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it('creates a comment authored by the session\'s linked person', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'Looks right to me.' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(COMMENT);
    expect(getUserMock).toHaveBeenCalledWith('u-nora');
    expect(createCommentMock).toHaveBeenCalledWith('wi-obs-e1-s4', { userId: 'u-nora', displayName: 'Nora DaSilva', personId: 'p-004' }, 'Looks right to me.');
  });

  it('409s when the session has no linked person', async () => {
    getUserMock.mockResolvedValue({ id: 'u-operator', personId: null });
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'Looks right to me.' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Link your account/);
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it('409s when getUser resolves nothing at all', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'Looks right to me.' });
    expect(res.status).toBe(409);
  });

  it('rejects an empty body', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: '   ' });
    expect(res.status).toBe(400);
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it('rejects a body over 4000 characters', async () => {
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });

  it('404s an unknown work item before resolving the session person', async () => {
    getWorkItemMock.mockResolvedValue(null);
    const res = await request(buildApp(sme))
      .post('/api/graph/work-items/wi-nope/comments')
      .send({ body: 'ok' });
    expect(res.status).toBe(404);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it('refuses a member session — writeGate — before any person lookup', async () => {
    manageAllow.value = false;
    const res = await request(buildApp(member))
      .post('/api/graph/work-items/wi-obs-e1-s4/comments')
      .send({ body: 'ok' });
    expect(res.status).toBe(403);
    expect(createCommentMock).not.toHaveBeenCalled();
  });
});
