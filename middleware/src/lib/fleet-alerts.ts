// Fleet alerts (DE-50, docs/deployment-enhancements/DE-50-kill-switches-and-alerts.md).
//
// Two outputs for one signal, so a person and an alarm hear the same thing:
//   - a JSON line on stdout, `{ "type": "<metric>", ... }`, which the
//     middleware stack's metric filters (infra/lib/fleet-alarms.ts, behind
//     `--context fleetAlarms=true`) turn into `OrgIQ/DevboxFleet` metrics —
//     the realtime gateway's stats-line pattern;
//   - an in-process event on `fleetAlerts`, and for budget crossings and
//     switch flips a bell item to the initiative's budget holders.
//
// Lines:
//   devbox-spend        { usd, InitiativeId, ActorId, source }         per ledger entry with a cost
//   devbox-reaped       { reason, boxId, minutes }                      per reaper stop (replaces console.warn)
//   devbox-reap-failed  { boxId, error }                                a box the reaper could not stop
//   devbox-run-cutoff   { InitiativeId, ceilingUsd, meteredUsd }        a run stopped at its ceiling (DE-35)
//   devbox-fleet-stats  { runningBoxes, liveBoxes, stuckRuns, fleetPaused }  once a minute, reaper leader
//   budget-threshold    { InitiativeId, threshold, spentUsd, allocatedUsd, period }  once per crossing per period
//   fleet-switch        { scope, paused, ActorId }                      every flip
//
// ── Decisions this encodes (recorded in the goal doc) ────────────────────────
// - Thresholds 50/80/100 % of the allocation, each announced once per period
//   (the highest crossed is remembered on initiative_budgets).
// - Auto-pause at 100 % is OFF (`BUDGET_AUTO_PAUSE=on` pauses the initiative
//   with reason 'budget'); a user decision.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { budgetThresholds } from '../mock/run-controls.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';

export { fleetAlerts, fleetMetricLine, emitFleetMetric, emitSpendMetric, type FleetMetric } from './fleet-metrics.js';
import { emitFleetMetric } from './fleet-metrics.js';

// ─── Budget thresholds ───────────────────────────────────────────────────────

export const THRESHOLDS = [50, 80, 100] as const;

/** The highest threshold `spent` has crossed of `allocated`, or 0. Pure. */
export function crossedThreshold(spentUsd: number, allocatedUsd: number | null): number {
  if (allocatedUsd == null || !(allocatedUsd > 0)) return 0;
  const pct = (spentUsd / allocatedUsd) * 100;
  let hit = 0;
  for (const t of THRESHOLDS) if (pct >= t) hit = t;
  return hit;
}

/**
 * Which threshold to announce now, given what was last announced for which
 * period. A new period starts from nothing; within one period only a HIGHER
 * crossing is announced, so each of 50/80/100 is said at most once. Pure.
 */
export function thresholdToAnnounce(
  crossed: number, period: string, last: { threshold: number | null; period: string | null } | null,
): number | null {
  if (crossed === 0) return null;
  const prior = last && last.period === period ? last.threshold ?? 0 : 0;
  return crossed > prior ? crossed : null;
}

/** The budget period a row's spend is windowed by: the calendar month (v1 is monthly only). */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }

async function lastAnnounced(orgProjectId: string): Promise<{ threshold: number | null; period: string | null } | null> {
  if (config.mock.aurora) {
    const r = budgetThresholds.rows().find((x) => x.orgProjectId === orgProjectId);
    return r ? { threshold: r.lastThresholdNotified, period: r.lastThresholdPeriod } : null;
  }
  const rows = await exec(
    `SELECT last_threshold_notified, last_threshold_period FROM initiative_budgets WHERE org_project_id = :pid`,
    [s('pid', orgProjectId)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    threshold: r['last_threshold_notified'] == null ? null : Number(r['last_threshold_notified']),
    period: r['last_threshold_period'] == null ? null : String(r['last_threshold_period']),
  };
}

async function recordAnnounced(orgProjectId: string, threshold: number, period: string): Promise<void> {
  if (config.mock.aurora) {
    const rows = budgetThresholds.rows();
    const at = rows.findIndex((x) => x.orgProjectId === orgProjectId);
    const row = { orgProjectId, lastThresholdNotified: threshold, lastThresholdPeriod: period };
    if (at >= 0) rows[at] = row; else rows.push(row);
    return;
  }
  await exec(
    `UPDATE initiative_budgets SET last_threshold_notified = :t, last_threshold_period = :p WHERE org_project_id = :pid`,
    [{ name: 't', value: { longValue: threshold } }, s('p', period), s('pid', orgProjectId)],
  );
}

export function budgetAutoPauseEnabled(): boolean {
  return (process.env['BUDGET_AUTO_PAUSE'] ?? '').trim().toLowerCase() === 'on';
}

export interface ThresholdCrossing { orgProjectId: string; threshold: number; spentUsd: number; allocatedUsd: number; period: string }

/**
 * One sweep over every allocation: announce each new crossing (line, bell,
 * event), remember it, and — only with BUDGET_AUTO_PAUSE=on — pause the
 * initiative at 100 %. Run by the reaper's leader tick so one replica speaks.
 */
export async function sweepBudgetThresholds(now = new Date()): Promise<ThresholdCrossing[]> {
  const { listBudgets } = await import('../providers/budgets.js');
  const period = currentPeriod(now);
  const out: ThresholdCrossing[] = [];
  let rows: Awaited<ReturnType<typeof listBudgets>>;
  try {
    rows = await listBudgets();
  } catch (err) {
    console.warn(`[fleet-alerts] budget sweep skipped: ${(err as Error).message}`);
    return out;
  }
  for (const row of rows) {
    if (row.allocatedUsd == null) continue;
    try {
      const crossed = crossedThreshold(row.spentThisPeriodUsd, row.allocatedUsd);
      const announce = thresholdToAnnounce(crossed, period, await lastAnnounced(row.orgProjectId));
      if (announce == null) continue;
      await recordAnnounced(row.orgProjectId, announce, period);
      const c: ThresholdCrossing = {
        orgProjectId: row.orgProjectId, threshold: announce, spentUsd: row.spentThisPeriodUsd,
        allocatedUsd: row.allocatedUsd, period,
      };
      out.push(c);
      emitFleetMetric('budget-threshold', {
        InitiativeId: c.orgProjectId, threshold: c.threshold, spentUsd: c.spentUsd, allocatedUsd: c.allocatedUsd, period,
      });
      await notifyBudgetHolders(
        `${row.orgProjectName ?? row.orgProjectId} has spent ${announce}% of its allocation`,
        `$${c.spentUsd.toFixed(2)} of $${c.allocatedUsd.toFixed(2)} this period.`,
        { initiativeId: c.orgProjectId, threshold: announce },
      );
      if (announce >= 100 && budgetAutoPauseEnabled()) {
        const { setSwitch, initiativeScope } = await import('./fleet-switches.js');
        await setSwitch(initiativeScope(c.orgProjectId), true, 'budget', 'budget-sweep');
        emitFleetMetric('fleet-switch', { scope: initiativeScope(c.orgProjectId), paused: true, ActorId: 'budget-sweep' });
      }
    } catch (err) {
      console.warn(`[fleet-alerts] threshold check failed for ${row.orgProjectId}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * A bell item to the people who hold the money: every orgiq org-leader (the
 * release manager's role) — never the SME who spent it. Best effort.
 */
export async function notifyBudgetHolders(title: string, body: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { listUsers } = await import('../providers/identity.js');
    const { notify } = await import('./social-notify.js');
    const users = await listUsers();
    const holders = users.filter((u) => (u.grants['orgiq'] ?? []).includes('org-leader')).map((u) => u.id);
    if (holders.length === 0) return;
    await notify(holders, {
      type: 'budget-alert', title, body,
      payload: { tenant: 'orgiq', ...payload },
      action: { label: 'Open budgets', href: '/admin/budgets' },
    });
  } catch (err) {
    console.warn(`[fleet-alerts] bell delivery failed: ${(err as Error).message}`);
  }
}
