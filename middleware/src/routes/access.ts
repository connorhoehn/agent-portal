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
// rule (lib/access/thread.ts).
//
// Escalation timers and delegation (2026-10-14, docs/access-tenant-api.md
// § "Escalation timers and delegation"): a step past its SLA escalates
// (lib/access-escalation.ts) and every read resolves deciders at the step's
// level; an approver hands their decisions to another approver for a window
// (`/delegations`, lib/access/delegation.ts) and a delegate's decision records
// whom it was made for.
//
// Lane A2 (docs/access-tenant-goal.md §A2): separation of duties is evaluated
// at submit (the 409 pre-check below) and again at provisioning against the
// beneficiary's CURRENT grants (lib/access-provision.ts); a block there leaves
// the request `approved` until an access admin records an override
// (`POST /requests/:id/sod-override`, which re-runs the provisioning). An
// access admin revokes an active grant by hand (`POST /requests/:id/revoke`).
// Review campaigns (`/reviews*`) certify the standing grants of one tenant; a
// `revoke` decision is a pre-approved revocation request (kind `revocation`)
// revoked through lib/access-provision.ts `revokeAccess` with the reviewer as
// the actor.

import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, resolveSession } from '../lib/authz.js';
import { ACCESS_DECIDER_ROLES, BUDGET_OWNER_ROLE, decidingOnBehalfOf, eligibility, eligibleDeciders, nextEscalationLevel, personFor, planChain, TENANT_STEWARD_ROLE } from '../lib/access/chain.js';
import { delegationRefusal, delegationState, MAX_DELEGATION_DAYS } from '../lib/access/delegation.js';
import { escalatesAt, escalationSlaMs } from '../lib/access-escalation.js';
import { sodConflicts, sodVerdict } from '../lib/access/sod.js';
import { decide, isOpen, ELEVATED_STATUSES, submitRows, TransitionError, withdraw, currentStep } from '../lib/access/status.js';
import { canFlags, decideRefusal, isParty, managesBeneficiary, mayRead, type AccessActor } from '../lib/access/rules.js';
import { grantItemId, requestItem } from '../lib/access/items.js';
import {
  ACCESS_KINDS, ACCESS_TENANTS, DURATIONS, REQUEST_STATUSES, requestThread,
  type AccessDelegation, type AccessDirectory, type AccessDuration, type AccessEvent, type AccessRequestPreview, type Person, type AccessPolicy, type AccessRequest,
  type AccessReview, type AccessReviewItem, type AccessTenant, type CatalogItem, type Decision, type DirectoryUser,
} from '../lib/access/types.js';
import { recordUserId } from '../lib/record-owner.js';
import { expiresAtFor, provisionAccess, revokeAccess, SodBlockedError } from '../lib/access-provision.js';
import { notifyAccessDelegation, notifyAccessRequest, type AccessNotifyKind } from '../lib/social-notify.js';
import {
  accessNow, casRequest, casReviewItem, closeReviewIfDecided, endDelegation, insertDelegation, insertRequest, insertReview, listCatalog, listDelegations, listEvents,
  listPolicies, listRequests, listReviewItems, listReviews, listSteps, loadDirectory, nextRequestId, saveTransition, updateCatalogItem, updatePolicy, withDirectoryUser,
  type AccessCatalogRow, type AccessDelegationRow, type AccessPolicyRow, type AccessRequestRow, type AccessReviewItemRow, type AccessReviewRow, type AccessStepRow,
} from '../providers/access.js';

export const accessRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

const MIN_JUSTIFICATION = 20;
/** An SoD override's reason (decision A7): long enough to say why the conflict is acceptable. */
const MIN_OVERRIDE_REASON = 20;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;

/** Refuse any body key outside `allowed` (docs/access-tenant-api.md: unknown keys are 400). */
export function bodyOf(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body = req.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new ValidationError('Body must be a JSON object');
  const b = (body ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ValidationError(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return b;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface Ctx { actor: AccessActor; dir: AccessDirectory; self: DirectoryUser | null }

export async function context(req: Request): Promise<Ctx> {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Sign in first');
  const principal = { sub: session.sub, tenant: session.tenant, role: session.role };
  const [listed, mayDecide, mayProvision, mayManagePolicy] = await Promise.all([
    loadDirectory(), isAllowed(principal, 'DecideAccess'), isAllowed(principal, 'ProvisionAccess'), isAllowed(principal, 'ManageAccessPolicy'),
  ]);
  // A clone acts as its persona for record ownership (lib/record-owner.ts): a
  // clone of Rhea reads and writes Rhea's requests, and a clone of Omar decides
  // as Omar — the directory holds Omar once, never "Omar Haddad, Omar Haddad".
  const actorId = recordUserId(session.sub);
  const dir = await withDirectoryUser(listed, actorId);
  const self = dir.users.find((u) => u.id === actorId) ?? null;
  return { dir, self, actor: { id: actorId, personId: self?.personId ?? null, role: session.role, mayDecide, mayProvision, mayManagePolicy } };
}

/** Does `who` hold the item now (a tenant role, or a contribution on the initiative)? */
function holdsItem(item: AccessCatalogRow, who: DirectoryUser | null, dir: AccessDirectory): boolean {
  if (!who) return false;
  if (item.kind === 'tenant-role' || item.kind === 'capability') return !!item.role && (who.grants[item.tenant] ?? []).includes(item.role);
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

/** The item a request acts on: its catalog row, or a revocation's role descriptor (lib/access/items.ts). */
const itemOf = (r: AccessRequestRow, w: World): AccessCatalogRow | undefined => requestItem(r, [...w.catalog.values()]);

/** The live SoD verdict for a grant request against the beneficiary's CURRENT grants (A7). */
function liveSod(r: AccessRequestRow, item: AccessCatalogRow, ctx: Ctx, w: World) {
  const beneficiary = ctx.dir.users.find((u) => u.id === r.beneficiaryId) ?? null;
  const conflicts = r.kind === 'revocation' ? [] : sodConflicts(item, beneficiary?.grants ?? {}, w.policies);
  return { conflicts, verdict: sodVerdict(conflicts) };
}

/** May the actor record an SoD override on this request now? */
const mayOverride = (r: AccessRequestRow, live: { verdict: string }, ctx: Ctx): boolean =>
  !!ctx.actor.mayManagePolicy && r.kind === 'grant' && !r.sodOverriddenBy && live.verdict === 'block'
  && !isParty(ctx.actor.id, r) && (isOpen(r.status) || r.status === 'approved');

function present(r: AccessRequestRow, ctx: Ctx, w: World): AccessRequest {
  const steps = w.steps.get(r.id) ?? [];
  const row = itemOf(r, w);
  const item = row ?? missingItem(r.itemId);
  const live = liveSod(r, item, ctx, w);
  const conflicts = live.conflicts;
  return {
    id: r.id,
    kind: r.kind,
    reviewId: r.reviewId,
    requester: personFor(ctx.dir, r.requesterId)!,
    beneficiary: personFor(ctx.dir, r.beneficiaryId)!,
    item: catalogItem(item, ctx, w.policies),
    justification: r.justification,
    duration: r.duration,
    status: r.status,
    steps: steps.map((s) => {
      const live = row && isOpen(r.status) && (s.status === 'current' || s.status === 'waiting' || s.status === 'info-requested')
        ? eligibility(s.kind, row, r, ctx.dir, s.escalationLevel) : null;
      return {
        step: s.step, kind: s.kind, status: s.status,
        decidedBy: personFor(ctx.dir, s.decidedBy), decidedAt: s.decidedAt, comment: s.comment,
        eligible: live?.people ?? [], escalated: live?.escalated ?? null,
        currentSince: s.currentSince, escalationLevel: s.escalationLevel, escalatedAt: s.escalatedAt,
        // A timer that would add nobody new (the access admins already decide this step) is no escalation to announce.
        escalatesAt: isOpen(r.status) && r.kind === 'grant' && (!row || nextEscalationLevel(s.kind, row, r, ctx.dir, s.escalationLevel) !== null) ? escalatesAt(s) : null,
        decidedOnBehalfOf: personFor(ctx.dir, s.delegatedFrom),
      };
    }),
    submittedAt: r.submittedAt,
    decidedAt: r.decidedAt, provisionedAt: r.provisionedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt,
    sod: {
      verdict: r.sodOverriddenBy ? r.sodVerdict : sodVerdict(conflicts), conflicts,
      overriddenBy: personFor(ctx.dir, r.sodOverriddenBy), overrideReason: r.sodOverrideReason,
    },
    can: {
      ...canFlags(ctx.actor, r, steps, row, ctx.dir),
      revoke: ctx.actor.mayProvision && r.kind === 'grant' && r.status === 'active',
      overrideSod: mayOverride(r, live, ctx),
    },
    thread: requestThread(r.id),
  };
}

const readable = (ctx: Ctx, w: World) => (r: AccessRequestRow) => mayRead(ctx.actor, r, w.steps.get(r.id) ?? [], itemOf(r, w), ctx.dir);

/** Requests whose current step the actor may decide now (never their own). */
function approvalsFor(ctx: Ctx, w: World, requests: readonly AccessRequestRow[]): AccessRequestRow[] {
  if (!ctx.actor.mayDecide) return [];
  return requests.filter((r) => {
    if (!isOpen(r.status) || isParty(ctx.actor.id, r)) return false;
    const cur = currentStep(w.steps.get(r.id) ?? []);
    const item = w.catalog.get(r.itemId);
    return !!cur && !!item && eligibleDeciders(cur.kind, item, r, ctx.dir, cur.escalationLevel).some((p) => p.id === ctx.actor.id);
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
  const approverIds = eligibleDeciders(cur.kind, row, r, ctx.dir, cur.escalationLevel).map((p) => p.id);
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
    activeElevations: visible.filter((r) => r.kind === 'grant' && ELEVATED_STATUSES.has(r.status)).length,
    policies: w.policies.length,
    // Open review campaigns (lane A2), counted from the rows.
    reviews: listReviews().filter((v) => v.status === 'open').length,
  });
}));

accessRouter.get('/catalog', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const policies = listPolicies();
  const kind = str(req.query['kind']);
  const tenant = str(req.query['tenant']);
  const q = str(req.query['q'])?.toLowerCase();
  if (kind && !(ACCESS_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`Unknown kind: ${kind}`);
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
  // The audit follows the request read rule (GET /requests/:id): an access
  // admin (or the cross-tenant admin) reads every event; everyone else the
  // events of requests they may read now — their own, their reports', the ones
  // they decided or may decide. An approver no longer sees a row whose request
  // would answer "not found".
  const w = world();
  const everything = ctx.actor.role === 'access-admin' || ctx.actor.role === 'admin';
  const visible = new Set(listRequests().filter((r) => everything || readable(ctx, w)(r)).map((r) => r.id));
  // Policy events (no request) are read by DecideAccess holders, who weigh SoD.
  // Delegation events are read by the delegator, the delegate and the access
  // admins (and `admin`), like the delegation itself (GET /delegations).
  const delegations = new Map(listDelegations().map((d) => [d.id, d]));
  const seen = (e: { requestId: string | null; delegationId: string | null }) => {
    if (e.delegationId !== null) {
      const d = delegations.get(e.delegationId);
      return everything || (!!d && (d.delegatorId === ctx.actor.id || d.delegateId === ctx.actor.id));
    }
    return e.requestId === null ? ctx.actor.mayDecide : visible.has(e.requestId);
  };
  // What an event is about, in words (the page never prints a request, policy or delegation id).
  const requestRows = new Map(listRequests().map((r) => [r.id, r]));
  const policyTitles = new Map(w.policies.map((p) => [p.id, p.title]));
  const subjectOf = (e: { requestId: string | null; policyId: string | null; delegationId: string | null }): string | null => {
    if (e.requestId) {
      const r = requestRows.get(e.requestId);
      return r ? `${(itemOf(r, w) ?? missingItem(r.itemId)).title} · ${personFor(ctx.dir, r.beneficiaryId)?.displayName ?? r.beneficiaryId}` : null;
    }
    if (e.policyId) return policyTitles.get(e.policyId) ?? null;
    const d = e.delegationId ? delegations.get(e.delegationId) : null;
    return d ? `Delegation · ${personFor(ctx.dir, d.delegatorId)?.displayName ?? d.delegatorId} to ${personFor(ctx.dir, d.delegateId)?.displayName ?? d.delegateId}` : null;
  };
  const all = listEvents().filter((e) => seen(e) && (!requestId || e.requestId === requestId));
  // The decision that completes a chain writes `step-approved` and `approved` at one instant; the trail shows the pair as one line.
  const collapsed = all.filter((e) => !(e.kind === 'approved' && all.some((o) => o !== e && o.kind === 'step-approved' && o.requestId === e.requestId && o.at === e.at && o.afterStatus === e.afterStatus)));
  const items: AccessEvent[] = collapsed
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .map((e) => ({ id: e.id, at: e.at, requestId: e.requestId, policyId: e.policyId, delegationId: e.delegationId, actor: personFor(ctx.dir, e.actorId), kind: e.kind, before: e.beforeStatus, after: e.afterStatus, reason: e.reason, subject: subjectOf(e) }))
    .filter((e) => !q || [e.requestId ?? '', e.policyId ?? '', e.delegationId ?? '', e.subject ?? '', e.kind, e.reason ?? '', e.actor?.displayName ?? ''].some((s) => s.toLowerCase().includes(q)));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

// ─── access reviews (lane A2, decision A10) ─────────────────────────────────
//
// A campaign certifies the standing grants of one tenant: one item per
// (user, role) the directory held there when it opened. Its owner (the access
// admin who opened it) or any access admin decides each item keep / revoke;
// nobody certifies their own access (A5). Everyone with ViewAccess sees the
// campaigns; the items — who holds what — are read in full by DecideAccess and
// otherwise only one's own.

/** Owner or access admin: who decides a campaign's items. */
const reviewsFor = (ctx: Ctx, review: AccessReviewRow): boolean =>
  ctx.actor.mayDecide && (review.openedBy === ctx.actor.id || ctx.actor.role === 'access-admin' || ctx.actor.role === 'admin');

const itemVisible = (ctx: Ctx) => (i: AccessReviewItemRow): boolean => ctx.actor.mayDecide || i.userId === ctx.actor.id;

function presentReview(v: AccessReviewRow, items: readonly AccessReviewItemRow[], ctx: Ctx): AccessReview {
  return {
    id: v.id, tenant: v.tenant, title: v.title, status: v.status, owner: personFor(ctx.dir, v.openedBy),
    openedAt: v.openedAt, closesAt: v.closesAt, closedAt: v.closedAt,
    // The campaign's own totals, for every reader: a requester sees how far the review is, not "0 of 0 decided".
    // Who holds what stays behind itemVisible() on the items themselves.
    progress: {
      total: items.length,
      decided: items.filter((i) => i.decision !== null).length,
      kept: items.filter((i) => i.decision === 'keep').length,
      revoked: items.filter((i) => i.decision === 'revoke').length,
    },
    can: { decide: v.status === 'open' && reviewsFor(ctx, v) },
  };
}

function presentReviewItem(i: AccessReviewItemRow, v: AccessReviewRow, ctx: Ctx): AccessReviewItem {
  return {
    id: i.id, reviewId: i.reviewId, user: personFor(ctx.dir, i.userId)!, tenant: i.tenant, role: i.role,
    decision: i.decision, decidedBy: personFor(ctx.dir, i.decidedBy), decidedAt: i.decidedAt, comment: i.comment,
    revocationRequestId: i.revocationRequestId,
    can: { decide: v.status === 'open' && i.decision === null && i.userId !== ctx.actor.id && reviewsFor(ctx, v) },
  };
}

const byUserThenRole = (ctx: Ctx) => (a: AccessReviewItemRow, b: AccessReviewItemRow): number =>
  (personFor(ctx.dir, a.userId)?.displayName ?? a.userId).localeCompare(personFor(ctx.dir, b.userId)?.displayName ?? b.userId) || a.role.localeCompare(b.role);

function loadReview(id: string): AccessReviewRow {
  const v = listReviews().find((x) => x.id === id);
  if (!v) throw new NotFoundError(`No review ${id}`);
  return v;
}

accessRouter.get('/reviews', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const items = listReviewItems();
  const reviews = listReviews()
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .map((v) => presentReview(v, items.filter((i) => i.reviewId === v.id), ctx));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: reviews });
}));

accessRouter.get('/reviews/:id', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const v = loadReview(String(req.params['id']));
  const items = listReviewItems(v.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    review: presentReview(v, items, ctx),
    items: items.filter(itemVisible(ctx)).sort(byUserThenRole(ctx)).map((i) => presentReviewItem(i, v, ctx)),
  });
}));

accessRouter.post('/reviews', requireAction('ManageAccessPolicy'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['tenant', 'title']);
  const tenant = str(b['tenant']);
  if (!tenant || !(ACCESS_TENANTS as readonly string[]).includes(tenant)) throw new ValidationError(`tenant must be one of ${ACCESS_TENANTS.join(', ')}`);
  const title = str(b['title']);
  if (!title || title.length < 3) throw new ValidationError('title must be at least 3 characters');
  if (title.length > MAX_TITLE) throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
  const ctx = await context(req);
  // The directory's standing grants in that tenant, now: one item per (user, role).
  // The cross-tenant `admin` is provisioned by hand (design "Not decided here"), so it is not reviewed here.
  const grants = ctx.dir.users.flatMap((u) => (u.grants[tenant] ?? []).filter((role) => role !== 'admin').map((role) => ({ userId: u.id, role })));
  if (grants.length === 0) {
    res.status(409).json({ error: `Nobody holds a standing grant in ${tenant}; there is nothing to review` });
    return;
  }
  const now = accessNow();
  const made = insertReview(
    { tenant: tenant as AccessTenant, title, status: 'open', openedBy: ctx.actor.id, openedAt: now, closesAt: null, closedAt: null },
    grants.map((g) => ({ userId: g.userId, tenant: tenant as AccessTenant, role: g.role, decision: null, decidedBy: null, decidedAt: null, comment: null, revocationRequestId: null })),
  );
  res.status(201).json({
    review: presentReview(made.review, made.items, ctx),
    items: made.items.sort(byUserThenRole(ctx)).map((i) => presentReviewItem(i, made.review, ctx)),
  });
}));

/**
 * A review's `revoke`: a pre-approved revocation request (kind `revocation`,
 * the reviewer as requester and sole approver) for the (user, role), revoked
 * through revokeAccess with the reviewer as actor. If the grant came from an
 * active grant request, that request is revoked too, so each record says what
 * happened to it.
 */
async function revokeByReview(v: AccessReviewRow, i: AccessReviewItemRow, comment: string, ctx: Ctx): Promise<string> {
  const now = accessNow();
  const reason = `Access review ${v.id} (${v.title}): ${comment}`;
  const id = nextRequestId();
  const itemId = grantItemId(i.tenant, i.role, listCatalog());
  insertRequest({
    id, kind: 'revocation', reviewId: v.id, requesterId: ctx.actor.id, beneficiaryId: i.userId, itemId,
    justification: reason, duration: 'standing', status: 'active', sodVerdict: 'clear', sodOverriddenBy: null, sodOverrideReason: null,
    submittedAt: now, decidedAt: now, provisionedAt: null, expiresAt: null, revokedAt: null, expiryWarnedAt: null,
  }, [{ requestId: id, step: 1, kind: 'access-admin', status: 'approved', decidedBy: ctx.actor.id, decidedAt: now, comment, currentSince: now, escalationLevel: 0, escalatedAt: null, delegatedFrom: null }], [
    { kind: 'submitted', before: 'draft', after: 'submitted', reason },
    { kind: 'approved', before: 'submitted', after: 'active', reason: `Pre-approved by the reviewer of ${v.id}` },
  ], ctx.actor.id);
  await revokeAccess({ id }, reason, ctx.actor.id, { outcome: 'revoked' });
  const original = listRequests().find((r) => r.kind === 'grant' && r.beneficiaryId === i.userId && r.itemId === itemId && ELEVATED_STATUSES.has(r.status));
  if (original) await revokeAccess(original, `${reason} (revocation ${id})`, ctx.actor.id, { outcome: 'revoked' });
  return id;
}

accessRouter.post('/reviews/:id/items/:itemId/decide', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['decision', 'comment']);
  const decision = b['decision'];
  if (decision !== 'keep' && decision !== 'revoke') throw new ValidationError('decision must be keep or revoke');
  if (b['comment'] !== undefined && b['comment'] !== null && typeof b['comment'] !== 'string') throw new ValidationError('comment must be a string');
  const comment = str(b['comment']) ?? null;
  if (comment && comment.length > MAX_TEXT) throw new ValidationError(`comment must be at most ${MAX_TEXT} characters`);
  if (decision === 'revoke' && !comment) throw new ValidationError('A revoke needs a comment: it is the revocation\'s reason');

  const ctx = await context(req);
  const v = loadReview(String(req.params['id']));
  const i = listReviewItems(v.id).find((x) => x.id === req.params['itemId']);
  if (!i || !itemVisible(ctx)(i)) throw new NotFoundError(`No item ${String(req.params['itemId'])} in ${v.id}`);
  if (!reviewsFor(ctx, v)) { res.status(403).json({ error: `Only the owner of ${v.id} or an access admin decides its items` }); return; }
  if (i.userId === ctx.actor.id) { res.status(403).json({ error: 'You cannot certify your own access' }); return; }
  if (v.status !== 'open') { res.status(409).json({ error: `${v.id} is closed` }); return; }

  const now = accessNow();
  // Claim the item first, so a second reviewer's decision is the 409, not a second revocation.
  const claimed = casReviewItem(i.id, { decided: null }, { decision, decidedBy: ctx.actor.id, decidedAt: now, comment });
  if (!claimed) { res.status(409).json({ error: `${i.id} was already decided` }); return; }
  if (decision === 'revoke') {
    try {
      const revocationId = await revokeByReview(v, claimed, comment!, ctx);
      casReviewItem(i.id, { decided: 'revoke' }, { revocationRequestId: revocationId });
    } catch (err) {
      // The grant was not removed: hand the item back undecided rather than claim a revocation that did not happen.
      casReviewItem(i.id, { decided: 'revoke' }, { decision: null, decidedBy: null, decidedAt: null, comment: null });
      throw err;
    }
  }
  const after = closeReviewIfDecided(v.id, now) ?? v;
  const items = listReviewItems(v.id);
  res.json({
    review: presentReview(after, items, ctx),
    item: presentReviewItem(items.find((x) => x.id === i.id)!, after, ctx),
  });
}));

// ─── writes ─────────────────────────────────────────────────────────────────

/** A submission's fields, validated (unknown keys are refused by the caller's bodyOf). */
export interface Submission { itemId: string; justification: string; duration: AccessDuration; beneficiaryId?: string }

/** Validate a submission body's values: 400 on a missing item, a short justification or a bad duration. */
export function parseSubmission(b: Record<string, unknown>): Submission {
  const itemId = str(b['itemId']);
  const justification = typeof b['justification'] === 'string' ? b['justification'].trim() : '';
  const duration = b['duration'];
  if (!itemId) throw new ValidationError('itemId is required');
  if (justification.length < MIN_JUSTIFICATION) throw new ValidationError(`justification must be at least ${MIN_JUSTIFICATION} characters`);
  if (justification.length > MAX_TEXT) throw new ValidationError(`justification must be at most ${MAX_TEXT} characters`);
  if (typeof duration !== 'string' || !(DURATIONS as readonly string[]).includes(duration)) throw new ValidationError(`duration must be one of ${DURATIONS.join(', ')}`);
  if (b['beneficiaryId'] !== undefined && typeof b['beneficiaryId'] !== 'string') throw new ValidationError('beneficiaryId must be a string');
  const beneficiaryId = str(b['beneficiaryId']);
  return { itemId, justification, duration: duration as AccessDuration, ...(beneficiaryId ? { beneficiaryId } : {}) };
}

/** The outcome of filing: 201 with the request, or a refusal with its status and body. */
export type FileOutcome = { status: 201; body: AccessRequest } | { status: 400 | 403 | 409; body: Record<string, unknown> };

/** What filing would meet, before anything is written: the item, the beneficiary, the chain kinds, the SoD verdict and the first refusal. */
export type Assessment =
  | { refusal: { status: 400 | 403 | 409; body: Record<string, unknown> }; item?: AccessCatalogRow; beneficiary?: DirectoryUser; conflicts?: undefined; verdict?: undefined; kinds?: undefined }
  | { refusal: null; item: AccessCatalogRow; beneficiary: DirectoryUser; conflicts: ReturnType<typeof sodConflicts>; verdict: ReturnType<typeof sodVerdict>; kinds: ReturnType<typeof planChain> };

/**
 * The pre-write checks of `fileRequest`, in its order: unknown item 400,
 * unknown beneficiary 400, on-behalf 403s, already held 409, a duplicate open
 * request 409 `{ error, requestId }`, a blocking SoD conflict 409
 * `{ error, sod }`. Writes nothing; `POST /requests/preview` reads it too, so
 * the page's preview and the submit cannot disagree.
 */
export function assessSubmission(ctx: Ctx, sub: Pick<Submission, 'itemId' | 'beneficiaryId'>): Assessment {
  const item = listCatalog().find((i) => i.id === sub.itemId);
  if (!item) return { refusal: { status: 400, body: { error: `Unknown catalog item: ${sub.itemId}` } } };
  const beneficiaryId = sub.beneficiaryId ?? ctx.actor.id;
  const beneficiary = ctx.dir.users.find((u) => u.id === beneficiaryId) ?? null;
  if (!beneficiary) return { refusal: { status: 400, body: { error: `Unknown beneficiary: ${beneficiaryId}` } }, item };
  if (beneficiaryId !== ctx.actor.id) {
    if (!ctx.actor.mayDecide) return { refusal: { status: 403, body: { error: 'Requesting on behalf of someone else needs DecideAccess', action: 'DecideAccess' } }, item, beneficiary };
    // An approver files for a report; an access-admin for anyone.
    if (!ctx.actor.mayProvision && !managesBeneficiary(ctx.actor, { beneficiaryId }, ctx.dir)) {
      return { refusal: { status: 403, body: { error: `${beneficiary.displayName} is not one of your reports` } }, item, beneficiary };
    }
  }
  if (holdsItem(item, beneficiary, ctx.dir)) return { refusal: { status: 409, body: { error: `${beneficiary.displayName} already holds ${item.title}` } }, item, beneficiary };
  const duplicate = listRequests().find((r) => r.beneficiaryId === beneficiaryId && r.itemId === item.id && isOpen(r.status));
  if (duplicate) return { refusal: { status: 409, body: { error: `${duplicate.id} already asks for ${item.title} and is still open`, requestId: duplicate.id } }, item, beneficiary };
  const conflicts = sodConflicts(item, beneficiary.grants, listPolicies());
  const verdict = sodVerdict(conflicts);
  if (verdict === 'block') return { refusal: { status: 409, body: { error: `Separation of duties blocks ${item.title} for ${beneficiary.displayName}`, sod: { verdict, conflicts } } }, item, beneficiary };
  return { refusal: null, item, beneficiary, conflicts, verdict, kinds: planChain(item, beneficiary, ctx.dir) };
}

/**
 * File one request: the ONE submit path. `POST /api/access/requests` and the
 * in-tenant quick request (routes/access-requests-quick.ts) both come here, so
 * both compute the same chain (planChain), run the same SoD pre-check, refuse
 * the same duplicates and held items, write the same rows and events and ring
 * the same approvers. It submits; it never decides or provisions.
 */
export async function fileRequest(ctx: Ctx, sub: Submission): Promise<FileOutcome> {
  const a = assessSubmission(ctx, sub);
  if (a.refusal) return a.refusal;
  const { item, beneficiary, verdict } = a;
  const beneficiaryId = beneficiary.id;
  const now = accessNow();
  const t = submitRows({
    id: nextRequestId(), requesterId: ctx.actor.id, beneficiaryId, itemId: item.id, justification: sub.justification,
    duration: sub.duration, sodVerdict: verdict, sodOverriddenBy: null, sodOverrideReason: null, submittedAt: now,
  }, a.kinds);
  insertRequest(t.request, t.steps, t.events, ctx.actor.id);
  await bellApprovers('submitted', t.request, ctx);
  return { status: 201, body: present(t.request, ctx, world()) };
}

/** The actor's own requests (requester or beneficiary) for `itemId`, newest first — the quick request's status read. */
export function ownRequestsFor(ctx: Ctx, itemId: string): AccessRequest[] {
  const w = world();
  return listRequests()
    .filter((r) => r.itemId === itemId && isParty(ctx.actor.id, r))
    .sort(newestFirst)
    .map((r) => present(r, ctx, w));
}

// The request page's summary (docs/access-tenant-api.md "Request page"): the
// chain, the SoD verdict against the beneficiary and the expiry the submit
// would produce, through the submit's own checks (`assessSubmission`), with
// nothing written. Filing for someone the actor may not file for is the
// submit's 403; the other refusals ride in `refusal` so the page can show
// them inline before the person submits.
accessRouter.post('/requests/preview', requireAction('RequestAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['itemId', 'beneficiaryId', 'duration']);
  const itemId = str(b['itemId']);
  if (!itemId) throw new ValidationError('itemId is required');
  if (b['beneficiaryId'] !== undefined && typeof b['beneficiaryId'] !== 'string') throw new ValidationError('beneficiaryId must be a string');
  const duration = b['duration'];
  if (duration !== undefined && (typeof duration !== 'string' || !(DURATIONS as readonly string[]).includes(duration))) {
    throw new ValidationError(`duration must be one of ${DURATIONS.join(', ')}`);
  }
  const beneficiaryId = str(b['beneficiaryId']);
  const ctx = await context(req);
  const a = assessSubmission(ctx, { itemId, ...(beneficiaryId ? { beneficiaryId } : {}) });
  if (a.refusal?.status === 400) throw new ValidationError(String(a.refusal.body['error']));
  if (a.refusal?.status === 403) { res.status(403).json(a.refusal.body); return; }
  const item = a.item!;
  const beneficiary = a.beneficiary!;
  const conflicts = a.conflicts ?? sodConflicts(item, beneficiary.grants, listPolicies());
  const chosen = (duration as AccessDuration | undefined) ?? item.defaultDuration;
  const parties = { requesterId: ctx.actor.id, beneficiaryId: beneficiary.id };
  const body: AccessRequestPreview = {
    item: catalogItem(item, ctx, listPolicies()),
    beneficiary: personFor(ctx.dir, beneficiary.id)!,
    steps: planChain(item, beneficiary, ctx.dir).map((kind, i) => {
      const e = eligibility(kind, item, parties, ctx.dir);
      return { step: i + 1, kind, eligible: e.people, escalated: e.escalated };
    }),
    sod: { verdict: sodVerdict(conflicts), conflicts },
    duration: chosen,
    expiresIfProvisionedNow: expiresAtFor(chosen, accessNow()),
    refusal: a.refusal ? {
      status: a.refusal.status, error: String(a.refusal.body['error']),
      ...(typeof a.refusal.body['requestId'] === 'string' ? { requestId: a.refusal.body['requestId'] } : {}),
    } : null,
  };
  res.json(body);
}));

// Whom the actor may file for (the request page's "Who", the library's
// PersonPicker): self first; an approver (DecideAccess) adds their direct
// reports through people.manager_id; an access admin (DecideAccess +
// ProvisionAccess) adds every person in the directory — granted or not, since
// a first grant is exactly what someone with none may need. The submit
// enforces the same rule (`assessSubmission`).
accessRouter.get('/beneficiaries', requireAction('RequestAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const self = personFor(ctx.dir, ctx.actor.id)!;
  let others: DirectoryUser[] = [];
  if (ctx.actor.mayDecide && ctx.actor.mayProvision) {
    others = [...ctx.dir.users];
  } else if (ctx.actor.mayDecide && ctx.actor.personId) {
    others = ctx.dir.users.filter((u) => !!u.personId && ctx.dir.managerOf(u.personId) === ctx.actor.personId);
  }
  const rest: Person[] = others.filter((u) => u.id !== ctx.actor.id)
    .map((u) => personFor(ctx.dir, u.id)!)
    .sort((x, y) => x.displayName.localeCompare(y.displayName));
  res.json({ items: [self, ...rest] });
}));

accessRouter.post('/requests', requireAction('RequestAccess'), asyncHandler(async (req, res) => {
  const sub = parseSubmission(bodyOf(req, ['itemId', 'justification', 'duration', 'beneficiaryId']));
  const out = await fileRequest(await context(req), sub);
  if (out.status === 400) throw new ValidationError(String(out.body['error']));
  res.status(out.status).json(out.body);
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
  // A delegate decides for their delegator: the step and the event say so.
  const decidedStep = steps.find((s) => s.step === stepNo);
  const onBehalfOf = decidedStep ? decidingOnBehalfOf(ctx.actor.id, decidedStep.kind, item, r, ctx.dir, decidedStep.escalationLevel) : null;
  let after: AccessRequestRow;
  try {
    const t = decide(r, steps, stepNo, decision as Decision, ctx.actor.id, comment, now, onBehalfOf?.id ?? null);
    const events = onBehalfOf
      ? t.events.map((e, i) => (i === 0 ? { ...e, reason: `${e.reason ? `${e.reason} — ` : ''}decided on behalf of ${onBehalfOf.displayName}` } : e))
      : t.events;
    saveTransition(t.request, t.steps, events, ctx.actor.id, now);
    after = t.request;
  } catch (err) {
    if (err instanceof TransitionError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  if (after.status === 'approved') {
    // The last approval provisions (A1). A failed grant write leaves the
    // request `approved` (honest: decided, not in effect) and tells the parties;
    // an SoD block found now (A2) has already said so itself.
    await provisionAfterDecision(after, ctx, stepNo);
  } else if (decision === 'approve') {
    await bell('approved-step', after, ctx, { step: stepNo, comment });
    await bellApprovers('awaiting', after, ctx);
  } else {
    await bell(decision === 'reject' ? 'rejected' : 'info-requested', after, ctx, { step: stepNo, comment });
  }
  res.json(present(loadRequest(r.id), ctx, world()));
}));

/** Provision an approved request; a failure leaves it `approved` and rings the parties (an SoD block rings itself). */
async function provisionAfterDecision(r: AccessRequestRow, ctx: Ctx, stepNo: number | null): Promise<void> {
  try {
    await provisionAccess(r);
  } catch (err) {
    if (err instanceof SodBlockedError) return;
    console.warn(`[access] provisioning ${r.id} failed: ${(err as Error).message}`);
    await bell('provision-failed', r, ctx, { step: stepNo });
  }
}

accessRouter.post('/requests/:id/sod-override', requireAction('ManageAccessPolicy'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['reason']);
  if (b['reason'] !== undefined && typeof b['reason'] !== 'string') throw new ValidationError('reason must be a string');
  const reason = str(b['reason']) ?? '';
  if (reason.length < MIN_OVERRIDE_REASON) throw new ValidationError(`reason must be at least ${MIN_OVERRIDE_REASON} characters`);
  if (reason.length > MAX_TEXT) throw new ValidationError(`reason must be at most ${MAX_TEXT} characters`);
  const ctx = await context(req);
  const w = world();
  const r = listRequests().find((x) => x.id === req.params['id']);
  if (!r || !readable(ctx, w)(r)) throw new NotFoundError(`No request ${String(req.params['id'])}`);
  if (isParty(ctx.actor.id, r)) { res.status(403).json({ error: 'You cannot override a policy on a request you submitted or benefit from' }); return; }
  const item = itemOf(r, w);
  if (r.kind !== 'grant' || !item) { res.status(409).json({ error: `${r.id} grants nothing; there is no policy to override` }); return; }
  if (r.sodOverriddenBy) { res.status(409).json({ error: `${r.id} already carries an override` }); return; }
  if (!isOpen(r.status) && r.status !== 'approved') { res.status(409).json({ error: `${r.id} is ${r.status}; only an open or approved request takes an override` }); return; }
  const live = liveSod(r, item, ctx, w);
  if (live.verdict !== 'block') { res.status(409).json({ error: `No blocking separation-of-duties conflict applies to ${r.id} now`, sod: live }); return; }
  const now = accessNow();
  const stored = casRequest(r.id, { from: [r.status] }, { sodVerdict: 'block', sodOverriddenBy: ctx.actor.id, sodOverrideReason: reason },
    [{ kind: 'sod-override', before: r.status, after: r.status, reason }], ctx.actor.id, now);
  if (!stored) { res.status(409).json({ error: `${r.id} changed while the override was recorded; reload it` }); return; }
  // An approved request was waiting on this: provision it now.
  if (stored.status === 'approved') await provisionAfterDecision(stored, ctx, null);
  res.json(present(loadRequest(r.id), ctx, world()));
}));

accessRouter.post('/requests/:id/revoke', requireAction('ProvisionAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['reason']);
  if (b['reason'] !== undefined && typeof b['reason'] !== 'string') throw new ValidationError('reason must be a string');
  const reason = str(b['reason']);
  if (!reason) throw new ValidationError('reason is required: the beneficiary is told why their access ended');
  if (reason.length > MAX_TEXT) throw new ValidationError(`reason must be at most ${MAX_TEXT} characters`);
  const ctx = await context(req);
  const w = world();
  const r = listRequests().find((x) => x.id === req.params['id']);
  if (!r || !readable(ctx, w)(r)) throw new NotFoundError(`No request ${String(req.params['id'])}`);
  if (r.kind !== 'grant' || r.status !== 'active') { res.status(409).json({ error: `${r.id} is ${r.kind === 'grant' ? r.status : 'a revocation'}; only an active grant can be revoked` }); return; }
  const out = await revokeAccess(r, reason, ctx.actor.id, { outcome: 'revoked' });
  if (!out.changed) { res.status(409).json({ error: `${r.id} is no longer active` }); return; }
  res.json(present(loadRequest(r.id), ctx, world()));
}));

// ─── delegation (2026-10-14, lib/access/delegation.ts) ──────────────────────
//
// An approver out of office hands their decisions to another approver for a
// window. The delegate's right is resolved live with every decider
// (lib/access/chain.ts): exactly the steps the delegator may decide now, never
// a request the delegate is a party to, never an access-admin step unless the
// delegate is an access admin, never passed on. Everyone in `access` reads the
// delegations they are part of; access admins (and `admin`) read all.

const isAdminRole = (ctx: Ctx): boolean => ctx.actor.role === 'access-admin' || ctx.actor.role === 'admin';

function presentDelegation(d: AccessDelegationRow, ctx: Ctx, now: string): AccessDelegation {
  const state = delegationState(d, now);
  return {
    id: d.id, delegator: personFor(ctx.dir, d.delegatorId)!, delegate: personFor(ctx.dir, d.delegateId)!,
    startsAt: d.startsAt, endsAt: d.endsAt, reason: d.reason, createdAt: d.createdAt,
    endedAt: d.endedAt, endedBy: personFor(ctx.dir, d.endedBy), state,
    can: { end: state !== 'ended' && ctx.actor.mayDecide && (d.delegatorId === ctx.actor.id || isAdminRole(ctx)) },
  };
}

accessRouter.get('/delegations', requireAction('ViewAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const now = accessNow();
  const items = listDelegations()
    .filter((d) => isAdminRole(ctx) || d.delegatorId === ctx.actor.id || d.delegateId === ctx.actor.id)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || b.id.localeCompare(a.id))
    .map((d) => presentDelegation(d, ctx, now));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

// Whom the actor may delegate to (the delegation form's person picker): every
// directory user holding a deciding role in Access, except the actor.
accessRouter.get('/delegates', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const ctx = await context(req);
  const items: Person[] = ctx.dir.users
    .filter((u) => u.id !== ctx.actor.id && (u.grants['access'] ?? []).some((r) => ACCESS_DECIDER_ROLES.has(r)))
    .map((u) => personFor(ctx.dir, u.id)!)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));

accessRouter.post('/delegations', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['delegateId', 'startsAt', 'endsAt', 'reason']);
  for (const k of ['delegateId', 'startsAt', 'endsAt', 'reason'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'string') throw new ValidationError(`${k} must be a string`);
  }
  const delegateId = str(b['delegateId']);
  const endsAt = str(b['endsAt']);
  const reason = str(b['reason']) ?? '';
  if (!delegateId) throw new ValidationError('delegateId is required');
  if (!endsAt) throw new ValidationError('endsAt is required');
  if (reason.length > MAX_TEXT) throw new ValidationError(`reason must be at most ${MAX_TEXT} characters`);
  const ctx = await context(req);
  const now = accessNow();
  const startsAt = str(b['startsAt']) ?? now;
  const w = world();
  // Open requests whose current step waits on the delegator now (the "no delegation to the requester" rule).
  const waiting = approvalsFor(ctx, w, listRequests()).map((r) => ({ id: r.id, requesterId: r.requesterId, beneficiaryId: r.beneficiaryId }));
  const refusal = delegationRefusal(ctx.actor.id, { delegateId, startsAt, endsAt, reason }, ctx.dir, listDelegations(), waiting, now);
  if (refusal?.status === 400) throw new ValidationError(refusal.error);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  const norm = (iso: string) => new Date(Date.parse(iso)).toISOString();
  const delegator = personFor(ctx.dir, ctx.actor.id)!;
  const delegate = personFor(ctx.dir, delegateId)!;
  const stored = insertDelegation(
    { delegatorId: ctx.actor.id, delegateId, startsAt: norm(startsAt), endsAt: norm(endsAt), reason, createdAt: now, endedAt: null, endedBy: null },
    `${delegator.displayName} → ${delegate.displayName}: ${reason}`,
  );
  await notifyAccessDelegation({ kind: 'delegated', delegationId: stored.id, delegatorId: stored.delegatorId, delegatorName: delegator.displayName, delegateId, endsAt: stored.endsAt, actorId: ctx.actor.id });
  res.status(201).json(presentDelegation(stored, ctx, now));
}));

accessRouter.post('/delegations/:id/end', requireAction('DecideAccess'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['reason']);
  if (b['reason'] !== undefined && typeof b['reason'] !== 'string') throw new ValidationError('reason must be a string');
  const reason = str(b['reason']) ?? 'Ended early';
  if (reason.length > MAX_TEXT) throw new ValidationError(`reason must be at most ${MAX_TEXT} characters`);
  const ctx = await context(req);
  const d = listDelegations().find((x) => x.id === req.params['id']);
  // Outside the read rule a delegation does not exist (no existence oracle).
  if (!d || !(isAdminRole(ctx) || d.delegatorId === ctx.actor.id || d.delegateId === ctx.actor.id)) throw new NotFoundError(`No delegation ${String(req.params['id'])}`);
  if (d.delegatorId !== ctx.actor.id && !isAdminRole(ctx)) { res.status(403).json({ error: 'Only the delegator or an access admin ends a delegation' }); return; }
  const now = accessNow();
  const ended = endDelegation(d.id, ctx.actor.id, reason, now);
  if (!ended) { res.status(409).json({ error: `${d.id} has already ended` }); return; }
  const delegator = personFor(ctx.dir, ended.delegatorId)!;
  await notifyAccessDelegation({ kind: 'delegation-ended', delegationId: ended.id, delegatorId: ended.delegatorId, delegatorName: delegator.displayName, delegateId: ended.delegateId, endsAt: ended.endsAt, actorId: ctx.actor.id });
  res.json(presentDelegation(ended, ctx, now));
}));

// ─── configuration (docs/access-tenant-design.md A4, A6; §6) ─────────────────
//
// What /access/configuration shows: the durations a request may ask for, who
// stewards each kind of item (resolved live at decision time, lib/access/chain.ts),
// and each catalog item's default duration and sensitive flag. Only the last
// two are stored settings (access_catalog_items.default_duration / .sensitive):
// PUT edits those and refuses the rest — the durations and steward rules are
// fixed by decisions A4 / A6 in code, not configuration.

function configurationBody() {
  return {
    durations: { offered: [...DURATIONS], standingReasonMin: MIN_JUSTIFICATION },
    stewards: [
      ...ACCESS_TENANTS.map((tenant) => ({ scope: 'tenant-role' as const, tenant, rule: 'tenant-steward' as const, role: TENANT_STEWARD_ROLE[tenant]! })),
      { scope: 'initiative-membership' as const, tenant: null, rule: 'initiative-owner' as const, role: null },
      { scope: 'capability' as const, tenant: BUDGET_OWNER_ROLE.tenant, rule: 'budget-owner' as const, role: BUDGET_OWNER_ROLE.role },
      { scope: 'sensitive' as const, tenant: 'access', rule: 'access-admin' as const, role: 'access-admin' },
    ],
    items: listCatalog().map((i) => ({ id: i.id, title: i.title, kind: i.kind, tenant: i.tenant, defaultDuration: i.defaultDuration, stewardRule: i.stewardRule, sensitive: i.sensitive })),
    // Fixed by deployment (ACCESS_ESCALATION_SLA_MS) and the design, shown read-only (2026-10-14).
    escalation: { stepSlaHours: Math.round((escalationSlaMs() / 3_600_000) * 100) / 100, tiers: ['access-admins', 'platform-admins'] as const },
    delegation: { maxDays: MAX_DELEGATION_DAYS },
  };
}

accessRouter.get('/configuration', requireAction('ViewAccess'), (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(configurationBody());
});

accessRouter.put('/configuration', requireAction('ManageAccessPolicy'), asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['durations', 'stewards', 'items', 'escalation', 'delegation']);
  if (b['durations'] !== undefined || b['stewards'] !== undefined || b['escalation'] !== undefined || b['delegation'] !== undefined) {
    throw new ValidationError('durations, stewards, escalation and delegation are fixed by the design and the deployment (decisions A4, A6; ACCESS_ESCALATION_SLA_MS); only items[].defaultDuration and items[].sensitive are editable');
  }
  if (!Array.isArray(b['items'])) throw new ValidationError('items must be an array of { id, defaultDuration?, sensitive? }');
  const catalog = new Map(listCatalog().map((i) => [i.id, i]));
  const patches: Array<{ id: string; defaultDuration?: AccessDuration; sensitive?: boolean }> = [];
  for (const raw of b['items'] as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('each item must be an object');
    const it = raw as Record<string, unknown>;
    const extra = Object.keys(it).filter((k) => !['id', 'defaultDuration', 'sensitive', 'title', 'kind', 'tenant', 'stewardRule'].includes(k));
    if (extra.length) throw new ValidationError(`Unknown item field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
    const id = str(it['id']);
    if (!id || !catalog.has(id)) throw new ValidationError(`Unknown catalog item: ${String(it['id'])}`);
    const row = catalog.get(id)!;
    // The descriptive fields may ride along (the GET shape echoed back) but never change here.
    for (const k of ['title', 'kind', 'tenant', 'stewardRule'] as const) {
      if (it[k] !== undefined && it[k] !== row[k]) throw new ValidationError(`${id}.${k} is not editable here`);
    }
    if (it['defaultDuration'] !== undefined && !(DURATIONS as readonly unknown[]).includes(it['defaultDuration'])) throw new ValidationError(`${id}.defaultDuration must be one of ${DURATIONS.join(', ')}`);
    if (it['sensitive'] !== undefined && typeof it['sensitive'] !== 'boolean') throw new ValidationError(`${id}.sensitive must be a boolean`);
    patches.push({ id, ...(it['defaultDuration'] !== undefined ? { defaultDuration: it['defaultDuration'] as AccessDuration } : {}), ...(it['sensitive'] !== undefined ? { sensitive: it['sensitive'] as boolean } : {}) });
  }
  for (const p of patches) updateCatalogItem(p.id, p);
  res.json(configurationBody());
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
