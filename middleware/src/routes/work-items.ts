// Work-items routes — Epic → Story | Bug hierarchy for the Projects surface.
//
// Mounted at /api/graph/projects (see index.ts) with specific sub-paths:
//   GET  /api/graph/work                   — cross-project search (label, team, status, period)
//   GET  /api/graph/projects/:id/work      — hierarchical work tree for one project
//   GET  /api/graph/projects/:id/decisions — decisions queue for one project
//   GET  /api/graph/people/:personId/work  — work assigned to a person
//   POST /api/graph/work-items             — create a new work item
//   PATCH /api/graph/work-items/:id        — update status / priority / assignee

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import {
  searchWorkItems,
  getProjectWorkTree,
  getProjectActivity,
  getProjectDecisions,
  getPersonWorkItems,
  createWorkItem,
  updateWorkItem,
  type WorkItemType,
  type WorkItemStatus,
  type WorkItemPriority,
  type PrStatus,
} from '../providers/work-items.js';

export const workItemsRouter = Router();

// ── Cross-project work search ─────────────────────────────────────────────────
// GET /api/graph/work?label=kubernetes&team=Platform+Engineering&status=in_progress&period=today&limit=50
workItemsRouter.get(
  '/work',
  asyncHandler(async (req, res) => {
    const label    = (req.query['label']   as string | undefined) || undefined;
    const team     = (req.query['team']    as string | undefined) || undefined;
    const status   = (req.query['status']  as string | undefined) || undefined;
    const period   = (req.query['period']  as string | undefined) || undefined;
    const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit    = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

    const items = await searchWorkItems({ label, team, status, period, limit });
    res.json(items);
  }),
);

// ── Project work tree ─────────────────────────────────────────────────────────
// GET /api/graph/projects/:id/work
workItemsRouter.get(
  '/projects/:id/work',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    const tree = await getProjectWorkTree(id);
    res.json(tree);
  }),
);

// ── Project activity feed ─────────────────────────────────────────────────────
// GET /api/graph/projects/:id/activity?limit=25
workItemsRouter.get(
  '/projects/:id/activity',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    const rawLimit = parseInt(req.query['limit'] as string ?? '25', 10);
    const limit = Number.isNaN(rawLimit) ? 25 : Math.min(Math.max(rawLimit, 1), 100);
    const activity = await getProjectActivity(id, { limit });
    res.json(activity);
  }),
);

// ── Project decision queue ────────────────────────────────────────────────────
// GET /api/graph/projects/:id/decisions
workItemsRouter.get(
  '/projects/:id/decisions',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    const decisions = await getProjectDecisions(id);
    res.json(decisions);
  }),
);

// ── Person work items ─────────────────────────────────────────────────────────
// GET /api/graph/people/:personId/work?status=in_progress&limit=20
workItemsRouter.get(
  '/people/:personId/work',
  asyncHandler(async (req, res) => {
    const personId = req.params['personId'] as string;
    if (!personId) { res.status(400).json({ error: 'Missing person id' }); return; }
    const status   = (req.query['status'] as string | undefined) || undefined;
    const rawLimit = parseInt(req.query['limit'] as string ?? '30', 10);
    const limit    = Number.isNaN(rawLimit) ? 30 : Math.min(Math.max(rawLimit, 1), 100);
    const items    = await getPersonWorkItems(personId, { status, limit });
    res.json(items);
  }),
);

// ── Create work item ──────────────────────────────────────────────────────────
// POST /api/graph/work-items
workItemsRouter.post(
  '/work-items',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const projectId = body['projectId'] as string | undefined;
    const type      = body['type']      as WorkItemType | undefined;
    const title     = body['title']     as string | undefined;

    if (!projectId || !type || !title?.trim()) {
      res.status(400).json({ error: 'projectId, type, and title are required' });
      return;
    }
    const VALID_TYPES: WorkItemType[] = ['epic', 'story', 'bug'];
    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    const item = await createWorkItem({
      projectId,
      type,
      title: title.trim(),
      parentId:    (body['parentId']    as string | null | undefined) ?? null,
      description: (body['description'] as string | null | undefined) ?? null,
      status:      (body['status']      as WorkItemStatus | undefined) ?? 'open',
      priority:    (body['priority']    as WorkItemPriority | undefined) ?? 'medium',
      assigneeId:  (body['assigneeId']  as string | null | undefined) ?? null,
      labels:      Array.isArray(body['labels']) ? (body['labels'] as string[]) : [],
      storyPoints: typeof body['storyPoints'] === 'number' ? body['storyPoints'] : null,
    });
    res.status(201).json(item);
  }),
);

// ── Update work item ──────────────────────────────────────────────────────────
// PATCH /api/graph/work-items/:id
workItemsRouter.patch(
  '/work-items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    const body = req.body as Record<string, unknown>;

    const updated = await updateWorkItem(id, {
      status:     (body['status']     as WorkItemStatus  | undefined),
      priority:   (body['priority']   as WorkItemPriority | undefined),
      assigneeId: (body['assigneeId'] as string | null | undefined),
      prUrl:      (body['prUrl']      as string | null | undefined),
      prStatus:   (body['prStatus']   as PrStatus | null | undefined),
    });

    if (!updated) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.json(updated);
  }),
);
