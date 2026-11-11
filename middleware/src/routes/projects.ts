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
// carries. Both also need the initiative's own people (requireInitiativeScope),
// and naming the owner needs its current owner or an org-wide role.

import { Router, type Response } from 'express';
import {
  listProjects, getProject, updateProjectOwner, setContributionRole, createProject,
  type GovernanceWriteResult,
} from '../providers/projects.js';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { mineViewer } from '../lib/mine.js';
import { canReadBudgets, withholdBudget } from '../lib/budget-read-tier.js';
import { ORG_WIDE_INITIATIVE_ROLES, ownsInitiative, requireInitiativeScope, stewardsInitiative } from '../lib/initiative-scope.js';
import { DEMO_SUB } from '../lib/demo-sub.js';
import { insecureDevMode } from '../lib/insecure-dev-mode.js';
import { PROFILE_ID_RE } from '../lib/devbox-profile.js';
import { latestProfile, setInitiativeProfile } from '../providers/devbox-profiles.js';

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

// POST /api/graph/projects  body {name, summary?, owner_person_id?, sponsor_person_id?, repo?}
//
// Start an initiative by hand (docs/create-initiative-design.md). The gate chain is
// the mount's requireTenant('orgiq') (index.ts), then CreateInitiative here: held by
// org-leader and program-owner, with admin passing as it does everywhere. The mount
// carries no write gate of its own, so nothing else reaches this route. The server
// makes the id; unknown fields are ignored.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
projectsRouter.post('/', requireAction('CreateInitiative'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number, required: boolean): string | null => {
    const raw = body[key];
    if (raw == null || raw === '') {
      if (required) throw new ValidationError(`${key} is required`);
      return null;
    }
    if (typeof raw !== 'string') throw new ValidationError(`${key} must be text`);
    const v = raw.trim();
    if (!v) {
      if (required) throw new ValidationError(`${key} is required`);
      return null;
    }
    if (v.length > max) throw new ValidationError(`${key} must be at most ${max} characters`);
    return v;
  };
  const name = text('name', 80, true)!;
  const summary = text('summary', 600, false);
  const repo = text('repo', 140, false);
  if (repo && !REPO_RE.test(repo)) throw new ValidationError('repo must look like owner/name');
  const ownerNamed = text('owner_person_id', 200, false);
  const sponsor = text('sponsor_person_id', 200, false);

  const session = resolveSession(req);
  const ownerPersonId = ownerNamed ?? (session ? (await mineViewer(session)).personId : null);
  if (!ownerPersonId) {
    throw new ValidationError('This account is not linked to a person, so name an owner (owner_person_id)');
  }

  const result = await createProject({ name, summary, ownerPersonId, sponsorPersonId: sponsor, repoFullName: repo });
  if (!result.ok) {
    res.status(result.status).json({
      error: result.error, code: result.code,
      ...(result.existingId ? { existingId: result.existingId } : {}),
    });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ ...(await canReadBudgets(session) ? result.project : withholdBudget(result.project)), canWriteWork: true });
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
  const session = resolveSession(req);
  // canWriteWork: whether this caller is one of the initiative's people (owner,
  // contributor or an org-wide role), the scope every work write asks
  // (routes/work-items.ts). The page hides its edit controls without it; the
  // role's own action is the portal's can() and is not repeated here.
  const canWriteWork = await stewardsInitiative(session, id);
  res.json({ ...(await canReadBudgets(session) ? project : withholdBudget(project)), canWriteWork });
}));

/**
 * Naming who runs an initiative is its owner's call, or an org-wide role's
 * (the demo identity counts as one under INSECURE_DEV_MODE, as in
 * stewardsInitiative). A contributor may not make themselves owner.
 */
async function mayNameOwner(req: { session?: import('../lib/session.js').Session | null }, res: Response, id: string): Promise<boolean> {
  const session = req.session ?? null;
  if (session?.role && ORG_WIDE_INITIATIVE_ROLES.includes(session.role)) return true;
  if (session?.sub === DEMO_SUB && insecureDevMode()) return true;
  if (await ownsInitiative(session, id)) return true;
  res.status(403).json({ error: 'only the initiative\'s owner or an org-wide role can name its owner', code: 'NOT_INITIATIVE_OWNER', initiativeId: id });
  return false;
}

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
  if (!await requireInitiativeScope(req, res, id, { action: 'change the owner of' })) return;
  if (!await mayNameOwner(req, res, id)) return;

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
  if (!await requireInitiativeScope(req, res, id, { action: 'change contributor roles on' })) return;

  const result = await setContributionRole(id, personId, role);
  if (relayFailure(res, result)) return;
  res.json({ ok: true });
}));

// PATCH /api/graph/projects/:id/devbox-profile  body {profileId: string|null}
// Points the initiative's boxes at a devbox policy profile (DE-40); null
// clears it back to `default`. Takes effect on the NEXT box — a running box
// keeps the version it was created under. Only a published profile id may be
// named.
//
// WHO may assign is an open user decision (the spec proposes the initiative's
// program owner or an org-leader). Built conservatively: Cedar `ManageBudgets`
// (hr-admin, org-leader, program-owner — the existing program-management
// action) AND a steward of this initiative (owner/contributor, or an org-wide
// role), so a program-owner assigns only on initiatives they run.
projectsRouter.patch('/:id/devbox-profile', requireAction('ManageBudgets'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!id) throw new ValidationError('Invalid project id');
  const body = (req.body ?? {}) as { profileId?: unknown };
  if (!('profileId' in body)) throw new ValidationError('profileId is required (a profile id, or null to clear)');
  if (body.profileId !== null && typeof body.profileId !== 'string') throw new ValidationError('profileId must be a string, or null to clear');
  const profileId = body.profileId === null ? null : body.profileId.trim();
  if (profileId !== null && !PROFILE_ID_RE.test(profileId)) throw new ValidationError('profileId is not a profile id');

  if (!await stewardsInitiative(req.session ?? null, id)) {
    res.status(403).json({ error: 'you can only set the devbox profile of an initiative you own or contribute to', code: 'NOT_ON_INITIATIVE', projectId: id });
    return;
  }
  if (profileId !== null && profileId !== 'default' && !await latestProfile(profileId)) {
    res.status(400).json({ error: `no published profile "${profileId}"`, code: 'UNKNOWN_PROFILE' });
    return;
  }
  const result = await setInitiativeProfile(id, profileId === 'default' ? null : profileId);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json({ ok: true, profileId: profileId ?? 'default' });
}));
