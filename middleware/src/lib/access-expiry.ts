// The access tenant's expiry sweeper (docs/access-tenant-design.md decision A6,
// §4.3; docs/access-tenant-goal.md §A1).
//
// Every ACCESS_EXPIRY_SWEEP_MS (default 60 s) it:
//   1. revokes each active (or stuck `provisioned`) request whose expiresAt has
//      passed, through lib/access-provision.ts `revokeAccess` — the same path a
//      person's revocation takes, so expiry removes exactly what provisioning
//      wrote, bumps the epoch and records an `expired` event;
//   2. sends the 24-hour warning to the requester and the beneficiary of each
//      active request ending within ACCESS_EXPIRY_WARN_MS (default 24 h), once
//      (the `expiryWarnedAt` claim, a compare-and-set on the row).
//
// Single-flight across replicas, like the dispatcher's boot recovery
// (lib/job-dispatcher.ts `recoverOrphanedWork`) over lib/replica-fleet.ts:
//   - no peers (one task, or no REDIS_URL): sweep directly;
//   - peers: sweep only under the fleet lock `access-expiry-sweep`, and skip
//     the tick when another replica holds it; an unreachable Redis (the lock
//     call throws) skips too — a sweep without the lock is the duplicate the
//     lock exists to stop, and the next tick retries.
// The row claims underneath still decide any race the lock leaves (an expired
// lock, a person's revoke during the sweep), so nothing is revoked or warned twice.
//
// Outside the mock, providers/access.ts answers 503 until the schema is applied
// (lane E); the sweeper reads that as "nothing to sweep here" and says so once.

import { AppError } from './async-handler.js';
import { replicaFleet, type ReplicaFleet } from './replica-fleet.js';
import { revokeAccess } from './access-provision.js';
import { accessNow, casRequest, listCatalog, listRequests, type AccessRequestRow } from '../providers/access.js';
import { getUser } from '../providers/identity.js';
import { notifyAccessRequest } from './social-notify.js';

const HOUR = 3_600_000;
export const EXPIRY_LOCK = 'access-expiry-sweep';
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How often the sweep runs. */
export const sweepIntervalMs = (): number => envMs('ACCESS_EXPIRY_SWEEP_MS', 60_000);
/** How far ahead the warning goes out. */
export const warnAheadMs = (): number => envMs('ACCESS_EXPIRY_WARN_MS', 24 * HOUR);

export interface SweepResult {
  /** 'swept', or why this replica did not: another holds the lock / the lock was unreachable / no store. */
  ran: 'swept' | 'locked-elsewhere' | 'lock-unavailable' | 'store-unavailable';
  expired: string[];
  warned: string[];
  failed: Array<{ requestId: string; error: string }>;
}

const LIVE: ReadonlySet<AccessRequestRow['status']> = new Set(['active', 'provisioned']);

/** The rows due now, read fresh: expired grants and grants entering their last day unwarned. */
export function dueRows(rows: readonly AccessRequestRow[], now: string, aheadMs = warnAheadMs()): { expire: AccessRequestRow[]; warn: AccessRequestRow[] } {
  const t = Date.parse(now);
  const expire: AccessRequestRow[] = [];
  const warn: AccessRequestRow[] = [];
  for (const r of rows) {
    if (!LIVE.has(r.status) || !r.expiresAt) continue;
    const end = Date.parse(r.expiresAt);
    if (end <= t) expire.push(r);
    else if (r.status === 'active' && r.expiryWarnedAt === null && end - t <= aheadMs) warn.push(r);
  }
  return { expire, warn };
}

async function sweepOnce(): Promise<Omit<SweepResult, 'ran'>> {
  const now = accessNow();
  const { expire, warn } = dueRows(listRequests(), now);
  const out: Omit<SweepResult, 'ran'> = { expired: [], warned: [], failed: [] };
  for (const r of expire) {
    try {
      const res = await revokeAccess(r, `Reached its ${r.duration} end`, null, { outcome: 'expired' });
      if (res.changed) out.expired.push(r.id);
    } catch (err) {
      out.failed.push({ requestId: r.id, error: (err as Error).message });
    }
  }
  const titles = new Map(listCatalog().map((i) => [i.id, i.title]));
  for (const r of warn) {
    // The claim is the once-only rule: a second sweep (or replica) loses it.
    const claimed = casRequest(r.id, { from: ['active'], warnedAtNull: true }, { expiryWarnedAt: now }, [], null, now);
    if (!claimed) continue;
    const beneficiary = await getUser(r.beneficiaryId).catch(() => null);
    await notifyAccessRequest({
      kind: 'expiring', requestId: r.id, itemTitle: titles.get(r.itemId) ?? r.itemId, requesterId: r.requesterId,
      beneficiaryId: r.beneficiaryId, beneficiaryName: beneficiary?.displayName ?? null, actorId: null, expiresAt: r.expiresAt,
    });
    out.warned.push(r.id);
  }
  return out;
}

/**
 * One sweep, single-flight across the fleet. Exported for tests and for an
 * operator who wants to run it now; the timer below calls it.
 */
export async function sweepAccessExpiry(fleet: ReplicaFleet = replicaFleet()): Promise<SweepResult> {
  const none = { expired: [], warned: [], failed: [] };
  try {
    const peers = await fleet.peers();
    if (peers.length === 0) return { ran: 'swept', ...(await sweepOnce()) };
    let result: Omit<SweepResult, 'ran'> | null;
    try {
      result = await fleet.withLock(EXPIRY_LOCK, Math.max(30_000, sweepIntervalMs()), sweepOnce);
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.warn(`[access-expiry] fleet lock unreachable; skipping this sweep: ${(err as Error).message}`);
      return { ran: 'lock-unavailable', ...none };
    }
    return result ? { ran: 'swept', ...result } : { ran: 'locked-elsewhere', ...none };
  } catch (err) {
    if (err instanceof AppError && err.status === 503) return { ran: 'store-unavailable', ...none };
    throw err;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic sweep (index.ts, beside the other sweepers). Idempotent. */
export function startAccessExpirySweeper(): void {
  if (timer) return;
  let quietAbout503 = false;
  const tick = async () => {
    try {
      const r = await sweepAccessExpiry();
      if (r.ran === 'store-unavailable') {
        if (!quietAbout503) console.log('[access-expiry] the access store is not applied here (lane E); nothing to sweep');
        quietAbout503 = true;
        return;
      }
      if (r.expired.length || r.warned.length || r.failed.length) {
        console.log(`[access-expiry] expired ${r.expired.length}, warned ${r.warned.length}, failed ${r.failed.length}`
          + (r.failed.length ? `: ${r.failed.map((f) => `${f.requestId} (${f.error})`).join('; ')}` : ''));
      }
    } catch (err) {
      console.warn(`[access-expiry] sweep failed: ${(err as Error).message}`);
    }
  };
  timer = setInterval(() => { void tick(); }, sweepIntervalMs());
  timer.unref?.();
}

export function stopAccessExpirySweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
