// The access tenant's escalation timers (2026-10-14; docs/access-tenant-api.md
// § "Escalation timers and delegation").
//
// Every ACCESS_ESCALATION_SWEEP_MS (default 60 s) it escalates each step that
// has been the one awaiting a decision (status `current`) for longer than the
// SLA, ACCESS_ESCALATION_SLA_MS (default 48 h), counted from when it became
// current (`currentSince`) or last escalated (`escalatedAt`):
//   level 0 → 1  adds the access admins (an access-admin step: the platform admins)
//   level 1 → 2  adds the `admin` holders standing in `access`
// A level that would add nobody new is skipped; a step at the top stays there.
// Each escalation is one compare-and-set on the step (`casStep`, on the cluster
// `ESCALATE_STEP_SQL`), an `escalated` event on the request, and a bell item to
// the people it newly reaches. The step's own deciders keep their right
// (lib/access/chain.ts `eligibility` adds tiers; it never removes any).
//
// Single-flight across replicas, exactly like the expiry sweeper
// (lib/access-expiry.ts, lib/replica-fleet.ts): no peers → sweep; peers → only
// under the fleet lock `access-escalation-sweep`, skipping the tick when
// another replica holds it or Redis is unreachable. The step claim underneath
// decides any race the lock leaves, so a step escalates once per level.
//
// Outside the mock providers/access.ts answers 503 until the schema is applied
// (lane E); the sweeper reads that as "nothing to sweep here".

import { AppError } from './async-handler.js';
import { replicaFleet, type ReplicaFleet, type ReplicaLock } from './replica-fleet.js';
import { eligibility, MAX_ESCALATION_LEVEL, nextEscalationLevel } from './access/chain.js';
import { isOpen } from './access/status.js';
import { accessNow, casStep, listCatalog, listRequests, listSteps, loadDirectory, type AccessRequestRow, type AccessStepRow } from '../providers/access.js';
import { notifyAccessRequest } from './social-notify.js';

const HOUR = 3_600_000;
export const ESCALATION_LOCK = 'access-escalation-sweep';
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How long a step may wait at one level before it escalates. */
export const escalationSlaMs = (): number => envMs('ACCESS_ESCALATION_SLA_MS', 48 * HOUR);
/** How often the timer sweep runs. */
export const escalationSweepMs = (): number => envMs('ACCESS_ESCALATION_SWEEP_MS', 60_000);

/** "48 h" / "2 days" — the SLA as a person reads it in an event reason. */
export function slaLabel(ms: number): string {
  if (ms % (24 * HOUR) === 0 && ms >= 48 * HOUR) return `${ms / (24 * HOUR)} days`;
  if (ms >= HOUR) return `${Math.round((ms / HOUR) * 10) / 10} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** When a current step escalates next if still undecided, or null (not current, no clock, or at the top). */
export function escalatesAt(s: Pick<AccessStepRow, 'status' | 'currentSince' | 'escalatedAt' | 'escalationLevel'>, slaMs = escalationSlaMs()): string | null {
  if (s.status !== 'current' || s.escalationLevel >= MAX_ESCALATION_LEVEL) return null;
  const from = s.escalatedAt ?? s.currentSince;
  return from ? new Date(Date.parse(from) + slaMs).toISOString() : null;
}

/** Steps whose SLA has run out at `now`: current, on an open request, below the top level. */
export function dueSteps(requests: readonly AccessRequestRow[], steps: readonly AccessStepRow[], now: string, slaMs = escalationSlaMs()): Array<{ request: AccessRequestRow; step: AccessStepRow }> {
  const open = new Map(requests.filter((r) => r.kind === 'grant' && isOpen(r.status)).map((r) => [r.id, r]));
  const t = Date.parse(now);
  const out: Array<{ request: AccessRequestRow; step: AccessStepRow }> = [];
  for (const s of steps) {
    const request = open.get(s.requestId);
    const at = escalatesAt(s, slaMs);
    if (request && at && Date.parse(at) <= t) out.push({ request, step: s });
  }
  return out;
}

export interface EscalationSweepResult {
  ran: 'swept' | 'locked-elsewhere' | 'lock-unavailable' | 'store-unavailable';
  /** `<requestId>#<step>→<level>` for each escalation this sweep made. */
  escalated: string[];
  failed: Array<{ requestId: string; error: string }>;
}

async function sweepOnce(lease?: ReplicaLock): Promise<Omit<EscalationSweepResult, 'ran'>> {
  const now = accessNow();
  const sla = escalationSlaMs();
  const due = dueSteps(listRequests(), listSteps(), now, sla);
  const out: Omit<EscalationSweepResult, 'ran'> = { escalated: [], failed: [] };
  if (due.length === 0) return out;
  const dir = await loadDirectory();
  const catalog = new Map(listCatalog().map((i) => [i.id, i]));
  for (const { request, step } of due) {
    lease?.assertLive();
    try {
      const item = catalog.get(request.itemId);
      if (!item) continue;
      const next = nextEscalationLevel(step.kind, item, request, dir, step.escalationLevel);
      if (next === null) continue;
      const before = new Set(eligibility(step.kind, item, request, dir, step.escalationLevel).people.map((p) => p.id));
      const after = eligibility(step.kind, item, request, dir, next);
      const reached = after.people.filter((p) => !before.has(p.id));
      const reason = `Step ${step.step} (${step.kind}) waited ${slaLabel(sla)} without a decision: ${after.escalated?.replace(/^No decision in time: e/, 'e') ?? 'escalated'} `
        + `Now also: ${reached.map((p) => p.displayName).join(', ')}.`;
      // The claim is the once-only rule: a second sweep (or replica) loses it.
      const claimed = casStep(request.id, step.step, { status: ['current'], escalationLevel: step.escalationLevel },
        { escalationLevel: next as AccessStepRow['escalationLevel'], escalatedAt: now },
        [{ kind: 'escalated', before: request.status, after: request.status, reason }], null, now);
      if (!claimed) continue;
      const beneficiary = dir.users.find((u) => u.id === request.beneficiaryId);
      await notifyAccessRequest({
        kind: 'escalated', requestId: request.id, itemTitle: item.title, requesterId: request.requesterId, beneficiaryId: request.beneficiaryId,
        beneficiaryName: beneficiary?.displayName ?? null, actorId: null, approverIds: reached.map((p) => p.id), step: step.step,
        escalationLevel: next,
      });
      out.escalated.push(`${request.id}#${step.step}→${next}`);
    } catch (err) {
      out.failed.push({ requestId: request.id, error: (err as Error).message });
    }
  }
  return out;
}

/** One timer sweep, single-flight across the fleet. Exported for tests; the timer below calls it. */
export async function sweepAccessEscalations(fleet: ReplicaFleet = replicaFleet()): Promise<EscalationSweepResult> {
  const none = { escalated: [], failed: [] };
  try {
    const peers = await fleet.peers();
    if (peers.length === 0) return { ran: 'swept', ...(await sweepOnce()) };
    let result: Omit<EscalationSweepResult, 'ran'> | null;
    try {
      result = await fleet.withLock(ESCALATION_LOCK, Math.max(30_000, escalationSweepMs()), sweepOnce);
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.warn(`[access-escalation] fleet lock unreachable; skipping this sweep: ${(err as Error).message}`);
      return { ran: 'lock-unavailable', ...none };
    }
    return result ? { ran: 'swept', ...result } : { ran: 'locked-elsewhere', ...none };
  } catch (err) {
    if (err instanceof AppError && err.status === 503) return { ran: 'store-unavailable', ...none };
    throw err;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic timer sweep (index.ts, beside the expiry sweeper). Idempotent. */
export function startAccessEscalationSweeper(): void {
  if (timer) return;
  let quietAbout503 = false;
  const tick = async () => {
    try {
      const r = await sweepAccessEscalations();
      if (r.ran === 'store-unavailable') {
        if (!quietAbout503) console.log('[access-escalation] the access store is not applied here (lane E); nothing to sweep');
        quietAbout503 = true;
        return;
      }
      if (r.escalated.length || r.failed.length) {
        console.log(`[access-escalation] escalated ${r.escalated.length}, failed ${r.failed.length}`
          + (r.failed.length ? `: ${r.failed.map((f) => `${f.requestId} (${f.error})`).join('; ')}` : ''));
      }
    } catch (err) {
      console.warn(`[access-escalation] sweep failed: ${(err as Error).message}`);
    }
  };
  timer = setInterval(() => { void tick(); }, escalationSweepMs());
  timer.unref?.();
}

export function stopAccessEscalationSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
