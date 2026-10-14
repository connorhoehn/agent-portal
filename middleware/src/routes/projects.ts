// Initiatives — /api/graph/projects (mounted under requireTenant('orgiq') in
// index.ts: initiative data is orgiq-tenant data).
//
// Reads are open to the tenant like the rest of the graph surface — except the
// money: below the budgets read tier (lib/budget-read-tier.ts) both reads drop
// `agentSpendUsd` / `allocatedUsd` and carry `budgetAccess: { visible: false,
// reason, requestItemId }` instead, so the portal renders a locked cell and a
// request for the tier rather than a number (decided 2026-10-13). A tier
// holder's payload is unchanged. The two
// governance writes — who runs an initiative (projects.owner_id) and what role
// a contributor holds (project_contributions.role) — are gated on
// DispatchAgentRun: naming an owner or an SME is deciding who may direct
// agents on this initiative, the same authority the marketplace's dispatch
// carries.

import { Router, type Response } from 'express';
import {
  listProjects, getProject, updateProjectOwner, setContributionRole,
  type GovernanceWriteResult,
} from '../providers/projects.js';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { mineViewer } from '../lib/mine.js';
import { canReadBudgets, withholdBudget } from '../lib/budget-read-tier.js';

export const projectsRouter = Router();

const governGate = requireAction('DispatchAgentRun');

// GET /api/graph/projects?status=&limit=N&scope=mine|all
//
// `scope=mine` narrows to initiatives the session's linked person owns or
// contributes to — the one "mine" viewer every such read resolves (lib/mine.ts
// `mineViewer`; GET /api/me/groups?kind=initiative answers the same rows in the
// shared `MineReply` shape), so the Delivery surfaces agree about whose work is
// whose. Default is `all` (this list has always been tenant-open); an unlinked
// account asking for `mine` gets an empty list, and the portal's empty state
// names the fix. This route keeps the project-summary array the Initiatives
// page reads.
projectsRouter.get('/', asyncHandler(async (req, res) => {
  const status = req.query['status'] as string | undefined;
  const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

  const scope = String(req.query['scope'] ?? 'all').trim();
  if (scope !== 'mine' && scope !== 'all') {
    throw new ValidationError("scope must be 'mine' or 'all'");
  }
  let personId: string | null = null;
  if (scope === 'mine') {
    const session = resolveSession(req);
    personId = session ? (await mineViewer(session)).personId : null;
  }

  const projects = await listProjects({
    status: status || undefined,
    limit,
    mineOnly: scope === 'mine',
    personId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(await canReadBudgets(resolveSession(req)) ? projects : projects.map(withholdBudget));
}));

// GET /api/graph/projects/:id
projectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params['id'];
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'Invalid project id' });
    return;
  }
  const project = await getProject(id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(await canReadBudgets(resolveSession(req)) ? project : withholdBudget(project));
}));

/** The provider names each refusal's HTTP meaning; the route just relays it. */
function relayFailure(res: Response, result: GovernanceWriteResult): boolean {
  if (result.ok) return false;
  res.status(result.status).json({ error: result.error });
  return true;
}

// PATCH /api/graph/projects/:id  body {ownerId: string|null}
// Sets (or clears) the one person running the initiative.
projectsRouter.patch('/:id', governGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!id) throw new ValidationError('Invalid project id');

  const body = (req.body ?? {}) as { ownerId?: unknown };
  if (!('ownerId' in body)) throw new ValidationError('ownerId is required (a person id, or null to clear)');
  if (body.ownerId !== null && typeof body.ownerId !== 'string') {
    throw new ValidationError('ownerId must be a person id string, or null to clear');
  }
  const ownerId = body.ownerId === null ? null : body.ownerId.trim();
  if (ownerId === '') throw new ValidationError('ownerId cannot be empty — use null to clear');

  const result = await updateProjectOwner(id, ownerId);
  if (relayFailure(res, result)) return;
  res.json({ ok: true, ownerId });
}));

// PATCH /api/graph/projects/:id/contributors/:personId  body {role: string|null}
// Sets (or clears) a contributor's role. 'owner' / 'sme' are the reserved
// values the marketplace honors; the column stays free text beyond that.
projectsRouter.patch('/:id/contributors/:personId', governGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const personId = String(req.params['personId'] ?? '');
  if (!id || !personId) throw new ValidationError('Invalid project or person id');

  const body = (req.body ?? {}) as { role?: unknown };
  if (!('role' in body)) throw new ValidationError('role is required (a role string, or null to clear)');
  if (body.role !== null && typeof body.role !== 'string') {
    throw new ValidationError('role must be a string, or null to clear');
  }
  const role = body.role === null ? null : body.role.trim();
  if (role === '') throw new ValidationError('role cannot be empty — use null to clear');

  const result = await setContributionRole(id, personId, role);
  if (relayFailure(res, result)) return;
  res.json({ ok: true });
}));
