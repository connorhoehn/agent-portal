// Provisioning and revocation for the access tenant (docs/access-tenant-design.md
// decisions A2, A3, A6; docs/access-tenant-goal.md §A1).
//
// The last approval calls `provisionAccess`; expiry (lib/access-expiry.ts) and
// any later revocation call `revokeAccess`. Both write ONLY the stores the rest
// of the app already reads:
//
//   tenant-role             the beneficiary's grants, merged through
//                           providers/identity.ts `setGrants` (user_tenant_roles)
//   capability              the same grants merge — a grant entry that is not a
//                           role (lib/session.ts CAPABILITY_GRANTS), e.g. orgiq
//                           `budgets-reader` for budget visibility
//   initiative-membership   a project_contributions row, through
//                           providers/projects.ts `addContribution`
//
// then an `access_events` row and the request's own status. There is no
// second table of "effective access".
//
// The session epoch (decision A3, as decided 2026-10-13):
//   provision  does NOT bump. The granted role reaches the beneficiary's open
//              cookie through lib/session.ts's grants refresh (≤ GRANTS_REFRESH_S)
//              — and strict reads (lib/live-principal.ts, /api/session/me) see
//              it at once — without signing them out.
//   revoke     DOES bump (`bumpSessionEpoch`), so every cookie the beneficiary
//              holds is retired at its next read: removal never waits on a
//              refresh window and never survives in a copied cookie.
//
// Order and once-only:
//   provision  claim approved → provisioned (a compare-and-set; the loser does
//              nothing), write the grant (idempotent), then
//              provisioned → active with the `provisioned` event. A crash after
//              the claim leaves `provisioned`, which a retry resumes.
//   revoke     remove the grant (idempotent), bump, then claim
//              active|provisioned → expired|revoked with its event. Removing
//              first means a failed write never leaves a row that says
//              "revoked" over a grant that is still held.
// In-process calls on one request are serialized; across replicas the expiry
// sweeper holds the fleet lock, and the compare-and-set decides any race left.
//
// Separation of duties at provisioning (decision A7, lane A2): the submit
// pre-check read the beneficiary's grants as they stood then; a grant added
// since (another request, an admin edit) can create a conflict the approvers
// never saw. So provisionAccess re-evaluates the policies against the
// beneficiary's CURRENT grants before it writes anything. A `block` refuses:
// the request stays `approved`, a `sod-blocked` event is recorded and the
// requester, the beneficiary and the access admins hear about it (once per
// block, not per retry) — unless an access admin has recorded an override
// (POST /api/access/requests/:id/sod-override), which re-runs this.
//
// Mock mode: every write lands in a registered fixture (identity.grant-writes,
// initiatives, access.requests, access.events), so `POST /api/__mock/reset`
// undoes a provisioning. Outside the mock providers/access.ts answers 503
// until schema/access_schema.sql is applied (lane E).

import { AppError } from './async-handler.js';
import { bumpSessionEpoch, getUser, listUsers, setGrants } from '../providers/identity.js';
import { addContribution, removeContribution } from '../providers/projects.js';
import { accessNow, casRequest, findRequest, listCatalog, listPolicies, type AccessCatalogRow, type AccessRequestRow } from '../providers/access.js';
import { requestItem } from './access/items.js';
import { sodConflicts, sodVerdict } from './access/sod.js';
import { notifyAccessRequest } from './social-notify.js';
import type { AccessDuration, SodConflict } from './access/types.js';
import type { Grants } from './session.js';

/** An audit reason is read by people: a calendar date (UTC, the store's zone), never an ISO stamp. */
export function expiryLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const HOUR = 3_600_000;
/** How long each duration lasts once provisioned; `standing` has no end. */
export const DURATION_MS: Readonly<Record<AccessDuration, number | null>> = {
  '8h': 8 * HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR, standing: null,
};

/** When access provisioned at `from` for `duration` ends, or null for standing. */
export function expiresAtFor(duration: AccessDuration, from: string): string | null {
  const ms = DURATION_MS[duration];
  return ms === null ? null : new Date(Date.parse(from) + ms).toISOString();
}

export class ProvisionError extends AppError {
  constructor(message: string) { super(409, message); }
}

/** Provisioning refused because a blocking SoD policy now applies and no override is recorded. */
export class SodBlockedError extends ProvisionError {
  constructor(message: string, public readonly conflicts: SodConflict[]) { super(message); }
}

export interface ProvisionOutcome {
  /** The stored request after the call. */
  request: AccessRequestRow;
  /** False when another caller already did it (idempotent re-provision / re-revoke). */
  changed: boolean;
}

// ── in-process serialization per request ────────────────────────────────────
const inFlight = new Map<string, Promise<unknown>>();
async function serialized<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(requestId) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  inFlight.set(requestId, run);
  try { return await run; } finally { if (inFlight.get(requestId) === run) inFlight.delete(requestId); }
}

function itemFor(request: AccessRequestRow): AccessCatalogRow {
  const item = requestItem(request, listCatalog());
  if (!item) throw new ProvisionError(`${request.itemId} is no longer in the catalog; ${request.id} cannot be provisioned or revoked`);
  return item;
}

async function beneficiaryOf(request: AccessRequestRow) {
  const user = await getUser(request.beneficiaryId, { authoritative: true });
  if (!user) throw new ProvisionError(`${request.beneficiaryId} is no longer in the directory`);
  return user;
}

/** `grants` with `role` added to (or removed from) `tenant`; tenants left empty are dropped. */
export function withRole(grants: Grants, tenant: string, role: string, present: boolean): Grants {
  const next: Grants = structuredClone(grants);
  const roles = new Set(next[tenant] ?? []);
  if (present) roles.add(role); else roles.delete(role);
  if (roles.size) next[tenant] = [...roles]; else delete next[tenant];
  return next;
}

/**
 * Write (or remove) the item for the beneficiary in the existing grant store. Idempotent.
 *
 * Serialized per BENEFICIARY, not per request: the merge reads the user's
 * grants and writes the whole set back (`setGrants`), so two different
 * requests provisioning the same person at once (SME and budget visibility,
 * say) would each write a set missing the other's role — a lost update the
 * per-request lock above cannot see (2026-10-14, lane A). On the cluster the
 * single-role statements in lib/access/sql.ts (`GRANT_ROLE_SQL` /
 * `REVOKE_ROLE_SQL`) remove the read-modify-write altogether; the native
 * PostgreSQL contract shows setGrants' delete-and-reinsert losing a grant
 * under the same race.
 */
async function applyGrant(request: AccessRequestRow, item: AccessCatalogRow, present: boolean): Promise<void> {
  return serialized(`beneficiary:${request.beneficiaryId}`, () => applyGrantNow(request, item, present));
}

async function applyGrantNow(request: AccessRequestRow, item: AccessCatalogRow, present: boolean): Promise<void> {
  const user = await beneficiaryOf(request);
  // A capability (orgiq `budgets-reader`) is a grant entry like a role: same store, same merge.
  if (item.kind === 'tenant-role' || item.kind === 'capability') {
    if (!item.role) throw new ProvisionError(`${item.id} names no ${item.kind === 'capability' ? 'capability' : 'role'}`);
    const holds = (user.grants[item.tenant] ?? []).includes(item.role);
    if (holds !== present) await setGrants(user.id, withRole(user.grants, item.tenant, item.role, present));
    return;
  }
  if (!item.projectId) throw new ProvisionError(`${item.id} names no initiative`);
  if (!user.personId) throw new ProvisionError(`${user.displayName} has no linked person; an initiative membership needs one`);
  if (present) await addContribution(item.projectId, user.personId);
  else await removeContribution(item.projectId, user.personId);
}

async function names(request: AccessRequestRow, actorId: string | null) {
  const [beneficiary, actor] = await Promise.all([
    getUser(request.beneficiaryId).catch(() => null),
    actorId ? getUser(actorId).catch(() => null) : Promise.resolve(null),
  ]);
  return { beneficiaryName: beneficiary?.displayName ?? request.beneficiaryId, actorName: actor?.displayName ?? actorId };
}

/**
 * Provision an approved request: write the grant (no epoch bump — it reaches
 * open cookies at the grants refresh), record `provisioned`, set provisionedAt / expiresAt and move it to
 * `active`. Calling it again on an active request changes nothing.
 */
export async function provisionAccess(request: Pick<AccessRequestRow, 'id'>): Promise<ProvisionOutcome> {
  return serialized(request.id, async () => {
    const current = findRequest(request.id);
    if (!current) throw new AppError(404, `No request ${request.id}`);
    if (current.status === 'active') return { request: current, changed: false };
    if (current.status !== 'approved' && current.status !== 'provisioned') {
      throw new ProvisionError(`${current.id} is ${current.status}; only an approved request is provisioned`);
    }
    if (current.kind === 'revocation') throw new ProvisionError(`${current.id} is a revocation; it is never provisioned`);
    const item = itemFor(current);
    // Refuse what can never be written BEFORE claiming the row, so a request
    // that cannot be provisioned stays `approved` and says why.
    const beneficiary = await beneficiaryOf(current);
    if (item.kind === 'initiative-membership' && !beneficiary.personId) {
      throw new ProvisionError(`${beneficiary.displayName} has no linked person; an initiative membership needs one`);
    }
    const now = accessNow();
    // SoD against the beneficiary's grants NOW (A7), not the submit-time snapshot.
    if (current.status === 'approved' && !current.sodOverriddenBy) {
      const conflicts = sodConflicts(item, beneficiary.grants, listPolicies());
      if (sodVerdict(conflicts) === 'block') {
        const blocking = conflicts.filter((c) => c.severity === 'block');
        const why = blocking.map((c) => `${c.policyId}: ${c.reason}`).join(' ');
        // Record the block once: a retry over the same block adds no event and rings no bell.
        if (current.sodVerdict !== 'block') {
          const marked = casRequest(current.id, { from: ['approved'] }, { sodVerdict: 'block' },
            [{ kind: 'sod-blocked', before: 'approved', after: 'approved', reason: why }], null, now);
          if (marked) {
            const admins = (await listUsers({ authoritative: true }).catch(() => []))
              .filter((u) => (u.grants['access'] ?? []).includes('access-admin')).map((u) => u.id);
            await notifyAccessRequest({
              kind: 'sod-blocked', requestId: current.id, itemTitle: item.title, requesterId: current.requesterId, beneficiaryId: current.beneficiaryId,
              ...(await names(current, null)), actorId: null, approverIds: admins, comment: why,
            });
          }
        }
        throw new SodBlockedError(`Separation of duties blocks ${item.title} for ${beneficiary.displayName} now (${blocking.map((c) => c.policyId).join(', ')}); an access admin must record an override before it is provisioned`, conflicts);
      }
    }
    const expiresAt = expiresAtFor(current.duration, now);
    let claimed = current;
    if (current.status === 'approved') {
      const won = casRequest(current.id, { from: ['approved'] }, { status: 'provisioned', provisionedAt: now, expiresAt }, [], null, now);
      if (!won) return { request: findRequest(current.id) ?? current, changed: false };
      claimed = won;
    }
    try {
      // No epoch bump here (A3): the grant reaches open cookies at the grants refresh.
      await applyGrant(claimed, item, true);
    } catch (err) {
      // The grant write failed: hand the claim back, so the row says `approved`
      // (decided, not in effect) rather than `provisioned` over nothing.
      if (current.status === 'approved') casRequest(claimed.id, { from: ['provisioned'] }, { status: 'approved', provisionedAt: null, expiresAt: null }, [], null, now);
      throw err;
    }
    const done = casRequest(claimed.id, { from: ['provisioned'] },
      { status: 'active', provisionedAt: claimed.provisionedAt ?? now, expiresAt: claimed.expiresAt ?? expiresAt },
      [{ kind: 'provisioned', before: 'approved', after: 'active', reason: claimed.expiresAt ? `Expires ${expiryLabel(claimed.expiresAt)}` : 'Standing' }], null, now);
    if (!done) return { request: findRequest(claimed.id) ?? claimed, changed: false };
    await notifyAccessRequest({
      kind: 'provisioned', requestId: done.id, itemTitle: item.title, requesterId: done.requesterId, beneficiaryId: done.beneficiaryId,
      ...(await names(done, null)), actorId: null, expiresAt: done.expiresAt,
    });
    return { request: done, changed: true };
  });
}

export interface RevokeOptions {
  /** `expired` for the sweeper (the default with no actor), `revoked` for a person's or policy's decision. */
  outcome?: 'expired' | 'revoked';
}

/**
 * The inverse of provisionAccess: remove the role / contribution, bump the
 * beneficiary's epoch, record `expired` or `revoked` (actor null = the system)
 * and stamp revokedAt. A request that is no longer active changes nothing.
 */
export async function revokeAccess(request: Pick<AccessRequestRow, 'id'>, reason: string | null, actorId: string | null, options: RevokeOptions = {}): Promise<ProvisionOutcome> {
  const outcome = options.outcome ?? (actorId ? 'revoked' : 'expired');
  return serialized(request.id, async () => {
    const current = findRequest(request.id);
    if (!current) throw new AppError(404, `No request ${request.id}`);
    if (current.status !== 'active' && current.status !== 'provisioned') return { request: current, changed: false };
    const item = itemFor(current);
    await applyGrant(current, item, false);
    await bumpSessionEpoch(current.beneficiaryId);
    const now = accessNow();
    const done = casRequest(current.id, { from: ['active', 'provisioned'] }, { status: outcome, revokedAt: now },
      [{ kind: outcome, before: current.status, after: outcome, reason }], actorId, now);
    if (!done) return { request: findRequest(current.id) ?? current, changed: false };
    await notifyAccessRequest({
      kind: outcome, requestId: done.id, itemTitle: item.title, requesterId: done.requesterId, beneficiaryId: done.beneficiaryId,
      ...(await names(done, actorId)), actorId, comment: reason,
    });
    return { request: done, changed: true };
  });
}
