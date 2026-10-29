// The access tenant's store (docs/access-tenant-design.md §3) and the live
// directory its decisions are resolved against (decision A4).
//
// A0 runs on the mock: under MOCK_AURORA every read and write goes to the
// registered fixtures (mock/access-*.ts), so `POST /api/__mock/reset` undoes a
// write. The Aurora half waits for schema/access_schema.sql to be applied
// (lane E, a user decision): until then every call outside the mock answers
// 503 naming the gap, rather than a SQL error or an empty tenant that looks
// healthy.
//
// Reads hand back copies; writes go through the functions below only.

import { config } from '../config.js';
import { AppError } from '../lib/async-handler.js';
import { clock } from '../mock/core/index.js';
import { accessCatalogFixture, type AccessCatalogRow } from '../mock/access-catalog.js';
import { accessPoliciesFixture, type AccessPolicyRow } from '../mock/access-policies.js';
import { accessPeopleFixture } from '../mock/access-people.js';
import {
  accessEventsFixture, accessRequestsFixture, accessStepsFixture,
  type AccessEventRow, type AccessRequestRow, type AccessStepRow,
} from '../mock/access-requests.js';
import { accessReviewItemsFixture, accessReviewsFixture, type AccessReviewItemRow, type AccessReviewRow } from '../mock/access-reviews.js';
import { accessDelegationsFixture, type AccessDelegationRow } from '../mock/access-delegations.js';
import { delegationState } from '../lib/access/delegation.js';
import { envelopeItem, isEnvelopeItemId } from '../lib/access/items.js';
import { findInitiative, initiatives } from '../mock/initiatives.js';
import { getUser, listUsers } from './identity.js';
import { listBudgets, listGrants } from './budgets.js';
import type { AccessDirectory } from '../lib/access/types.js';
import { invalidateAll, invalidateChannel } from '../lib/gateway/authority-invalidation.js';
import { noteSearchWriteSoon } from '../lib/search-index/writes.js';
import { isOpen } from '../lib/access/status.js';

/** `access:req:<id>` (lib/access/thread.ts ACCESS_THREAD_PREFIX; not imported, that module imports this one). */
const ACCESS_THREAD = 'access:req:';

export type { AccessCatalogRow, AccessPolicyRow, AccessEventRow, AccessRequestRow, AccessStepRow, AccessReviewRow, AccessReviewItemRow, AccessDelegationRow };

export const ACCESS_STORE_UNAVAILABLE =
  'The access tenant\'s tables are not applied on this cluster (schema/access_schema.sql, docs/access-tenant-goal.md lane E); only dev:mock serves it today';

function store(): void {
  if (!config.mock.aurora) throw new AppError(503, ACCESS_STORE_UNAVAILABLE);
}

const copy = <T>(rows: readonly T[]): T[] => rows.map((r) => structuredClone(r));

/** The instant a write is stamped with (the mock clock under MOCK_AURORA). */
export function accessNow(): string {
  store();
  return clock.nowIso();
}

/**
 * The catalog: the seeded rows plus one DERIVED `envelope:<projectId>` row per
 * initiative (lib/access/items.ts) — a sprint envelope is requestable on every
 * initiative, so the item is a projection of the projects table, not a seed.
 * The fixture (and the parity harness) stay seed-only; the cluster half is
 * LIST_CATALOG_SQL in lib/access/sql.ts. A seeded row with an envelope id wins.
 */
export function listCatalog(): AccessCatalogRow[] {
  store();
  const seeded = copy(accessCatalogFixture.rows());
  const have = new Set(seeded.map((i) => i.id));
  const derived = initiatives.rows().map((p) => envelopeItem(p.id, p.name)).filter((i) => !have.has(i.id));
  return [...seeded, ...derived];
}

/** Is this catalog item derived from an initiative (never stored, never edited through PUT /configuration)? */
export const isDerivedCatalogItem = (id: string): boolean => isEnvelopeItemId(id) && !accessCatalogFixture.rows().some((i) => i.id === id);
export function listPolicies(): AccessPolicyRow[] { store(); return copy(accessPoliciesFixture.rows()); }
export function listRequests(): AccessRequestRow[] { store(); return copy(accessRequestsFixture.rows()); }
export function listSteps(requestId?: string): AccessStepRow[] {
  store();
  const rows = accessStepsFixture.rows();
  return copy(requestId ? rows.filter((s) => s.requestId === requestId) : rows);
}
export function listEvents(): AccessEventRow[] { store(); return copy(accessEventsFixture.rows()); }

// Search refs (lib/search-index/access.ts): the docs a write changes. A request's audit events change with it.
const sref = (type: string, id: string) => ({ tenant: 'access' as const, type, id });
const requestRefs = (id: string) => [sref('request', id), ...accessEventsFixture.rows().filter((e) => e.requestId === id).map((e) => sref('event', e.id))];
const openRequestRefs = () => accessRequestsFixture.rows().filter((r) => isOpen(r.status)).map((r) => sref('request', r.id));

const nextId = (prefix: string, ids: readonly string[]): string => {
  const n = ids.reduce((max, id) => {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    return m ? Math.max(max, parseInt(m[1]!, 10)) : max;
  }, 0);
  return `${prefix}-${String(n + 1).padStart(4, '0')}`;
};

export function nextRequestId(): string { store(); return nextId('req', accessRequestsFixture.rows().map((r) => r.id)); }

// ── access reviews (lane A2) ────────────────────────────────────────────────

export function listReviews(): AccessReviewRow[] { store(); return copy(accessReviewsFixture.rows()); }
export function listReviewItems(reviewId?: string): AccessReviewItemRow[] {
  store();
  const rows = accessReviewItemsFixture.rows();
  return copy(reviewId ? rows.filter((i) => i.reviewId === reviewId) : rows);
}

/** Insert a new campaign and its items (ids are assigned here), in one go. */
export function insertReview(
  review: Omit<AccessReviewRow, 'id'>,
  items: ReadonlyArray<Omit<AccessReviewItemRow, 'id' | 'reviewId'>>,
): { review: AccessReviewRow; items: AccessReviewItemRow[] } {
  store();
  const id = nextId('rev', accessReviewsFixture.rows().map((r) => r.id));
  const stored: AccessReviewRow = { ...structuredClone(review), id };
  accessReviewsFixture.rows().push(stored);
  const all = accessReviewItemsFixture.rows();
  const out: AccessReviewItemRow[] = [];
  for (const i of items) {
    const row: AccessReviewItemRow = { ...structuredClone(i), id: nextId('ri', all.map((r) => r.id)), reviewId: id };
    all.push(row);
    out.push(structuredClone(row));
  }
  noteSearchWriteSoon(sref('review', id), ...out.map((i) => sref('review-item', i.id)));
  return { review: structuredClone(stored), items: out };
}

/**
 * Compare-and-set one review item: apply `patch` only while the stored item is
 * still undecided (or, with `decided`, still carries that decision — the
 * roll-back of a revocation that failed). Returns the stored row, or null when
 * someone decided it first. On the cluster: `UPDATE access_review_items … WHERE
 * id = :id AND decision IS NULL RETURNING *` (lane E).
 */
export function casReviewItem(id: string, when: { decided: AccessReviewItemRow['decision'] }, patch: Partial<Omit<AccessReviewItemRow, 'id' | 'reviewId'>>): AccessReviewItemRow | null {
  store();
  const row = accessReviewItemsFixture.rows().find((i) => i.id === id);
  if (!row || row.decision !== when.decided) return null;
  Object.assign(row, structuredClone(patch));
  noteSearchWriteSoon(sref('review-item', row.id), sref('review', row.reviewId));
  return structuredClone(row);
}

/** Close an open campaign once every item carries a decision; returns the stored row. */
export function closeReviewIfDecided(id: string, at: string): AccessReviewRow | null {
  store();
  const row = accessReviewsFixture.rows().find((r) => r.id === id);
  if (!row) return null;
  const items = accessReviewItemsFixture.rows().filter((i) => i.reviewId === id);
  if (row.status === 'open' && items.every((i) => i.decision !== null)) {
    row.status = 'closed';
    row.closedAt = at;
  }
  noteSearchWriteSoon(sref('review', id));
  return structuredClone(row);
}

type EventDraft = { kind: AccessEventRow['kind']; before: string | null; after: string | null; reason: string | null };

function appendEvents(requestId: string, actorId: string | null, events: readonly EventDraft[], at: string): void {
  const rows = accessEventsFixture.rows();
  for (const e of events) {
    rows.push({ id: nextId('evt', rows.map((r) => r.id)), requestId, policyId: null, delegationId: null, at, actorId, kind: e.kind, beforeStatus: e.before, afterStatus: e.after, reason: e.reason });
  }
}

/**
 * Compare-and-set one step row: apply `patch` only while the stored step is
 * still in one of `when.status` at `when.escalationLevel`, and append `events`
 * to its request in the same step. Returns the stored row, or null when the
 * condition no longer holds (decided meanwhile, or another sweep escalated it
 * first). The escalation timer's claim (lib/access-escalation.ts); on the
 * cluster `ESCALATE_STEP_SQL` in lib/access/sql.ts.
 */
export function casStep(
  requestId: string, step: number,
  when: { status: readonly AccessStepRow['status'][]; escalationLevel: number },
  patch: Partial<Pick<AccessStepRow, 'escalationLevel' | 'escalatedAt'>>,
  events: readonly EventDraft[], actorId: string | null, at: string,
): AccessStepRow | null {
  store();
  const row = accessStepsFixture.rows().find((s) => s.requestId === requestId && s.step === step);
  if (!row || !when.status.includes(row.status) || row.escalationLevel !== when.escalationLevel) return null;
  const request = accessRequestsFixture.rows().find((r) => r.id === requestId);
  if (!request || !['draft', 'submitted', 'pending'].includes(request.status)) return null;
  Object.assign(row, structuredClone(patch));
  appendEvents(requestId, actorId, events, at);
  // An escalation changes who may decide the step, i.e. who reads the thread.
  invalidateChannel(`${ACCESS_THREAD}${requestId}`, 'access-step');
  noteSearchWriteSoon(...requestRefs(requestId));
  return structuredClone(row);
}

// ── delegations (2026-10-14) ────────────────────────────────────────────────

export function listDelegations(): AccessDelegationRow[] { store(); return copy(accessDelegationsFixture.rows()); }

function appendDelegationEvent(delegationId: string, actorId: string, kind: 'delegated' | 'delegation-ended', reason: string, at: string): void {
  const rows = accessEventsFixture.rows();
  rows.push({ id: nextId('evt', rows.map((r) => r.id)), requestId: null, policyId: null, delegationId, at, actorId, kind, beforeStatus: null, afterStatus: null, reason });
}

/** Insert a delegation (its id assigned here) and its `delegated` event, in one go. */
export function insertDelegation(row: Omit<AccessDelegationRow, 'id'>, reason: string): AccessDelegationRow {
  store();
  const rows = accessDelegationsFixture.rows();
  const stored: AccessDelegationRow = { ...structuredClone(row), id: nextId('dlg', rows.map((r) => r.id)) };
  rows.push(stored);
  appendDelegationEvent(stored.id, stored.delegatorId, 'delegated', reason, stored.createdAt);
  // A delegation moves eligibility across every open request it touches.
  invalidateAll('access-delegation');
  noteSearchWriteSoon(sref('delegation', stored.id), ...accessEventsFixture.rows().filter((e) => e.delegationId === stored.id).map((e) => sref('event', e.id)), ...openRequestRefs());
  return structuredClone(stored);
}

/** End a delegation early: only while it has not ended (endedAt null and the window still open). Returns the stored row or null. */
export function endDelegation(id: string, actorId: string, reason: string, at: string): AccessDelegationRow | null {
  store();
  const row = accessDelegationsFixture.rows().find((d) => d.id === id);
  if (!row || delegationState(row, at) === 'ended') return null;
  row.endedAt = at;
  row.endedBy = actorId;
  appendDelegationEvent(row.id, actorId, 'delegation-ended', reason, at);
  invalidateAll('access-delegation');
  noteSearchWriteSoon(sref('delegation', row.id), ...accessEventsFixture.rows().filter((e) => e.delegationId === row.id).map((e) => sref('event', e.id)), ...openRequestRefs());
  return structuredClone(row);
}

/** Insert a submitted request with its steps and events, in one go. */
export function insertRequest(request: AccessRequestRow, steps: readonly AccessStepRow[], events: readonly EventDraft[], actorId: string): void {
  store();
  accessRequestsFixture.rows().push(structuredClone(request));
  accessStepsFixture.rows().push(...steps.map((s) => structuredClone(s)));
  appendEvents(request.id, actorId, events, request.submittedAt);
  invalidateChannel(`${ACCESS_THREAD}${request.id}`, 'access-request');
  noteSearchWriteSoon(...requestRefs(request.id));
}

/** Replace a request and its steps with a transition's result, and append its events. */
export function saveTransition(request: AccessRequestRow, steps: readonly AccessStepRow[], events: readonly EventDraft[], actorId: string | null, at: string): void {
  store();
  const requests = accessRequestsFixture.rows();
  const i = requests.findIndex((r) => r.id === request.id);
  if (i < 0) throw new AppError(404, `No request ${request.id}`);
  requests[i] = structuredClone(request);
  const all = accessStepsFixture.rows();
  for (const s of steps) {
    const j = all.findIndex((x) => x.requestId === s.requestId && x.step === s.step);
    if (j >= 0) all[j] = structuredClone(s);
  }
  appendEvents(request.id, actorId, events, at);
  // A decision, withdrawal or close can end someone's read of the thread.
  invalidateChannel(`${ACCESS_THREAD}${request.id}`, 'access-request');
  noteSearchWriteSoon(...requestRefs(request.id));
}

/** One request row by id (a copy), or null. */
export function findRequest(id: string): AccessRequestRow | null {
  store();
  const row = accessRequestsFixture.rows().find((r) => r.id === id);
  return row ? structuredClone(row) : null;
}

/**
 * Compare-and-set one request row: apply `patch` only while the stored row is
 * in one of `from` (and, with `warnedAtNull`, has not been warned yet), and
 * append `events` in the same step. Returns the stored row, or null when the
 * condition no longer holds — someone else moved it first. This is the claim
 * provisioning, revocation and the expiry warning each take, so a second
 * caller (another replica's sweep, a racing decision) does nothing twice.
 * On the cluster it is one `UPDATE … WHERE id = :id AND status = ANY(:from)
 * [AND expiry_warned_at IS NULL] RETURNING *` plus the event INSERTs in one
 * transaction (lane E); offline the check and the write share one tick.
 */
export function casRequest(
  id: string,
  when: { from: readonly AccessRequestRow['status'][]; warnedAtNull?: boolean },
  patch: Partial<Omit<AccessRequestRow, 'id'>>,
  events: readonly EventDraft[],
  actorId: string | null,
  at: string,
): AccessRequestRow | null {
  store();
  const row = accessRequestsFixture.rows().find((r) => r.id === id);
  if (!row || !when.from.includes(row.status)) return null;
  if (when.warnedAtNull && row.expiryWarnedAt !== null) return null;
  Object.assign(row, structuredClone(patch));
  appendEvents(id, actorId, events, at);
  invalidateChannel(`${ACCESS_THREAD}${id}`, 'access-request');
  noteSearchWriteSoon(...requestRefs(id));
  return structuredClone(row);
}

/** Update one catalog item's default duration / sensitive flag (PUT /configuration); returns the stored row or null when unknown. */
export function updateCatalogItem(id: string, patch: { defaultDuration?: AccessCatalogRow['defaultDuration']; sensitive?: boolean }): AccessCatalogRow | null {
  store();
  const row = accessCatalogFixture.rows().find((i) => i.id === id);
  if (!row) return null;
  if (patch.defaultDuration) row.defaultDuration = patch.defaultDuration;
  if (patch.sensitive !== undefined) row.sensitive = patch.sensitive;
  // The item's sensitivity shapes every open request's decider chain.
  invalidateAll('access-catalog');
  noteSearchWriteSoon(sref('catalog', row.id), ...openRequestRefs());
  return structuredClone(row);
}

/** Update a policy's severity / reason; returns the stored row or null when unknown. */
export function updatePolicy(id: string, patch: { severity?: AccessPolicyRow['severity']; reason?: string }, actorId: string): AccessPolicyRow | null {
  store();
  const row = accessPoliciesFixture.rows().find((p) => p.id === id);
  if (!row) return null;
  const before = { severity: row.severity, reason: row.reason };
  if (patch.severity) row.severity = patch.severity;
  if (patch.reason !== undefined) row.reason = patch.reason;
  row.updatedAt = clock.nowIso();
  row.updatedBy = actorId;
  // The audit trail (lane A2): one `policy-updated` event per save, with the
  // severity before / after and the reason as it now reads (or what it replaced).
  const events = accessEventsFixture.rows();
  const reasonChanged = before.reason !== row.reason;
  events.push({
    id: nextId('evt', events.map((e) => e.id)), requestId: null, policyId: row.id, delegationId: null, at: row.updatedAt, actorId, kind: 'policy-updated',
    beforeStatus: before.severity, afterStatus: row.severity,
    reason: reasonChanged ? `${row.title}: reason now “${row.reason}” (was “${before.reason}”)` : `${row.title}: reason unchanged`,
  });
  noteSearchWriteSoon(sref('policy', row.id), ...events.filter((e) => e.policyId === row.id).map((e) => sref('event', e.id)));
  return structuredClone(row);
}

/**
 * The live directory: current users and grants (authoritative — an identity
 * outage refuses rather than deciding against a stale fallback),
 * people.manager_id, and initiative owners / contributors.
 */
export async function loadDirectory(): Promise<AccessDirectory> {
  store();
  const [listed, grants, budgets] = await Promise.all([
    listUsers({ authoritative: true }),
    // Sprint envelopes (2026-10-28): who holds an active grant where, and who
    // set each allocation — the "already holds" rule and the budget-holder
    // steward. Read through providers/budgets.ts, the same rows POST /api/grants
    // writes and lib/bot-runner.ts dispatches on; an unreadable store means no
    // holders and no holder, never a guess.
    listGrants().catch((err: unknown) => { console.warn('[access] grants unavailable for the directory:', (err as Error).message); return []; }),
    listBudgets().catch((err: unknown) => { console.warn('[access] budgets unavailable for the directory:', (err as Error).message); return []; }),
  ]);
  const users = listed.map((u) => ({
    id: u.id, displayName: u.displayName, personId: u.personId ?? null, grants: structuredClone(u.grants),
  }));
  const managers = new Map(accessPeopleFixture.rows().map((p) => [p.id, p.managerId]));
  // Active = the grant's sprint is `active`, or it has no sprint (standing) — lib/bot-runner.ts isActiveGrant.
  const holders = new Map<string, string[]>();
  for (const g of grants) {
    if (g.sprintStatus === 'active' || g.sprintId == null) holders.set(g.orgProjectId, [...(holders.get(g.orgProjectId) ?? []), g.granteePersonId]);
  }
  const budgetHolders = new Map(budgets.filter((b) => b.updatedBy).map((b) => [b.orgProjectId, b.updatedBy!]));
  const now = clock.nowIso();
  return {
    users,
    envelopeHolders: (projectId) => holders.get(projectId) ?? [],
    budgetHolderOf: (projectId) => budgetHolders.get(projectId) ?? null,
    // Delegations in force now (lib/access/chain.ts adds their delegates live).
    activeDelegations: accessDelegationsFixture.rows().filter((d) => delegationState(d, now) === 'active')
      .map((d) => ({ id: d.id, delegatorId: d.delegatorId, delegateId: d.delegateId })),
    managerOf: (personId) => (personId ? managers.get(personId) ?? null : null),
    initiative: (projectId) => {
      const p = findInitiative(projectId);
      return p ? { ownerPersonId: p.owner, memberPersonIds: [p.owner, ...p.smes] } : null;
    },
  };
}

/**
 * The directory with `userId` in it. The listing leaves out the mock's
 * ephemeral identity clones (providers/identity.ts: a clone resolves by id but
 * is never listed), so a session signed in as a clone of Rhea was "unknown" to
 * every access rule — its own request preview answered 400 and its record's
 * thread 403. A clone stands in the directory as itself (its own id, its
 * persona's person and grants); nobody else's listing changes.
 */
export async function withDirectoryUser(dir: AccessDirectory, userId: string): Promise<AccessDirectory> {
  if (dir.users.some((u) => u.id === userId)) return dir;
  const u = await getUser(userId, { authoritative: true });
  if (!u) return dir;
  return { ...dir, users: [...dir.users, { id: u.id, displayName: u.displayName, personId: u.personId ?? null, grants: structuredClone(u.grants) }] };
}
