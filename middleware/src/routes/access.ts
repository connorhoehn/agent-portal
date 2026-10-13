// /api/access — the access tenant's API (docs/access-tenant-design.md,
// docs/access-tenant-goal.md §Routes; wire shapes docs/access-tenant-api.md).
//
// Mounted in index.ts as `app.use('/api/access', requireTenant('access'), accessRouter)`.
// Cedar gates each route (ViewAccess / RequestAccess / DecideAccess /
// ManageAccessPolicy); the two rules Cedar cannot see run here, after it,
// with contract tests (routes/__tests__/access.test.ts):
//   * nobody decides a request they submitted or benefit from → 403;
//   * a step is decided once → 409.
// Who may decide a step is resolved live from the directory on every read and
// decision (lib/access/chain.ts), never read off the request.
//
// Lane A1 (docs/access-tenant-goal.md §A1): the last approval provisions
// (lib/access-provision.ts — setGrants / the contribution writer, the epoch
// bump, `provisioned` → `active`); expiry is lib/access-expiry.ts; the bell
// items go through lib/social-notify.ts `notifyAccessRequest`; the request's
// thread `access:req:<id>` is admitted by the gateway under this file's read
// rule (lib/access/thread.ts). Reviews are A2 (`GET /reviews` answers no rows).

import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, resolveSession } from '../lib/authz.js';
import { eligibleDeciders, personFor, planChain } from '../lib/access/chain.js';
import { sodConflicts, sodVerdict } from '../lib/access/sod.js';
import { decide, isOpen, ELEVATED_STATUSES, submitRows, TransitionError, withdraw, currentStep } from '../lib/access/status.js';
import { canFlags, decideRefusal, isParty, managesBeneficiary, mayRead, type AccessActor } from '../lib/access/rules.js';
import {
  ACCESS_TENANTS, DURATIONS, REQUEST_STATUSES, requestThread,
  type AccessDirectory, type AccessDuration, type AccessEvent, type AccessPolicy, type AccessRequest,
  type CatalogItem, type Decision, type DirectoryUser,
} from '../lib/access/types.js';
import { provisionAccess } from '../lib/access-provision.js';
import { notifyAccessRequest, type AccessNotifyKind } from '../lib/social-notify.js';
import {
  accessNow, insertRequest, listCatalog, listEvents, listPolicies, listRequests, listSteps, loadDirectory,
  nextRequestId, saveTransition, updatePolicy,
  type AccessCatalogRow, type AccessPolicyRow, type AccessRequestRow, type AccessStepRow,
} from '../providers/access.js';

export const accessRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

const MIN_JUSTIFICATION = 20;
const MAX_TEXT = 2000;

/** Refuse any body key outside `allowed` (docs/access-tenant-api.md: unknown keys are 400). */
function bodyOf(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body = req.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new ValidationError('Body must be a JSON object');
  const b = (body ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ValidationError(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return b;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

interface Ctx { actor: AccessActor; dir: AccessDirectory; self: DirectoryUser | null }

async function context(req: Request): Promise<Ctx> {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Sign in first');
  const principal = { sub: session.sub, tenant: session.tenant, role: session.role };
  const [dir, mayDecide, mayProvision] = await Promise.all([
    loadDirectory(), isAllowed(principal, 'DecideAccess'), isAllowed(principal, 'ProvisionAccess'),
  ]);
  const self = dir.users.find((u) => u.id === session.sub) ?? null;
  return { dir, self, actor: { id: session.sub, personId: self?.personId ?? null, role: session.role, mayDecide, mayProvision } };
}

/** Does `who` hold the item now (a tenant role, or a contribution on the initiative)? */
function holdsItem(item: AccessCatalogRow, who: DirectoryUser | null, dir: AccessDirectory): boolean {
  if (!who) return false;
  if (item.kind === 'tenant-role') return !!item.role && (who.grants[item.tenant] ?? []).includes(item.role);
  const members = item.projectId ? dir.initiative(item.projectId)?.memberPersonIds ?? [] : [];
  return !!who.personId && members.includes(who.personId);
}

function catalogItem(row: AccessCatalogRow, ctx: Ctx, policies: readonly AccessPolicyRow[]): CatalogItem {
  return {
    id: row.id, kind: row.kind, tenant: row.tenant,
    ...(row.role ? { role: row.role } : {}), ...(row.projectId ? { projectId: row.projectId } : {}),
    title: row.title, description: row.description, sensitive: row.sensitive,
    defaultDuration: row.defaultDuration, stewardRule: row.stewardRule,
    heldByActor: holdsItem(row, ctx.self, ctx.dir),
    sodConflicts: sodConflicts(row, ctx.self?.grants ?? {}, policies),
  };
}

/** A catalog item no longer in the catalog still renders the request that named it. */
function missingItem(id: string): AccessCatalogRow {
  return { id, kind: 'tenant-role', tenant: 'orgiq', role: null, projectId: null, title: id, description: 'This item is no longer in the catalog.', sensitive: false, defaultDuration: '30d', stewardRule: 'tenant-steward' };
}

interface World { catalog: Map<string, AccessCatalogRow>; policies: AccessPolicyRow[]; steps: Map<string, AccessStepRow[]> }

function world(): World {
  const steps = new Map<string, AccessStepRow[]>();
  for (const s of listSteps()) steps.set(s.requestId, [...(steps.get(s.requestId) ?? []), s]);
  for (const list of steps.values()) list.sort((a, b) => a.step - b.step);
  return { catalog: new Map(listCatalog().map((i) => [i.id, i])), policies: listPolicies(), steps };
}

function present(r: AccessRequestRow, ctx: Ctx, w: World): AccessRequest {
  const steps = w.steps.get(r.id) ?? [];
  const row = w.catalog.get(r.itemId);
  const item = row ?? missingItem(r.itemId);
  const beneficiary = ctx.dir.users.find((u) => u.id === r.beneficiaryId) ?? null;
  const conflicts = sodConflicts(item, beneficiary?.grants ?? {}, w.policies);
  return {
    id: r.id,
    requester: personFor(ctx.dir, r.requesterId)!,
    beneficiary: personFor(ctx.dir, r.beneficiaryId)!,
    item: catalogItem(item, ctx, w.policies),
    justification: r.justification,
    duration: r.duration,
    status: r.status,
    steps: steps.map((s) => ({
      step: s.step, kind: s.kind, status: s.status,
      decidedBy: personFor(ctx.dir, s.decidedBy), decidedAt: s.decidedAt, comment: s.comment,
      eligible: row && isOpen(r.status) && (s.status === 'current' || s.status === 'waiting' || s.status === 'info-requested')
        ? eligibleDeciders(s.kind, row, r, ctx.dir) : [],
    })),
    submittedAt: r.submittedAt,
    decidedAt: r.decidedAt, provisionedAt: r.provisionedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt,
    sod: {
      verdict: r.sodOverriddenBy ? r.sodVerdict : sodVerdict(conflicts), conflicts,
      overriddenBy: personFor(ctx.dir, r.sodOverriddenBy), overrideReason: r.sodOverrideReason,
    },
    can: canFlags(ctx.actor, r, steps, row, ctx.dir),
    thread: requestThread(r.id),
  };
}

const readable = (ctx: Ctx, w: World) => (r: AccessRequestRow) => mayRead(ctx.actor, r, w.steps.get(r.id) ?? [], w.catalog.get(r.itemId), ctx.dir);

/** Requests whose current step the actor may decide now (never their own). */
function approvalsFor(ctx: Ctx, w: World, requests: readonly AccessRequestRow[]): AccessRequestRow[] {
  if (!ctx.actor.mayDecide) return [];
  return requests.filter((r) => {
    if (!isOpen(r.status) || isParty(ctx.actor.id, r)) return false;
    const cur = currentStep(w.steps.get(r.id) ?? []);
    const item = w.catalog.get(r.itemId);
    return !!cur && !!item && eligibleDeciders(cur.kind, item, r, ctx.dir).some((p) => p.id === ctx.actor.id);
  });
}

const newestFirst = (a: { submittedAt: string }, b: { submittedAt: string }) => b.submittedAt.localeCompare(a.submittedAt);

function matchesQuery(r: AccessRequest, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [r.id, r.item.title, r.justification, r.requester.displayName, r.beneficiary.displayName]
    .some((s) => s.toLowerCase().includes(needle));
}

function presentPolicy(p: AccessPolicyRow, dir: AccessDirectory): AccessPolicy {
  return { id: p.id, title: p.title, reason: p.reason, severity: p.severity, left: p.left, right: p.right, updatedAt: p.updatedAt, updatedBy: personFor(dir, p.updatedBy) };
}

function loadRequest(id: string): AccessRequestRow {
  const r = listRequests().find((x) => x.id === id);
  if (!r) throw new NotFoundError(`No request ${id}`);
  return r;
}

/**
 * The bell for one transition (decision A8): the parties hear about decisions,
 * and whoever may decide the request's current step NOW hears that it waits
 * on them. Never fails the write it follows (notify() swallows its errors).
 */
async function bell(kind: AccessNotifyKind, r: AccessRequestRow, ctx: Ctx, extra: { step?: number | null; comment?: string | null } = {}): Promise<void> {
  const row = listCatalog().find((i) => i.id === r.itemId);
  const base = {
    requestId: r.id, itemTitle: row?.title ?? r.itemId, requesterId: r.requesterId, beneficiaryId: r.beneficiaryId,
    beneficiaryName: personFor(ctx.dir, r.beneficiaryId)?.displayName ?? null,
    actorId: ctx.actor.id, actorName: ctx.self?.displayName ?? null, ...extra,
  };
  await notifyAccessRequest({ kind, ...base });
}

/** Tell whoever may decide the current step now (resolved live) that it waits on them. */
async function bellApprovers(kind: 'submitted' | 'awaiting', r: AccessRequestRow, ctx: Ctx): Promise<void> {
  const row = listCatalog().find((i) => i.id === r.itemId);
  const cur = currentStep(listSteps(r.id));
  if (!row || !cur) return;
  const approverIds = eligibleDeciders(cur.kind, row, r, ctx.dir).map((p) => p.id);
  await notifyAccessRequest({
    kind, requestId: r.id, itemTitle: row.title, requesterId: r.requesterId, beneficiaryId: r.beneficiaryId,
    beneficiaryName: personFor(ctx.dir, r.beneficiaryId)?.displayName ?? null, actorId: ctx.actor.id, approverIds, step: cur.step,
  });
}

// ─── reads ──────────────────────────────────────────────────────────────────

accessRouter.get('/summary', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const w = world();
  const requests = listRequests();
  const visible = requests.filter(readable(ctx, w));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    openRequests: visible.filter((r) => isOpen(r.status)).length,
    pendingForMe: approvalsFor(ctx, w, requests).length,
    activeElevations: visible.filter((r) => ELEVATED_STATUSES.has(r.status)).length,
    policies: w.policies.length,
    // Review campaigns are phase A2; there are no rows to count yet.
    reviews: 0,
  });
}));

accessRouter.get('/catalog', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const policies = listPolicies();
  const kind = str(req.query['kind']);
  const tenant = str(req.query['tenant']);
  const q = str(req.query['q'])?.toLowerCase();
  if (kind && kind !== 'tenant-role' && kind !== 'initiative-membership') throw new ValidationError(`Unknown kind: ${kind}`);
  if (tenant && !(ACCESS_TENANTS as readonly string[]).includes(tenant)) throw new ValidationError(`Unknown tenant: ${tenant}`);
  const items = listCatalog()
    .filter((i) => (!kind || i.kind === kind) && (!tenant || i.tenant === tenant)
      && (!q || i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.id.includes(q)))
    .map((i) => catalogItem(i, ctx, policies));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

accessRouter.get('/requests', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const scope = str(req.query['scope']) ?? 'mine';
  if (scope !== 'mine' && scope !== 'reports' && scope !== 'all') throw new ValidationError(`Unknown scope: ${scope}`);
  const status = str(req.query['status']);
  if (status && !(REQUEST_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Unknown status: ${status}`);
  const ctx = await context(req);
  if (scope === 'all' && !ctx.actor.mayDecide) {
    res.status(403).json({ error: 'scope=all needs DecideAccess', action: 'DecideAccess' });
    return;
  }
  const w = world();
  const inScope = (r: AccessRequestRow): boolean => scope === 'mine' ? isParty(ctx.actor.id, r)
    : scope === 'reports' ? r.beneficiaryId !== ctx.actor.id && managesBeneficiary(ctx.actor, r, ctx.dir)
    : true;
  const items = listRequests()
    .filter((r) => inScope(r) && (!status || r.status === status))
    .filter(readable(ctx, w))
    .sort(newestFirst)
    .map((r) => present(r, ctx, w))
    .filter((r) => matchesQuery(r, str(req.query['q'])));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

accessRouter.get('/requests/:id', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const w = world();
  const r = listRequests().find((x) => x.id === req.params['id']);
  // Outside the read rule a request does not exist (no existence oracle).
  if (!r || !readable(ctx, w)(r)) throw new NotFoundError(`No request ${String(req.params['id'])}`);
  res.setHeader('Cache-Control', 'no-store');
  res.json(present(r, ctx, w));
}));

accessRouter.get('/approvals', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const w = world();
  const items = approvalsFor(ctx, w, listRequests()).sort(newestFirst).map((r) => present(r, ctx, w));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

accessRouter.get('/policies', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: listPolicies().map((p) => presentPolicy(p, ctx.dir)) });
}));

accessRouter.get('/audit', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const requestId = str(req.query['requestId']);
  const q = str(req.query['q'])?.toLowerCase();
  // ViewAccess reads the events of one's own requests; DecideAccess reads all.
  const own = new Set(listRequests().filter((r) => isParty(ctx.actor.id, r)).map((r) => r.id));
  const items: AccessEvent[] = listEvents()
    .filter((e) => (ctx.actor.mayDecide || own.has(e.requestId)) && (!requestId || e.requestId === requestId))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .map((e) => ({ id: e.id, at: e.at, requestId: e.requestId, actor: personFor(ctx.dir, e.actorId), kind: e.kind, before: e.beforeStatus, after: e.afterStatus, reason: e.reason }))
    .filter((e) => !q || [e.requestId, e.kind, e.reason ?? '', e.actor?.displayName ?? ''].some((s) => s.toLowerCase().includes(q)));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

accessRouter.get('/reviews', requireAction('ViewAccess'), (_req, res) => {
  // Review campaigns are phase A2 (docs/access-tenant-goal.md §A2).
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: [], limits: ['Access reviews arrive in phase A2; no campaign exists yet.'] });
});

// ─── writes ─────────────────────────────────────────────────────────────────

accessRouter.post('/requests', requireAction('RequestAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['itemId', 'justification', 'duration', 'beneficiaryId']);
  const itemId = str(b['itemId']);
  const justification = typeof b['justification'] === 'string' ? b['justification'].trim() : '';
  const duration = b['duration'];
  if (!itemId) throw new ValidationError('itemId is required');
  if (justification.length < MIN_JUSTIFICATION) throw new ValidationError(`justification must be at least ${MIN_JUSTIFICATION} characters`);
  if (justification.length > MAX_TEXT) throw new ValidationError(`justification must be at most ${MAX_TEXT} characters`);
  if (typeof duration !== 'string' || !(DURATIONS as readonly string[]).includes(duration)) throw new ValidationError(`duration must be one of ${DURATIONS.join(', ')}`);
  if (b['beneficiaryId'] !== undefined && typeof b['beneficiaryId'] !== 'string') throw new ValidationError('beneficiaryId must be a string');

  const ctx = await context(req);
  const item = listCatalog().find((i) => i.id === itemId);
  if (!item) throw new ValidationError(`Unknown catalog item: ${itemId}`);
  const beneficiaryId = str(b['beneficiaryId']) ?? ctx.actor.id;
  const beneficiary = ctx.dir.users.find((u) => u.id === beneficiaryId) ?? null;
  if (!beneficiary) throw new ValidationError(`Unknown beneficiary: ${beneficiaryId}`);
  if (beneficiaryId !== ctx.actor.id) {
    if (!ctx.actor.mayDecide) {
      res.status(403).json({ error: 'Requesting on behalf of someone else needs DecideAccess', action: 'DecideAccess' });
      return;
    }
    // An approver files for a report; an access-admin for anyone.
    if (!ctx.actor.mayProvision && !managesBeneficiary(ctx.actor, { beneficiaryId }, ctx.dir)) {
      res.status(403).json({ error: `${beneficiary.displayName} is not one of your reports` });
      return;
    }
  }
  if (holdsItem(item, beneficiary, ctx.dir)) {
    res.status(409).json({ error: `${beneficiary.displayName} already holds ${item.title}` });
    return;
  }
  const requests = listRequests();
  const duplicate = requests.find((r) => r.beneficiaryId === beneficiaryId && r.itemId === item.id && isOpen(r.status));
  if (duplicate) {
    res.status(409).json({ error: `${duplicate.id} already asks for ${item.title} and is still open`, requestId: duplicate.id });
    return;
  }
  const policies = listPolicies();
  const conflicts = sodConflicts(item, beneficiary.grants, policies);
  const verdict = sodVerdict(conflicts);
  if (verdict === 'block') {
    res.status(409).json({ error: `Separation of duties blocks ${item.title} for ${beneficiary.displayName}`, sod: { verdict, conflicts } });
    return;
  }
  const now = accessNow();
  const t = submitRows({
    id: nextRequestId(), requesterId: ctx.actor.id, beneficiaryId, itemId: item.id, justification,
    duration: duration as AccessDuration, sodVerdict: verdict, sodOverriddenBy: null, sodOverrideReason: null, submittedAt: now,
  }, planChain(item, beneficiary, ctx.dir));
  insertRequest(t.request, t.steps, t.events, ctx.actor.id);
  await bellApprovers('submitted', t.request, ctx);
  const w = world();
  res.status(201).json(present(t.request, ctx, w));
}));

accessRouter.post('/requests/:id/withdraw', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['reason']);
  const reason = b['reason'] === undefined ? null : str(b['reason']) ?? null;
  if (b['reason'] !== undefined && typeof b['reason'] !== 'string') throw new ValidationError('reason must be a string');
  const ctx = await context(req);
  const w = world();
  const r = listRequests().find((x) => x.id === req.params['id']);
  if (!r || !readable(ctx, w)(r)) throw new NotFoundError(`No request ${String(req.params['id'])}`);
  if (!isParty(ctx.actor.id, r)) {
    res.status(403).json({ error: 'Only the requester or the beneficiary can withdraw a request' });
    return;
  }
  try {
    const t = withdraw(r, w.steps.get(r.id) ?? [], reason);
    saveTransition(t.request, t.steps, t.events, ctx.actor.id, accessNow());
  } catch (err) {
    if (err instanceof TransitionError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  await bell('withdrawn', r, ctx, { comment: reason });
  res.json(present(loadRequest(r.id), ctx, world()));
}));

accessRouter.post('/requests/:id/steps/:step/decide', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['decision', 'comment']);
  const decision = b['decision'];
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'info') throw new ValidationError('decision must be approve, reject or info');
  if (b['comment'] !== undefined && b['comment'] !== null && typeof b['comment'] !== 'string') throw new ValidationError('comment must be a string');
  const comment = str(b['comment']) ?? null;
  if (comment && comment.length > MAX_TEXT) throw new ValidationError(`comment must be at most ${MAX_TEXT} characters`);
  if (decision !== 'approve' && !comment) throw new ValidationError(`A ${decision === 'reject' ? 'rejection' : 'request for information'} needs a comment`);
  const stepNo = Number(req.params['step']);
  if (!Number.isInteger(stepNo) || stepNo < 1) throw new ValidationError('step must be a positive integer');

  const ctx = await context(req);
  const w = world();
  const r = listRequests().find((x) => x.id === req.params['id']);
  if (!r || !readable(ctx, w)(r)) throw new NotFoundError(`No request ${String(req.params['id'])}`);
  const steps = w.steps.get(r.id) ?? [];
  const item = w.catalog.get(r.itemId);
  if (!item) throw new AppError(409, `${r.itemId} is no longer in the catalog; the request cannot be decided`);
  const refusal = decideRefusal(ctx.actor, r, steps, stepNo, item, ctx.dir);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  const now = accessNow();
  let after: AccessRequestRow;
  try {
    const t = decide(r, steps, stepNo, decision as Decision, ctx.actor.id, comment, now);
    saveTransition(t.request, t.steps, t.events, ctx.actor.id, now);
    after = t.request;
  } catch (err) {
    if (err instanceof TransitionError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  if (after.status === 'approved') {
    // The last approval provisions (A1). A failed grant write leaves the
    // request `approved` (honest: decided, not in effect) and tells the parties.
    try {
      await provisionAccess(after);
    } catch (err) {
      console.warn(`[access] provisioning ${after.id} failed: ${(err as Error).message}`);
      await bell('provision-failed', after, ctx, { step: stepNo });
    }
  } else if (decision === 'approve') {
    await bell('approved-step', after, ctx, { step: stepNo, comment });
    await bellApprovers('awaiting', after, ctx);
  } else {
    await bell(decision === 'reject' ? 'rejected' : 'info-requested', after, ctx, { step: stepNo, comment });
  }
  res.json(present(loadRequest(r.id), ctx, world()));
}));

accessRouter.put('/policies/:id', requireAction('ManageAccessPolicy'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['severity', 'reason']);
  if (b['severity'] === undefined && b['reason'] === undefined) throw new ValidationError('Send severity and/or reason');
  if (b['severity'] !== undefined && b['severity'] !== 'warn' && b['severity'] !== 'block') throw new ValidationError('severity must be warn or block');
  let reason: string | undefined;
  if (b['reason'] !== undefined) {
    reason = str(b['reason']);
    if (!reason) throw new ValidationError('reason must be a non-empty string');
    if (reason.length > MAX_TEXT) throw new ValidationError(`reason must be at most ${MAX_TEXT} characters`);
  }
  const ctx = await context(req);
  const row = updatePolicy(String(req.params['id']), { severity: b['severity'] as AccessPolicyRow['severity'] | undefined, reason }, ctx.actor.id);
  if (!row) throw new NotFoundError(`No policy ${String(req.params['id'])}`);
  res.json(presentPolicy(row, ctx.dir));
}));
