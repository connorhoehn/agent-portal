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
import { requireAction } from '../lib/authz.js';
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

// Writes are gated per-route on DispatchAgentRun (the marketplace authority) —
// the mount's tenant guard alone let any orgiq member create or mutate board
// state. GETs stay tenant-open: the board is operational visibility.
const writeGate = requireAction('DispatchAgentRun');

const VALID_STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'in_review', 'done', 'cancelled'];
const VALID_PRIORITIES: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_PR_STATUSES: PrStatus[] = ['open', 'draft', 'merged', 'closed'];

/**
 * Constraint errors surfaced by the provider become 400s with the pg message
 * trimmed — a bad row is the caller's error, not a 500. FK violations get a
 * human answer instead of a constraint name.
 */
function toClientError(err: Error): { status: number; error: string } | null {
  const msg = err.message ?? '';
  if (/violates foreign key constraint/i.test(msg)) {
    if (/project/i.test(msg)) return { status: 400, error: 'no such project' };
    if (/parent/i.test(msg)) return { status: 400, error: 'no such parent work item' };
    if (/assignee|people/i.test(msg)) return { status: 400, error: 'no such assignee' };
    return { status: 400, error: 'a referenced record does not exist' };
  }
  if (/violates .* constraint|invalid input (?:value|syntax)/i.test(msg)) {
    // Trim the pg noise: first line, no 'ERROR:' prefix, no Detail tail.
    const trimmed = msg.replace(/^ERROR:\s*/i, '').split(/[;\n]/)[0]!.trim();
    return { status: 400, error: trimmed || 'the record violates a database constraint' };
  }
  return null;
}

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
  writeGate,
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
    const status = body['status'];
    if (status !== undefined && !VALID_STATUSES.includes(status as WorkItemStatus)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }
    const priority = body['priority'];
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority as WorkItemPriority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
      return;
    }
    const storyPoints = body['storyPoints'];
    if (storyPoints !== undefined && storyPoints !== null
      && (typeof storyPoints !== 'number' || !Number.isInteger(storyPoints) || storyPoints < 1 || storyPoints > 100)) {
      res.status(400).json({ error: 'storyPoints must be an integer between 1 and 100' });
      return;
    }

    try {
      const item = await createWorkItem({
        projectId,
        type,
        title: title.trim(),
        parentId:    (body['parentId']    as string | null | undefined) ?? null,
        description: (body['description'] as string | null | undefined) ?? null,
        status:      (status              as WorkItemStatus | undefined) ?? 'open',
        priority:    (priority            as WorkItemPriority | undefined) ?? 'medium',
        assigneeId:  (body['assigneeId']  as string | null | undefined) ?? null,
        labels:      Array.isArray(body['labels']) ? (body['labels'] as string[]) : [],
        storyPoints: typeof storyPoints === 'number' ? storyPoints : null,
      });
      res.status(201).json(item);
    } catch (err) {
      const mapped = toClientError(err as Error);
      if (!mapped) throw err;
      res.status(mapped.status).json({ error: mapped.error });
    }
  }),
);

// ── Update work item ──────────────────────────────────────────────────────────
// PATCH /api/graph/work-items/:id
workItemsRouter.patch(
  '/work-items/:id',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    const body = req.body as Record<string, unknown>;

    const status = body['status'];
    if (status !== undefined && !VALID_STATUSES.includes(status as WorkItemStatus)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }
    const priority = body['priority'];
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority as WorkItemPriority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
      return;
    }
    const prStatus = body['prStatus'];
    if (prStatus !== undefined && prStatus !== null && !VALID_PR_STATUSES.includes(prStatus as PrStatus)) {
      res.status(400).json({ error: `prStatus must be one of: ${VALID_PR_STATUSES.join(', ')}, or null` });
      return;
    }

    try {
      const updated = await updateWorkItem(id, {
        status:     (status             as WorkItemStatus  | undefined),
        priority:   (priority           as WorkItemPriority | undefined),
        assigneeId: (body['assigneeId'] as string | null | undefined),
        prUrl:      (body['prUrl']      as string | null | undefined),
        prStatus:   (prStatus           as PrStatus | null | undefined),
      });

      if (!updated) {
        res.status(404).json({ error: 'Work item not found' });
        return;
      }
      res.json(updated);
    } catch (err) {
      const mapped = toClientError(err as Error);
      if (!mapped) throw err;
      res.status(mapped.status).json({ error: mapped.error });
    }
  }),
);
