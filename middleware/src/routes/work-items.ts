// Work-items routes — Epic → Story | Bug hierarchy for the Projects surface.
//
// Mounted at /api/graph/projects (see index.ts) with specific sub-paths:
//   GET  /api/graph/work                   — cross-project search (label, team, sprint, status, period)
//   GET  /api/graph/projects/:id/work      — hierarchical work tree for one project
//   GET  /api/graph/projects/:id/decisions — decisions queue for one project
//   GET  /api/graph/people/:personId/work  — work assigned to a person
//   POST /api/graph/work-items             — create a new work item
//   PATCH /api/graph/work-items/:id        — update an existing work item
//   GET   /api/graph/work-items/:id/criteria         — acceptance-criteria checklist
//   POST  /api/graph/work-items/:id/criteria         — append a criterion
//   PATCH /api/graph/work-items/:id/criteria/:cid    — edit/check/move a criterion
//   DELETE /api/graph/work-items/:id/criteria/:cid   — remove a criterion
//   GET   /api/graph/work-items/:id/comments         — planning notes + status audit
//   POST  /api/graph/work-items/:id/comments         — add a planning note
//
// House rule for this surface: an input this API accepts is an input it acts
// on. A parameter it cannot honour is a 400, never a silent no-op — the old
// behaviour (a `team=` filter the Aurora path ignored, a `storyPoints` patch
// dropped on the floor behind a 200) is indistinguishable from a working call
// that found nothing.

import { Router, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { getUser } from '../providers/identity.js';
import {
  searchWorkItems,
  getProjectWorkTree,
  getProjectActivity,
  getProjectDecisions,
  getPersonWorkItems,
  getWorkItem,
  createWorkItem,
  updateWorkItem,
  decideStatusTransition,
  countOpenChangeRequests,
  wouldCreateParentCycle,
  projectExists,
  personExists,
  listWorkItemCriteria,
  createWorkItemCriterion,
  updateWorkItemCriterion,
  deleteWorkItemCriterion,
  listWorkItemComments,
  createWorkItemComment,
  addWorkItemComment,
  type CreateWorkItemInput,
  type UpdateWorkItemPatch,
  type WorkItemType,
  type WorkItemStatus,
  type WorkItemPriority,
  type PrStatus,
} from '../providers/work-items.js';
import { getProjectActivitySeries } from '../providers/activity.js';

export const workItemsRouter = Router();

// Writes are gated per-route on DispatchAgentRun (the marketplace authority) —
// the mount's tenant guard alone let any orgiq member create or mutate board
// state. GETs stay tenant-open: the board is operational visibility.
const writeGate = requireAction('DispatchAgentRun');

const VALID_STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'in_review', 'done', 'cancelled'];
const VALID_PRIORITIES: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_PR_STATUSES: PrStatus[] = ['open', 'draft', 'merged', 'closed'];
const VALID_PERIODS = ['today', 'week'];

// Every key each write accepts. Anything outside the list is a 400, because the
// alternative — accepting it and writing nothing — reads to the client exactly
// like success.
const CREATE_KEYS = [
  'projectId', 'type', 'title', 'parentId', 'description', 'status', 'priority',
  'assigneeId', 'labels', 'storyPoints', 'sprintId', 'estimatedCostUsd',
] as const;
const PATCH_KEYS = [
  'status', 'priority', 'title', 'description', 'labels', 'parentId',
  'storyPoints', 'sprintId', 'estimatedCostUsd', 'assigneeId', 'prUrl', 'prStatus',
] as const;

/** Names every key the body carries that this route cannot act on. */
function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}

/** `in_progress` -> `in progress`, for the status-change audit comment's prose. */
function statusLabel(status: WorkItemStatus): string {
  return status.replace(/_/g, ' ');
}

/** Field validators — each returns an error string, or null when acceptable. */
function checkStoryPoints(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
    return 'storyPoints must be an integer between 1 and 100, or null';
  }
  return null;
}

function checkEstimatedCost(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return 'estimatedCostUsd must be a non-negative number of dollars, or null';
  }
  return null;
}

function checkLabels(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.some((l) => typeof l !== 'string')) {
    return 'labels must be an array of strings';
  }
  return null;
}

function checkNullableId(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim()) return `${field} must be a non-empty string, or null`;
  return null;
}

function checkCriterionText(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'text is required and must be a non-empty string';
  if (v.trim().length > 500) return 'text must be 500 characters or fewer';
  return null;
}
function checkCriterionDone(v: unknown): string | null {
  if (typeof v !== 'boolean') return 'done must be a boolean';
  return null;
}
function checkCriterionPosition(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'position must be a non-negative integer';
  return null;
}
function checkCommentBody(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return 'body is required and must be a non-empty string';
  if (v.trim().length > 4000) return 'body must be 4000 characters or fewer';
  return null;
}

/**
 * Constraint errors surfaced by the provider become 400s with the pg message
 * trimmed — a bad row is the caller's error, not a 500. FK violations get a
 * human answer instead of a constraint name.
 */
function toClientError(err: Error): { status: number; error: string } | null {
  const msg = err.message ?? '';
  if (/violates foreign key constraint/i.test(msg)) {
    if (/sprint/i.test(msg)) return { status: 400, error: 'no such sprint' };
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
// GET /api/graph/work?label=kubernetes&team=Platform+Engineering&sprint=spr-obs-s3&status=in_progress&period=today&limit=50
//
// `team` is a real filter on both paths now. It was documented here, honoured
// by the mock path and ignored by Aurora, so `?team=NoSuchTeam` returned the
// whole board — a filter that silently does nothing is worse than no filter,
// because the caller believes the answer.
//
// `period` is a closed set, so an unrecognised value is refused rather than
// dropped: `?period=bogus` used to return every item as if the window had been
// applied. `status` is left alone — an unknown status honestly matches nothing.
workItemsRouter.get(
  '/work',
  asyncHandler(async (req, res) => {
    const label    = (req.query['label']   as string | undefined) || undefined;
    const team     = (req.query['team']    as string | undefined) || undefined;
    const sprintId = (req.query['sprint']  as string | undefined) || undefined;
    const status   = (req.query['status']  as string | undefined) || undefined;
    const period   = (req.query['period']  as string | undefined) || undefined;
    const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit    = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

    if (period !== undefined && !VALID_PERIODS.includes(period)) {
      res.status(400).json({ error: `period must be one of: ${VALID_PERIODS.join(', ')} (omit it for all time)` });
      return;
    }

    const items = await searchWorkItems({ label, team, sprintId, status, period, limit });
    res.json(items);
  }),
);

/**
 * 404 for a parent that does not exist.
 *
 * These collections used to answer `200 []` for any id, so `p-nope` and a real
 * initiative with no work yet were the same response — a typo read as "empty"
 * instead of "wrong". `GET /api/graph/projects/p-nope` already 404s; the
 * sub-collections now agree with it.
 */
async function parentMissing(res: Response, kind: 'project' | 'person', id: string): Promise<boolean> {
  const exists = kind === 'project' ? await projectExists(id) : await personExists(id);
  if (exists) return false;
  res.status(404).json({ error: kind === 'project' ? 'Project not found' : 'Person not found' });
  return true;
}

// ── Project work tree ─────────────────────────────────────────────────────────
// GET /api/graph/projects/:id/work?limit=
workItemsRouter.get(
  '/projects/:id/work',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    if (await parentMissing(res, 'project', id)) return;
    const rawLimit = parseInt(req.query['limit'] as string ?? '500', 10);
    const limit = Number.isNaN(rawLimit) ? 500 : Math.min(Math.max(rawLimit, 1), 500);
    const tree = await getProjectWorkTree(id, limit);
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
    if (await parentMissing(res, 'project', id)) return;
    const rawLimit = parseInt(req.query['limit'] as string ?? '25', 10);
    const limit = Number.isNaN(rawLimit) ? 25 : Math.min(Math.max(rawLimit, 1), 100);
    const activity = await getProjectActivity(id, { limit });
    res.json(activity);
  }),
);

// ── Project activity time series ──────────────────────────────────────────────
// GET /api/graph/projects/:id/activity/series?days=30
//
// Daily buckets (runs, spendUsd, completed) for the initiative detail page's
// activity graph — distinct from the /activity feed above, which is a list of
// recent events, not a time series. Kept at its own sub-path rather than
// overloaded onto `/activity` itself: Express only ever dispatches the first
// route registered for a given method+path, so reusing it would silently
// shadow one of the two response shapes. Same tenant-open, 404-on-unknown-id
// posture as /work and /decisions — no extra gate.
workItemsRouter.get(
  '/projects/:id/activity/series',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    const rawDays = parseInt(req.query['days'] as string ?? '30', 10);
    const days = Number.isNaN(rawDays) ? 30 : Math.min(Math.max(rawDays, 1), 90);
    const result = await getProjectActivitySeries(id, days);
    if (!result) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(result);
  }),
);

// ── Project decision queue ────────────────────────────────────────────────────
// GET /api/graph/projects/:id/decisions?limit=
workItemsRouter.get(
  '/projects/:id/decisions',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing project id' }); return; }
    if (await parentMissing(res, 'project', id)) return;
    const rawLimit = parseInt(req.query['limit'] as string ?? '500', 10);
    const limit = Number.isNaN(rawLimit) ? 500 : Math.min(Math.max(rawLimit, 1), 500);
    const decisions = await getProjectDecisions(id, limit);
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
    if (await parentMissing(res, 'person', personId)) return;
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
    const body = (req.body ?? {}) as Record<string, unknown>;

    const stray = unknownKeys(body, CREATE_KEYS);
    if (stray.length > 0) {
      res.status(400).json({ error: `unrecognised field${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}` });
      return;
    }

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
    const fieldError = checkStoryPoints(storyPoints)
      ?? checkEstimatedCost(body['estimatedCostUsd'])
      ?? checkLabels(body['labels'])
      ?? checkNullableId(body['sprintId'], 'sprintId');
    if (fieldError) {
      res.status(400).json({ error: fieldError });
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
        // Both columns have existed in program_schema.sql since the program
        // model landed and neither was settable, so nothing created through
        // this API could ever be put in a sprint or carry a dollar estimate.
        sprintId:         (body['sprintId'] as string | null | undefined) ?? null,
        estimatedCostUsd: typeof body['estimatedCostUsd'] === 'number' ? body['estimatedCostUsd'] : null,
      } satisfies CreateWorkItemInput);
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
//
// This route used to forward exactly five fields — status, priority,
// assigneeId, prUrl, prStatus — and answer 200 to everything else with the
// field discarded. `storyPoints` in particular drives the marketplace estimate
// and the allocation brake, so a mis-sized item could not be corrected at all
// and there is no DELETE to recreate it with.
workItemsRouter.patch(
  '/work-items/:id',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const stray = unknownKeys(body, PATCH_KEYS);
    if (stray.length > 0) {
      res.status(400).json({ error: `unrecognised field${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}` });
      return;
    }
    // An empty patch was a 200 that bumped updated_at and changed nothing —
    // the same answer a real edit gets.
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: `no fields to update — send one of: ${PATCH_KEYS.join(', ')}` });
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
    const prStatus = body['prStatus'];
    if (prStatus !== undefined && prStatus !== null && !VALID_PR_STATUSES.includes(prStatus as PrStatus)) {
      res.status(400).json({ error: `prStatus must be one of: ${VALID_PR_STATUSES.join(', ')}, or null` });
      return;
    }
    if (body['title'] !== undefined && (typeof body['title'] !== 'string' || !body['title'].trim())) {
      res.status(400).json({ error: 'title must be a non-empty string' });
      return;
    }
    const fieldError = checkStoryPoints(body['storyPoints'])
      ?? checkEstimatedCost(body['estimatedCostUsd'])
      ?? checkLabels(body['labels'])
      ?? checkNullableId(body['sprintId'], 'sprintId')
      ?? checkNullableId(body['parentId'], 'parentId')
      ?? checkNullableId(body['assigneeId'], 'assigneeId');
    if (fieldError) {
      res.status(400).json({ error: fieldError });
      return;
    }

    const current = await getWorkItem(id);
    if (!current) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }

    // Status moves go through the board's transition matrix — the counterpart
    // to the dispatch path's refusal matrix, which the board never had.
    const nextStatus = status as WorkItemStatus | undefined;
    const movingStatus = nextStatus !== undefined && nextStatus !== current.status;
    if (movingStatus) {
      const openChangeRequests = nextStatus === 'done' ? await countOpenChangeRequests(id) : 0;
      const decision = decideStatusTransition(current, nextStatus, { openChangeRequests });
      if (decision.kind === 'refuse') {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
    }

    // Reparenting into your own subtree loses the subtree: buildWorkItemTree
    // only roots parentless nodes, so a cycle disappears from the project tree.
    const parentId = body['parentId'] as string | null | undefined;
    if (parentId != null && await wouldCreateParentCycle(id, parentId)) {
      res.status(400).json({
        error: parentId === id
          ? 'a work item cannot be its own parent'
          : 'that parent is inside this item\'s own subtree — reparenting there would orphan the branch',
      });
      return;
    }

    try {
      const patch: UpdateWorkItemPatch = {
        ...(status           !== undefined ? { status: status as WorkItemStatus } : {}),
        ...(priority         !== undefined ? { priority: priority as WorkItemPriority } : {}),
        ...(prStatus         !== undefined ? { prStatus: prStatus as PrStatus | null } : {}),
        ...('title'            in body ? { title: (body['title'] as string).trim() } : {}),
        ...('description'      in body ? { description: (body['description'] as string | null) ?? null } : {}),
        ...('labels'           in body ? { labels: body['labels'] as string[] } : {}),
        ...('parentId'         in body ? { parentId: parentId ?? null } : {}),
        ...('storyPoints'      in body ? { storyPoints: (body['storyPoints'] as number | null) ?? null } : {}),
        ...('sprintId'         in body ? { sprintId: (body['sprintId'] as string | null) ?? null } : {}),
        ...('estimatedCostUsd' in body ? { estimatedCostUsd: (body['estimatedCostUsd'] as number | null) ?? null } : {}),
        ...('assigneeId'       in body ? { assigneeId: (body['assigneeId'] as string | null) ?? null } : {}),
        ...('prUrl'            in body ? { prUrl: (body['prUrl'] as string | null) ?? null } : {}),
        // Compare-and-swap only when the status is moving: a title edit must
        // not fail because a dispatch claimed the item in the meantime.
        ...(movingStatus ? { expectStatus: current.status } : {}),
      };
      const updated = await updateWorkItem(id, patch);

      if (!updated) {
        // The item existed a moment ago, so a missing row here means the CAS
        // lost: something moved the status under this decision.
        res.status(409).json({ error: 'the work item changed while this update was in flight — re-read it and retry' });
        return;
      }

      // A status move gets an is_system audit comment so the Activity tab has
      // real history to show, not just the board's own before/after. Best
      // effort deliberately: the PATCH already landed, and a session/identity
      // hiccup writing the audit trail must never turn a successful update
      // into a failed response.
      if (movingStatus) {
        try {
          const session = resolveSession(req);
          const actorPersonId = session ? (await getUser(session.sub))?.personId ?? null : null;
          await addWorkItemComment(
            id,
            `Status changed from ${statusLabel(current.status)} to ${statusLabel(nextStatus!)}`,
            { authorId: actorPersonId, isSystem: true },
          );
        } catch {
          // Swallowed on purpose — see the comment above.
        }
      }

      res.json(updated);
    } catch (err) {
      const mapped = toClientError(err as Error);
      if (!mapped) throw err;
      res.status(mapped.status).json({ error: mapped.error });
    }
  }),
);

// ── Acceptance-criteria checklist ─────────────────────────────────────────────
// GET/POST /api/graph/work-items/:id/criteria
// PATCH/DELETE /api/graph/work-items/:id/criteria/:criterionId
//
// Tenant-open reads, writeGate'd mutations — the same posture as the rest of
// this router. A checklist item belongs to exactly one work item, so every
// route below checks the parent id first: a criterion id that resolves under
// the WRONG work item id is treated as not found, not silently allowed.

workItemsRouter.get(
  '/work-items/:id/criteria',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }
    const criteria = await listWorkItemCriteria(id);
    res.json({ criteria });
  }),
);

workItemsRouter.post(
  '/work-items/:id/criteria',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const stray = unknownKeys(body, ['text']);
    if (stray.length > 0) {
      res.status(400).json({ error: `unrecognised field${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}` });
      return;
    }
    const textError = checkCriterionText(body['text']);
    if (textError) { res.status(400).json({ error: textError }); return; }

    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }

    const criterion = await createWorkItemCriterion(id, (body['text'] as string).trim());
    res.status(201).json(criterion);
  }),
);

const CRITERION_PATCH_KEYS = ['text', 'done', 'position'] as const;

workItemsRouter.patch(
  '/work-items/:id/criteria/:criterionId',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    const criterionId = req.params['criterionId'] as string;
    if (!id || !criterionId) { res.status(400).json({ error: 'Missing work item or criterion id' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const stray = unknownKeys(body, CRITERION_PATCH_KEYS);
    if (stray.length > 0) {
      res.status(400).json({ error: `unrecognised field${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}` });
      return;
    }
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: `no fields to update — send one of: ${CRITERION_PATCH_KEYS.join(', ')}` });
      return;
    }
    const fieldError = ('text' in body ? checkCriterionText(body['text']) : null)
      ?? ('done' in body ? checkCriterionDone(body['done']) : null)
      ?? ('position' in body ? checkCriterionPosition(body['position']) : null);
    if (fieldError) { res.status(400).json({ error: fieldError }); return; }

    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }

    const updated = await updateWorkItemCriterion(id, criterionId, {
      ...('text' in body ? { text: (body['text'] as string).trim() } : {}),
      ...('done' in body ? { done: body['done'] as boolean } : {}),
      ...('position' in body ? { position: body['position'] as number } : {}),
    });
    if (!updated) { res.status(404).json({ error: 'Criterion not found' }); return; }
    res.json(updated);
  }),
);

workItemsRouter.delete(
  '/work-items/:id/criteria/:criterionId',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    const criterionId = req.params['criterionId'] as string;
    if (!id || !criterionId) { res.status(400).json({ error: 'Missing work item or criterion id' }); return; }

    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }

    const deleted = await deleteWorkItemCriterion(id, criterionId);
    if (!deleted) { res.status(404).json({ error: 'Criterion not found' }); return; }
    res.status(204).end();
  }),
);

// ── Comments (planning notes / discussion) ────────────────────────────────────
// GET/POST /api/graph/work-items/:id/comments
//
// The comment feed a work item's own detail view reads — oldest first, unlike
// the project-wide activity feed (getProjectActivity), which is newest-first
// and unions comments with item lifecycle events. `total` counts non-system
// rows only: the status-change audit trail PATCH now leaves behind is history,
// not something a "N comments" pill should count.

workItemsRouter.get(
  '/work-items/:id/comments',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }
    const { comments, total } = await listWorkItemComments(id);
    res.json({ comments, total });
  }),
);

workItemsRouter.post(
  '/work-items/:id/comments',
  writeGate,
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) { res.status(400).json({ error: 'Missing work item id' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const stray = unknownKeys(body, ['body']);
    if (stray.length > 0) {
      res.status(400).json({ error: `unrecognised field${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}` });
      return;
    }
    const bodyError = checkCommentBody(body['body']);
    if (bodyError) { res.status(400).json({ error: bodyError }); return; }

    if (!(await getWorkItem(id))) { res.status(404).json({ error: 'Work item not found' }); return; }

    // writeGate already required a session (requireAction 401s otherwise),
    // so this is never null here — but resolveSession's return type is
    // nullable and there is no reason to assert past it blind.
    const session = resolveSession(req);
    const personId = session ? (await getUser(session.sub))?.personId ?? null : null;
    if (!personId) {
      res.status(409).json({ error: 'Link your account to a person in the org graph before commenting' });
      return;
    }

    const comment = await createWorkItemComment(id, personId, (body['body'] as string).trim());
    res.status(201).json(comment);
  }),
);
