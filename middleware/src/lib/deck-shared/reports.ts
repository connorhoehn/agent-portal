// Charts filled from the app's own reports (docs/deck-edit-operations.md).
// Each report reads through the SAME provider function its own route calls,
// under the caller's own authority, and returns labels and series exactly as
// read: nothing is estimated or invented (docs/deck-builder-plan.md decision 1).
// The only change to the numbers is trimming to the chart kind's limits (a pie
// takes the top five and "Other"; a bar or line the top 23 and "Other"), which
// the summary says.
//
// Who may use each (the answer of its own route, asked fresh per request):
//   spend-by-initiative, spend-by-model   GET /api/spend/report: a signed-in orgiq
//       session; dollars only at the budgets read tier (lib/budget-read-tier.ts).
//       Below the tier the report is REFUSED (403), never charted without dollars.
//   runs-by-outcome   the same route's initiative block (`runs`): counts, any
//       signed-in orgiq session.
//   findings-by-severity   GET /api/work/findings/stats: any signed-in orgiq session.
//   jobs-by-status   GET /api/work/summary (`jobs`): any signed-in orgiq session.
// Every report belongs to the orgiq tenant; a deck of another tenant is offered none.

import type { Request } from 'express';
import { MAX_CHART_LABELS, MAX_PIE_SLICES, type DeckChart } from '@connorhoehn/realtime-modules/deck';
import { AppError } from '../async-handler.js';
import { resolveSession } from '../authz.js';
import { canReadBudgets } from '../budget-read-tier.js';
import { ADMIN_ROLE } from '../grant-rule.js';
import { REPORT_PERIODS, type ReportPeriod } from '../spend-report-model.js';
import type { Session } from '../session.js';
import type { DeckChartResolver, ResolvedChart } from './operations.js';
import type { DeckHostTenant } from './themes.js';
import type { Result } from './types.js';

export interface ReportParamSpec { name: string; required: boolean; description: string; values?: readonly string[] }

interface ReportData { title: string; labels: string[]; series: Array<{ name: string; values: number[] }>; period: string; sourceTitle: string }

interface ReportDef {
  id: string;
  tenant: DeckHostTenant;
  description: string;
  params: ReportParamSpec[];
  /** Shows dollars: refused below the budgets read tier. */
  money: boolean;
  /** Which chart kinds suit it (all four take any report; a pie needs one series). */
  read: (session: Session, params: Record<string, string>, ctx: ReportContext) => Promise<ReportData | null>;
}

export interface ReportContext {
  /** The deck's own initiative (orgiq decks), the default for `initiativeId`. */
  initiativeId?: string | null;
  now?: () => Date;
}

const PERIOD_PARAM: ReportParamSpec = { name: 'period', required: false, description: 'month (default), 7d or 30d', values: REPORT_PERIODS };
const PERIOD_WORDS: Record<ReportPeriod, string> = { month: 'this month', '7d': 'the last 7 days', '30d': 'the last 30 days' };
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const periodOf = (p: Record<string, string>): ReportPeriod => (p['period'] ?? 'month') as ReportPeriod;
const sourcesFor = (s: Session): 'all' | 'work' => (s.role === ADMIN_ROLE ? 'all' : 'work');
const cents = (n: number): number => Math.round(n * 100) / 100;

async function spendBy(groupBy: 'initiative' | 'model', session: Session, params: Record<string, string>): Promise<ReportData> {
  const { getSpendReport } = await import('../../providers/spend-report.js');
  const period = periodOf(params);
  const report = await getSpendReport({ groupBy, period, sources: sourcesFor(session) });
  const groups = [...report.groups].filter((g) => g.knownUsd > 0).sort((a, b) => b.knownUsd - a.knownUsd);
  const what = groupBy === 'initiative' ? 'initiative' : 'model';
  return {
    title: `Spend by ${what}, ${PERIOD_WORDS[period]}`,
    labels: groups.map((g) => g.label || (g.key ?? 'Unattributed')),
    series: [{ name: 'Spend (USD)', values: groups.map((g) => cents(g.knownUsd)) }],
    period: `${report.periodStart.slice(0, 10)} to ${report.periodEnd.slice(0, 10)}`,
    sourceTitle: `Spend report by ${what}`,
  };
}

export const DECK_REPORTS: readonly ReportDef[] = [
  {
    id: 'spend-by-initiative', tenant: 'orgiq', money: true, params: [PERIOD_PARAM],
    description: 'Known spend per initiative for the period, largest first, in US dollars.',
    read: (s, p) => spendBy('initiative', s, p),
  },
  {
    id: 'spend-by-model', tenant: 'orgiq', money: true, params: [PERIOD_PARAM],
    description: 'Known spend per model for the period, largest first, in US dollars.',
    read: (s, p) => spendBy('model', s, p),
  },
  {
    id: 'runs-by-outcome', tenant: 'orgiq', money: false,
    params: [{ name: 'initiativeId', required: false, description: "the initiative (default: this deck's own)" }, PERIOD_PARAM],
    description: "An initiative's agent runs for the period by outcome: done, failed, skipped, running.",
    read: async (s, p, ctx) => {
      const initiativeId = p['initiativeId'] ?? ctx.initiativeId ?? null;
      if (!initiativeId) return null;
      const { getSpendReport } = await import('../../providers/spend-report.js');
      const period = periodOf(p);
      const report = await getSpendReport({ groupBy: 'initiative', period, initiativeId, sources: sourcesFor(s) });
      const ini = report.initiative;
      if (!ini) return null;
      const b = ini.runs.byStatus;
      return {
        title: `Runs by outcome: ${ini.name}`,
        labels: ['Done', 'Failed', 'Skipped', 'Running'],
        series: [{ name: 'Runs', values: [b.done, b.failed, b.skipped, b.running] }],
        period: `since ${ini.runs.since.slice(0, 10)}`,
        sourceTitle: `Run outcomes for ${ini.name}`,
      };
    },
  },
  {
    id: 'findings-by-severity', tenant: 'orgiq', money: false, params: [],
    description: 'Open findings from the org sweeps, counted by severity.',
    read: async () => {
      const { findingStats } = await import('../../providers/org-sweeps.js');
      const bySeverity = new Map<string, number>();
      for (const row of await findingStats()) if (row.status === 'open') bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + row.n);
      const order = ['critical', 'warning', 'info'];
      const keys = [...bySeverity.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      return {
        title: 'Open findings by severity',
        labels: keys.map((k) => k.charAt(0).toUpperCase() + k.slice(1)),
        series: [{ name: 'Open findings', values: keys.map((k) => bySeverity.get(k)!) }],
        period: 'open now', sourceTitle: 'Findings by severity',
      };
    },
  },
  {
    id: 'jobs-by-status', tenant: 'orgiq', money: false, params: [],
    description: 'Agent jobs in the work queue, counted by status.',
    read: async () => {
      const { queueStats } = await import('../../providers/agent-jobs.js');
      const stats = await queueStats();
      const keys = (Object.keys(stats) as Array<keyof typeof stats>).filter((k) => k !== 'total' && stats[k] > 0);
      return {
        title: 'Agent jobs by status',
        labels: keys.map((k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())),
        series: [{ name: 'Jobs', values: keys.map((k) => stats[k]) }],
        period: 'now', sourceTitle: 'Work queue by status',
      };
    },
  },
];

/** The caller, or 401; another tenant's session (not the cross-tenant admin) is 403, as requireTenant answers. */
function callerFor(req: Request, tenant: DeckHostTenant): Session {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  if (session.tenant !== tenant && session.role !== ADMIN_ROLE) throw new AppError(403, `This report belongs to the ${tenant} tenant`);
  return session;
}

/** The reports a deck of `tenant` may chart, for this caller: money reports only at the budgets read tier. */
export async function listDeckReports(req: Request, tenant: DeckHostTenant): Promise<Array<{ id: string; description: string; params: ReportParamSpec[]; money: boolean }>> {
  const own = DECK_REPORTS.filter((r) => r.tenant === tenant);
  if (!own.length) return [];
  const session = callerFor(req, tenant);
  const dollars = await canReadBudgets(session);
  return own.filter((r) => !r.money || dollars).map((r) => ({ id: r.id, description: r.description, params: r.params, money: r.money }));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** When the figures were read, as a presenter reads it aloud: "Figures read 29 November 2026, 14:05 UTC". */
export function figuresReadAt(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `Figures read ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}
/** A speaker-notes line a report-filled chart wrote (this wording, or the earlier ISO one): replaced, never stacked. */
export const REPORT_NOTE_LINE = /^(Figures read |Chart data read from the )/;

/** Trims to what `kind` can show, folding the rest into "Other". Never invents a value. */
export function trimForChart(data: Pick<ReportData, 'labels' | 'series'>, kind: DeckChart['kind']): { labels: string[]; series: ReportData['series']; trimmed: string | null } {
  const cap = kind === 'pie' ? MAX_PIE_SLICES : MAX_CHART_LABELS;
  if (data.labels.length <= cap) return { labels: [...data.labels], series: data.series.map((s) => ({ name: s.name, values: [...s.values] })), trimmed: null };
  const keep = cap - 1;
  const sum = (vs: number[]) => Math.round(vs.reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    labels: [...data.labels.slice(0, keep), 'Other'],
    series: data.series.map((s) => ({ name: s.name, values: [...s.values.slice(0, keep), sum(s.values.slice(keep))] })),
    trimmed: `top ${keep} and Other`,
  };
}

function readParams(def: ReportDef, raw: unknown): Record<string, string> | string {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'params must be an object';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const spec = def.params.find((p) => p.name === k);
    if (!spec) return `${def.id} takes no parameter ${k}`;
    if (typeof v !== 'string' || !v) return `${k} must be a non-empty string`;
    if (spec.values && !spec.values.includes(v)) return `${k} must be one of ${spec.values.join(', ')}`;
    if (k === 'initiativeId' && !ID_RE.test(v)) return 'initiativeId is not a valid id';
    out[k] = v;
  }
  for (const p of def.params) if (p.required && !(p.name in out)) return `${def.id} needs ${p.name}`;
  return out;
}

/** The `set_chart` resolver for one request: the deck's tenant, the caller's session, the deck's initiative. */
export function deckChartResolver(req: Request, tenant: DeckHostTenant, ctx: ReportContext = {}): DeckChartResolver {
  return async (ref, kind): Promise<Result<ResolvedChart>> => {
    const def = DECK_REPORTS.find((r) => r.id === ref.report && r.tenant === tenant);
    if (!def) return { ok: false, status: 404, reason: `no report ${ref.report} for this deck` };
    const session = callerFor(req, tenant);
    if (def.money && !await canReadBudgets(session)) {
      throw new AppError(403, `${def.id} shows dollars, which you do not see at your budget read tier`);
    }
    const params = readParams(def, ref.params);
    if (typeof params === 'string') return { ok: false, status: 400, reason: params };
    const data = await def.read(session, params, ctx);
    if (!data) return { ok: false, status: 404, reason: `${def.id}: the initiative was not found` };
    if (!data.labels.length || data.series.every((s) => s.values.every((v) => v === 0))) {
      return { ok: false, status: 409, reason: `${def.id} has nothing to chart for ${data.period}` };
    }
    const fit = trimForChart(data, kind);
    const series = kind === 'pie' ? fit.series.slice(0, 1) : fit.series;
    const readAt = figuresReadAt((ctx.now ?? (() => new Date()))());
    return {
      ok: true,
      value: {
        chart: { kind, labels: fit.labels, series },
        source: { documentId: `report:${def.id}`, anchor: data.period.slice(0, 60), title: `${data.sourceTitle} (${data.period})`.slice(0, 200) },
        note: `${readAt} from the report "${data.title}"${fit.trimmed ? `, the ${fit.trimmed}` : ''}.`,
        summary: `${data.title} (${data.period}${fit.trimmed ? `, ${fit.trimmed}` : ''})`,
        title: data.title.slice(0, 120),
      },
    };
  };
}
