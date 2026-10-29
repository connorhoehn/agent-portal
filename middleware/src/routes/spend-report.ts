// GET /api/spend/report?groupBy=initiative|actor|model|source|trigger&period=month|7d|30d[&initiativeId=]
//
// One grouped read over the spend ledger and open spend holds
// (docs/budget-system-analysis-2026-10-28.md §3; DE-53; DE-31's per-person
// view). With `initiativeId` the groups narrow to that initiative and the
// answer adds its blocks: allocation, reserve and floor vs discretionary,
// envelopes, holds, the forecast of open work with `fitsRemaining`, run
// outcomes. Providers: providers/spend-report.ts; arithmetic:
// lib/spend-report-model.ts.
//
// ── Read tier ────────────────────────────────────────────────────────────────
// Mounted behind a session floor (index.ts), not the budgets read gate, so the
// body is shaped by lib/budget-read-tier.ts `canReadBudgets`. Below the tier:
//   - every dollar field is ABSENT (never zero) and `budgetAccess` says why;
//   - an actor grouping (and an initiative's people) narrows to the caller's
//     own row, which keeps its dollars — your own spend is yours to see, as
//     GET /api/me/spend already answers;
//   - envelopes narrow to the caller's own, with their figures;
//   - counts (entries, unknown costs, runs, open items) stay: they are what the
//     initiative page already shows any signed-in reader.

import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession } from '../lib/authz.js';
import { budgetAccessLocked, canReadBudgets } from '../lib/budget-read-tier.js';
import { GROUP_BYS, REPORT_PERIODS, withhold, type ReportPeriod, type SpendGroupBy } from '../lib/spend-report-model.js';
import { getSpendReport, type SpendGroup, type SpendReport } from '../providers/spend-report.js';
import { getUser } from '../providers/identity.js';

export const spendReportRouter: Router = Router();

const GROUP_DOLLARS = ['knownUsd', 'burnPerDay7d', 'projectedPeriodEndUsd', 'heldUsd', 'remainingUsd', 'allocatedUsd'] as const;
const TOTAL_DOLLARS = ['knownUsd', 'burnPerDay7d', 'projectedPeriodEndUsd', 'heldUsd'] as const;
const ITEM_DOLLARS = ['p25Usd', 'p75Usd', 'aheadUsd', 'fitsRemaining'] as const;
const FORECAST_DOLLARS = ['p25Usd', 'p75Usd', 'models', 'discretionaryRemainingUsd'] as const;
const HOLD_DOLLARS = ['heldUsd'] as const;

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function lockedGroup(g: SpendGroup, ownActor: string | null): Partial<SpendGroup> {
  return ownActor != null && g.key === ownActor ? g : withhold(g, GROUP_DOLLARS);
}

/** The body a reader below the budgets tier receives. */
export async function shapeBelowTier(report: SpendReport, sub: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    ...report,
    totals: withhold(report.totals, TOTAL_DOLLARS),
    groups: report.groupBy === 'actor'
      ? report.groups.filter((g) => g.key === sub)
      : report.groups.map((g) => lockedGroup(g, null)),
    budgetAccess: budgetAccessLocked(),
  };
  const ini = report.initiative;
  if (ini) {
    let personId: string | null = null;
    try { personId = (await getUser(sub))?.personId ?? null; } catch { personId = null; }
    out['initiative'] = {
      id: ini.id,
      name: ini.name,
      holds: { ...withhold(ini.holds, HOLD_DOLLARS), items: [] },
      envelopes: ini.envelopes.filter((e) => e.granteeUserId === sub || (personId != null && e.granteePersonId === personId)),
      people: ini.people.filter((p) => p.key === sub),
      forecast: { ...withhold(ini.forecast, FORECAST_DOLLARS), items: ini.forecast.items.map((i) => withhold(i, ITEM_DOLLARS)) },
      runs: ini.runs,
      budgetAccess: budgetAccessLocked(),
    };
  }
  return out;
}

spendReportRouter.get('/report', asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  const groupBy = String(req.query['groupBy'] ?? 'initiative') as SpendGroupBy;
  if (!GROUP_BYS.includes(groupBy)) throw new ValidationError(`groupBy must be one of ${GROUP_BYS.join(', ')}`);
  const period = String(req.query['period'] ?? 'month') as ReportPeriod;
  if (!REPORT_PERIODS.includes(period)) throw new ValidationError(`period must be one of ${REPORT_PERIODS.join(', ')}`);
  const rawId = req.query['initiativeId'];
  const initiativeId = rawId == null || rawId === '' ? null : String(rawId).trim();
  if (initiativeId != null && !ID_RE.test(initiativeId)) throw new ValidationError('initiativeId is not a valid id');

  const report = await getSpendReport({ groupBy, period, initiativeId });
  res.set('Cache-Control', 'no-store');
  if (await canReadBudgets(session)) { res.json(report); return; }
  res.json(await shapeBelowTier(report, session.sub));
}));
