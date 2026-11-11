// Budget thresholds (docs/learning-loop-design.md "Budgets", lane B).
//
// When committed spend plus money held by runs in flight first reaches a
// threshold of a budget in a period, the budget's owner hears about it once, in
// the bell and the notification centre, with a link to the Budgets row; at 100
// percent the org leaders hear too. Three kinds of budget are watched:
//
//   initiative  its effective allocation (allocation + carry in, DE-38), per the
//               initiative's own period key (calendar month for rolling)
//   user        the user's monthly budget (DE-54), per calendar month
//   grant       a sprint envelope, per sprint (a standing grant: per month)
//
// ── Where it is evaluated ────────────────────────────────────────────────────
// At the two places money moves: lib/spend-holds.ts `reserveSpend` after a hold
// is written (spent + held went up) and providers/spend-ledger.ts after a ledger
// entry settles (the held figure became a spent one, possibly larger). Every
// executor reserves and settles through those two, so none is missed. The
// reaper's sweep (lib/fleet-alerts.ts) announces through the same marks, so a
// crossing it sees first is not said again here, and the other way round.
//
// ── Decisions this encodes ───────────────────────────────────────────────────
// - The percentage is of the BUDGET the brakes judge (the allocation), not of
//   the hard cap above it: the allocation is where every path that cannot
//   confirm (jobs, box tasks, bot firings) already stops, so 100 percent here is
//   "at cap" for most work. The hard cap's own refusal is unchanged.
// - Thresholds are `BUDGET_THRESHOLDS` (comma-separated percentages, default
//   50,80,100). Anything at or over 100 also goes to the org leaders.
// - One notification per (subject, threshold, period), decided by a stored
//   mark: `budget_threshold_marks`' primary key (Aurora) or the
//   `budget-threshold-marks` fixture (offline). The insert that wins announces;
//   every other replica, retry or restart finds the mark and stays quiet. A
//   reservation that crosses two thresholds writes two marks and sends two
//   items. Spend that drops back under (a released hold) and crosses again in
//   the same period finds its mark and sends nothing; a new period has no marks.
// - A mark that cannot be written (table not applied, store down) sends
//   nothing: silence is recoverable, a repeated bell every reservation is not.
// - Nothing here ever throws into the caller or refuses money. Every failure is
//   logged and the reservation or ledger write goes on.

import { clock } from '../mock/core/index.js';
import { config } from '../config.js';
import { exec } from '../providers/aurora.js';
import { budgetThresholdMarks } from '../mock/run-controls.js';
import { budgetedAllocation, monthWindow } from './budget-periods.js';
import { emitFleetMetric } from './fleet-metrics.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';

export {
  DEFAULT_THRESHOLDS, configuredThresholds, thresholdState, thresholdsReached, budgetsRowHref,
  type ThresholdSubject, type ThresholdSubjectKind,
} from './budget-threshold-rules.js';
import { configuredThresholds, thresholdsReached, budgetsRowHref, type ThresholdSubject, type ThresholdSubjectKind } from './budget-threshold-rules.js';

/** The calendar month key (YYYY-MM) for the mock clock's now. */
export function monthKey(now: Date = clock.now()): string {
  return monthWindow(now).key!;
}

// ─── The marks ───────────────────────────────────────────────────────────────

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }

/**
 * Write the mark for (subject, threshold, period). True: this call wrote it and
 * should announce. False: it was already there. Null: it could not be written.
 */
export async function claimThresholdMark(subject: ThresholdSubject, threshold: number, periodKey: string): Promise<boolean | null> {
  try {
    if (config.mock.aurora) {
      const rows = budgetThresholdMarks.rows();
      const had = rows.some((r) => r.subjectKind === subject.kind && r.subjectId === subject.id
        && r.threshold === threshold && r.periodKey === periodKey);
      if (had) return false;
      rows.push({ subjectKind: subject.kind, subjectId: subject.id, threshold, periodKey, crossedAt: clock.nowIso() });
      return true;
    }
    const rows = await exec(
      `INSERT INTO budget_threshold_marks (subject_kind, subject_id, threshold, period_key)
       VALUES (:kind, :id, :t, :period)
       ON CONFLICT DO NOTHING RETURNING threshold`,
      [s('kind', subject.kind), s('id', subject.id), { name: 't', value: { longValue: threshold } }, s('period', periodKey)],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn(`[budget-thresholds] could not write the ${threshold}% mark for ${subject.kind} ${subject.id}: ${(err as Error).message}`);
    return null;
  }
}

/** The marks for one period, for the Budgets rows and the tests. */
export async function listThresholdMarks(subjectKind?: ThresholdSubjectKind): Promise<Array<{ subjectKind: ThresholdSubjectKind; subjectId: string; threshold: number; periodKey: string }>> {
  try {
    if (config.mock.aurora) {
      return budgetThresholdMarks.rows().filter((r) => !subjectKind || r.subjectKind === subjectKind).map((r) => ({ ...r }));
    }
    const rows = await exec(
      `SELECT subject_kind, subject_id, threshold, period_key FROM budget_threshold_marks${subjectKind ? ' WHERE subject_kind = :kind' : ''}`,
      subjectKind ? [s('kind', subjectKind)] : [],
    );
    return rows.map((r) => ({
      subjectKind: String(r['subject_kind']) as ThresholdSubjectKind,
      subjectId: String(r['subject_id']),
      threshold: Number(r['threshold']),
      periodKey: String(r['period_key']),
    }));
  } catch {
    return [];
  }
}

// ─── Announcing ──────────────────────────────────────────────────────────────

export interface Crossing {
  subject: ThresholdSubject;
  /** How the subject reads in a sentence ("Auth Migration", "Nora DaSilva"). */
  label: string;
  /** What the budget is called after it ("its budget", "their monthly budget"). Default "its budget". */
  noun?: string;
  /** The org-graph person who owns the budget (initiative owner, grantee), or the user id for a user budget. */
  ownerPersonId?: string | null;
  ownerUserId?: string | null;
  initiativeId?: string | null;
  usedUsd: number;
  budgetUsd: number;
  periodKey: string;
}

export interface Announced {
  subject: ThresholdSubject;
  threshold: number;
  periodKey: string;
  recipients: string[];
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** Users who can open /admin/budgets (routes/budgets.ts readGate): the read roles, or ManageBudgets. */
async function budgetReaders(): Promise<Set<string>> {
  try {
    const { listUsers } = await import('../providers/identity.js');
    const { usersHoldingAction } = await import('./social-notify.js');
    const readRoles = ['org-leader', 'hr-admin', 'program-owner', 'admin'];
    const byRole = (await listUsers()).filter((u) => (u.grants['orgiq'] ?? []).some((r) => readRoles.includes(r))).map((u) => u.id);
    return new Set([...byRole, ...await usersHoldingAction('orgiq', 'ManageBudgets')]);
  } catch {
    return new Set();
  }
}

async function orgLeaders(): Promise<string[]> {
  try {
    const { listUsers } = await import('../providers/identity.js');
    return (await listUsers()).filter((u) => (u.grants['orgiq'] ?? []).includes('org-leader')).map((u) => u.id);
  } catch {
    return [];
  }
}

/**
 * Announce every threshold `c` has reached that has no mark yet this period:
 * one mark, one metric line and one bell item per threshold. Never throws.
 */
export async function announceCrossing(c: Crossing, thresholds: readonly number[] = configuredThresholds()): Promise<Announced[]> {
  const out: Announced[] = [];
  try {
    const reached = thresholdsReached(c.usedUsd, c.budgetUsd, thresholds);
    if (reached.length === 0) return out;
    for (const t of reached) {
      const wrote = await claimThresholdMark(c.subject, t, c.periodKey);
      if (wrote !== true) continue;
      emitFleetMetric('budget-threshold', {
        ...(c.subject.kind === 'initiative' ? { InitiativeId: c.subject.id } : {}),
        ...(c.subject.kind === 'grant' ? { GrantId: c.subject.id, ...(c.initiativeId ? { InitiativeId: c.initiativeId } : {}) } : {}),
        ...(c.subject.kind === 'user' ? { UserId: c.subject.id } : {}),
        subjectKind: c.subject.kind, threshold: t, spentUsd: c.usedUsd, allocatedUsd: c.budgetUsd, period: c.periodKey,
      });
      out.push({ subject: c.subject, threshold: t, periodKey: c.periodKey, recipients: await notifyCrossing(c, t) });
    }
  } catch (err) {
    console.warn(`[budget-thresholds] announcing ${c.subject.kind} ${c.subject.id} failed: ${(err as Error).message}`);
  }
  return out;
}

/** The bell item for one threshold: the owner, and at 100 percent or more the org leaders. Never throws. */
async function notifyCrossing(c: Crossing, t: number): Promise<string[]> {
  try {
    const { notify, userForPerson } = await import('./social-notify.js');
    const owner = c.ownerUserId ?? (c.ownerPersonId ? await userForPerson(c.ownerPersonId) : null);
    const recipients = new Set<string>(owner ? [owner] : []);
    if (t >= 100) for (const u of await orgLeaders()) recipients.add(u);
    if (recipients.size === 0) return [];
    const atCap = t >= 100;
    const input = {
      id: `budget-threshold:${c.subject.kind}:${c.subject.id}:${t}:${c.periodKey}`,
      type: 'budget-alert',
      title: atCap ? `${c.label} has reached ${c.noun ?? 'its budget'}` : `${c.label} has used ${t}% of ${c.noun ?? 'its budget'}`,
      body: `${money(c.usedUsd)} of ${money(c.budgetUsd)} spent or held this period.`,
      payload: {
        tenant: 'orgiq', kind: 'budget-threshold', subjectKind: c.subject.kind, subjectId: c.subject.id,
        threshold: t, period: c.periodKey, ...(c.initiativeId ? { initiativeId: c.initiativeId } : {}),
      },
    };
    // The Budgets page is behind the budgets read gate: only a reader gets the link.
    const readers = await budgetReaders();
    const withLink = [...recipients].filter((u) => readers.has(u));
    const without = [...recipients].filter((u) => !readers.has(u));
    const sent = [
      ...(withLink.length ? await notify(withLink, { ...input, action: { label: 'Open the budget', href: budgetsRowHref(c.subject) } }) : []),
      ...(without.length ? await notify(without, input) : []),
    ];
    return sent;
  } catch (err) {
    console.warn(`[budget-thresholds] bell delivery for ${c.subject.kind} ${c.subject.id} failed: ${(err as Error).message}`);
    return [];
  }
}

// ─── Reading the three budgets ───────────────────────────────────────────────

export interface SpendSubjects {
  initiativeId: string | null;
  actorId: string | null;
  /** An essential bot's scheduled firing charges no user (DE-54/55). */
  essential?: boolean;
}

/** The initiative's budget now: spent this period + every open hold, against the effective allocation. */
async function initiativeCrossing(initiativeId: string): Promise<Crossing | null> {
  const { getBudget } = await import('../providers/budgets.js');
  const { openHeldUsd } = await import('../providers/spend-holds.js');
  const row = await getBudget(initiativeId);
  if (!row) return null;
  const budget = budgetedAllocation(row);
  if (budget == null || !(budget > 0)) return null;
  const held = await openHeldUsd(initiativeId).catch(() => 0);
  let ownerPersonId: string | null = null;
  try {
    const { getProject } = await import('../providers/projects.js');
    ownerPersonId = (await getProject(initiativeId))?.ownerId ?? null;
  } catch { ownerPersonId = null; }
  return {
    subject: { kind: 'initiative', id: initiativeId },
    label: row.orgProjectName ?? 'An initiative',
    ownerPersonId, initiativeId,
    usedUsd: Math.round((row.spentThisPeriodUsd + held) * 10_000) / 10_000,
    budgetUsd: budget,
    periodKey: row.periodKey ?? monthKey(),
  };
}

async function userCrossing(userId: string): Promise<Crossing | null> {
  const { getUserBudget, userSpendThisPeriod } = await import('../providers/user-budgets.js');
  const { openHeldUsdForActor } = await import('../providers/spend-holds.js');
  const row = await getUserBudget(userId);
  if (!row || !(row.allocatedUsd > 0)) return null;
  const [spend, held] = await Promise.all([userSpendThisPeriod(userId), openHeldUsdForActor(userId).catch(() => 0)]);
  return {
    subject: { kind: 'user', id: userId },
    label: row.displayName ?? 'A user',
    noun: 'their monthly budget',
    ownerUserId: userId,
    usedUsd: Math.round((spend.spentUsd + held) * 10_000) / 10_000,
    budgetUsd: row.allocatedUsd,
    periodKey: monthKey(),
  };
}

async function grantCrossing(initiativeId: string, actorId: string): Promise<Crossing | null> {
  const { loadEnvelopeGate } = await import('./bot-runner.js');
  const { openHeldUsdForGrant } = await import('../providers/spend-holds.js');
  const g = await loadEnvelopeGate(initiativeId, actorId);
  if (g.kind !== 'ok') return null;
  const e = g.envelope;
  if (!(e.allocatedUsd > 0)) return null;
  const held = await openHeldUsdForGrant(e.grantId).catch(() => 0);
  const where = e.sprintName ? `${e.sprintName} envelope` : 'standing envelope';
  return {
    subject: { kind: 'grant', id: e.grantId },
    label: `The ${where} on ${e.orgProjectName ?? 'an initiative'}`,
    ownerPersonId: e.granteePersonId, initiativeId,
    usedUsd: Math.round((e.attributedSpentUsd + held) * 10_000) / 10_000,
    budgetUsd: e.allocatedUsd,
    periodKey: e.sprintId ?? monthKey(),
  };
}

/** Test seam: the settle-path checks run in the background; this waits for them. */
const pending = new Set<Promise<unknown>>();
export async function thresholdChecksSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/**
 * Re-read every budget this spend touches and announce what newly crossed.
 * Never throws; a budget that cannot be read is skipped and logged.
 */
export async function checkBudgetThresholds(s: SpendSubjects): Promise<Announced[]> {
  const out: Announced[] = [];
  const thresholds = configuredThresholds();
  const readers: Array<[string, () => Promise<Crossing | null>]> = [];
  if (s.initiativeId) readers.push([`initiative ${s.initiativeId}`, () => initiativeCrossing(s.initiativeId!)]);
  if (s.actorId && !s.essential) {
    readers.push([`user ${s.actorId}`, () => userCrossing(s.actorId!)]);
    if (s.initiativeId) readers.push([`envelope of ${s.actorId} on ${s.initiativeId}`, () => grantCrossing(s.initiativeId!, s.actorId!)]);
  }
  for (const [what, read] of readers) {
    try {
      const c = await read();
      if (c) out.push(...await announceCrossing(c, thresholds));
    } catch (err) {
      console.warn(`[budget-thresholds] could not read ${what}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** The settle path's form: in the background, so a ledger write never waits on a bell. */
export function checkBudgetThresholdsLater(s: SpendSubjects): void {
  if (!s.initiativeId && !s.actorId) return;
  const p = checkBudgetThresholds(s).catch(() => []).finally(() => { pending.delete(p); });
  pending.add(p);
}
