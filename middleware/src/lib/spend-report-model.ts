// The spend report's arithmetic (docs/budget-system-analysis-2026-10-28.md §3
// and §6 items 3 and 6; DE-53, DE-31's per-person view). Pure: no I/O, no
// clock reads, so the mock and the Aurora readers derive every figure the same
// way and a test can pin the instant.
//
// Three rules carried from the ledger:
//   - an unknown cost is counted, never summed as $0 (DE-30/DE-33);
//   - a burn rate is the trailing seven days' KNOWN spend over seven days;
//   - a projection is to the end of the budget period, whatever window the
//     rows were read over: the calendar month org-wide, and the initiative's
//     own period (DE-38, lib/budget-periods.ts) for a one-initiative report.

import { monthWindow } from './budget-periods.js';
import { ASSISTANT_NAME } from './meeting-assistant/chat-types.js';

export type SpendGroupBy = 'initiative' | 'actor' | 'model' | 'source' | 'trigger' | 'bot';
export type ReportPeriod = 'month' | '7d' | '30d';

export const GROUP_BYS: readonly SpendGroupBy[] = ['initiative', 'actor', 'model', 'source', 'trigger', 'bot'];
export const REPORT_PERIODS: readonly ReportPeriod[] = ['month', '7d', '30d'];

const DAY_MS = 86_400_000;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The instants one report is cut at. */
export interface ReportWindow {
  now: Date;
  /** Start of the selected period (`?period=`). */
  since: Date;
  /** Start of the budget period: the calendar month (UTC), or the one
   *  initiative's own window when the report is scoped to it (DE-38). */
  monthStart: Date;
  /** End of the budget period (exclusive). */
  monthEnd: Date;
  /** Seven days before `now` — the burn-rate window. */
  burnFrom: Date;
  /** The earliest of the three, so one read covers every figure. */
  readFrom: Date;
}

export function reportWindow(period: ReportPeriod, now: Date, budgetPeriod?: { start: Date; end: Date } | null): ReportWindow {
  const month = monthWindow(now);
  const monthStart = budgetPeriod?.start ?? month.start;
  const monthEnd = budgetPeriod?.end ?? month.end;
  const since = period === '7d' ? new Date(now.getTime() - 7 * DAY_MS)
    : period === '30d' ? new Date(now.getTime() - 30 * DAY_MS)
    : monthStart;
  const burnFrom = new Date(now.getTime() - 7 * DAY_MS);
  const readFrom = new Date(Math.min(since.getTime(), monthStart.getTime(), burnFrom.getTime()));
  return { now, since, monthStart, monthEnd, burnFrom, readFrom };
}

/** Days (fractional) between now and the end of the budget period. */
export function daysLeftInPeriod(w: Pick<ReportWindow, 'now' | 'monthEnd'>): number {
  return Math.max(0, (w.monthEnd.getTime() - w.now.getTime()) / DAY_MS);
}

/** One ledger row as the report needs it. */
export interface ReportEntry {
  initiativeId: string | null;
  actorId: string | null;
  model: string | null;
  source: string;
  trigger: string | null;
  /** Null = unknown. */
  costUsd: number | null;
  occurredAt: string;
  /** The bot this entry ties to through the bot-run join; null or absent = not from a bot. */
  botId?: string | null;
}

/** The group key an entry falls under. Null = unattributed (no initiative, no actor). */
export function groupKeyOf(e: ReportEntry, by: SpendGroupBy): string | null {
  switch (by) {
    case 'initiative': return e.initiativeId;
    case 'actor': return e.actorId;
    case 'model': return e.model ?? 'unknown';
    case 'source': return e.source;
    // A non-bot entry has no trigger; it groups by its source, as orgSummary's
    // `COALESCE(trigger, source)` does, so a box task is never "unknown trigger".
    case 'trigger': return e.trigger ?? e.source;
    case 'bot': return e.botId ?? null;
  }
}

/** The raw sums one group needs; the Aurora query returns exactly these. */
export interface RawGroup {
  key: string | null;
  /** Known dollars inside the selected period. */
  knownUsd: number;
  /** Entries inside the selected period with no recorded cost. */
  unknownCount: number;
  /** Entries inside the selected period. */
  entries: number;
  /** Known dollars since the start of the budget period. */
  monthToDateUsd: number;
  /** Known dollars over the trailing seven days. */
  last7dUsd: number;
}

/** Sum entries into raw groups — the mock analogue of the grouped SQL. */
export function aggregateEntries(entries: readonly ReportEntry[], by: SpendGroupBy, w: ReportWindow): RawGroup[] {
  const since = w.since.getTime();
  const month = w.monthStart.getTime();
  const burn = w.burnFrom.getTime();
  const now = w.now.getTime();
  const out = new Map<string | null, RawGroup>();
  for (const e of entries) {
    const at = Date.parse(e.occurredAt);
    if (!Number.isFinite(at) || at > now || at < w.readFrom.getTime()) continue;
    const key = groupKeyOf(e, by);
    const g = out.get(key) ?? { key, knownUsd: 0, unknownCount: 0, entries: 0, monthToDateUsd: 0, last7dUsd: 0 };
    if (at >= since) {
      g.entries++;
      if (e.costUsd == null) g.unknownCount++;
      else g.knownUsd += e.costUsd;
    }
    if (e.costUsd != null) {
      if (at >= month) g.monthToDateUsd += e.costUsd;
      if (at >= burn) g.last7dUsd += e.costUsd;
    }
    out.set(key, g);
  }
  return [...out.values()]
    .filter((g) => g.entries > 0 || g.monthToDateUsd > 0 || g.last7dUsd > 0)
    .map((g) => ({ ...g, knownUsd: round4(g.knownUsd), monthToDateUsd: round4(g.monthToDateUsd), last7dUsd: round4(g.last7dUsd) }));
}

/** The burn and projection every group (and the totals) carries. */
export interface Projection {
  /** Known spend over the trailing seven days, per day. */
  burnPerDay7d: number;
  /** Month-to-date known spend plus the burn rate over the days left in the period. */
  projectedPeriodEndUsd: number;
}

export function projectGroup(g: Pick<RawGroup, 'monthToDateUsd' | 'last7dUsd'>, w: ReportWindow): Projection {
  const burnPerDay7d = round4(g.last7dUsd / 7);
  return { burnPerDay7d, projectedPeriodEndUsd: round2(g.monthToDateUsd + burnPerDay7d * daysLeftInPeriod(w)) };
}

/** Sum raw groups (the report's totals row). */
export function totalOf(groups: readonly RawGroup[]): Omit<RawGroup, 'key'> {
  return {
    knownUsd: round4(groups.reduce((a, g) => a + g.knownUsd, 0)),
    unknownCount: groups.reduce((a, g) => a + g.unknownCount, 0),
    entries: groups.reduce((a, g) => a + g.entries, 0),
    monthToDateUsd: round4(groups.reduce((a, g) => a + g.monthToDateUsd, 0)),
    last7dUsd: round4(groups.reduce((a, g) => a + g.last7dUsd, 0)),
  };
}

/** A source id → the words a release manager reads. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  bot_run: 'Bot runs',
  job: 'Queued jobs',
  box_task: 'Box tasks',
  agent_loop: 'Agent loop',
  agent_project_run: 'Direct agent runs',
  bff_call: 'Platform model calls',
  meeting_assistant: 'Meeting assistant',
  interviews: 'Interviews',
};

// ─── The meeting assistant's rows (lib/meeting-assistant/spend.ts names their source ids) ──────────────

/**
 * What one meeting-assistant ledger row was, read from its source id: `ma:<call>` and `ma:<call>:x<part>` listening, `…:tokens` the
 * requests answered while listening, `ma:<call>:minutes` and `ma:<call>:minutes:<addition>:<try>` the minutes, `ma:<call>:watch:<n>`
 * a decision check. Null for anything else.
 */
export interface MeetingSpendRef { callId: string; kind: 'listening' | 'requests' | 'minutes' | 'watch'; part: number; addition: number; attempt: number }
export function meetingSpendRef(sourceId: string): MeetingSpendRef | null {
  const minutes = /^ma:(.+):minutes(?::(\d+):(\d+))?$/.exec(sourceId);
  if (minutes) return { callId: minutes[1]!, kind: 'minutes', part: 0, addition: Number(minutes[2] ?? 0), attempt: Number(minutes[3] ?? 1) };
  const watch = /^ma:(.+):watch:\d+$/.exec(sourceId);
  if (watch) return { callId: watch[1]!, kind: 'watch', part: 0, addition: 0, attempt: 1 };
  const listening = /^ma:(.+?)(?::x(\d+))?(:tokens)?$/.exec(sourceId);
  if (listening) return { callId: listening[1]!, kind: listening[3] ? 'requests' : 'listening', part: Number(listening[2] ?? 0), addition: 0, attempt: 1 };
  return null;
}

/**
 * Which period of Milo in the call a ledger part belongs to: the last period that began on that part or before it. `periods` are the
 * closed ones (each with the part it began on), `currentPart` the part the current period began on. Null when an older record did not
 * keep the parts (only part 0, the first period, is known then).
 */
export function periodOfPart(periods: ReadonlyArray<{ part?: number }>, currentPart: number | undefined, part: number): number | null {
  if (part === 0) return 1;
  if (periods.some((p) => typeof p.part !== 'number')) return null;
  const starts = [...periods.map((p) => p.part as number), periods.length ? currentPart ?? null : 0];
  if (starts[starts.length - 1] === null) return null;
  let period: number | null = null;
  for (const [i, s] of starts.entries()) if (s !== null && s <= part) period = i + 1;
  return period;
}

/**
 * The "What it was" words for a meeting-assistant row: "Milo listening" ("…, period 2" from the second period on), "Milo answering
 * requests", "Milo minutes" (", try 2" for a retry), "Milo minutes, addition 1", "Milo checking for decisions", then " · " and the call's
 * name when it is known.
 */
export function meetingSpendWhat(ref: MeetingSpendRef, ctx: { period: number | null; callName: string | null }): string {
  const period = ctx.period && ctx.period > 1 ? `, period ${ctx.period}` : '';
  const tried = ref.attempt > 1 ? `, try ${ref.attempt}` : '';
  const what = ref.kind === 'listening' ? `${ASSISTANT_NAME} listening${period}`
    : ref.kind === 'requests' ? `${ASSISTANT_NAME} answering requests${period}`
      : ref.kind === 'watch' ? `${ASSISTANT_NAME} checking for decisions`
        : ref.addition > 0 ? `${ASSISTANT_NAME} minutes, addition ${ref.addition}${tried}` : `${ASSISTANT_NAME} minutes${tried}`;
  return ctx.callName ? `${what} · ${ctx.callName}` : what;
}

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  cron: 'Scheduled',
  manual: 'Manual',
  marketplace: 'Marketplace',
  'pr-watch': 'PR watch',
  ...SOURCE_LABELS,
};

// ─── Open work against the discretionary remainder (§6 item 6) ──────────────

export type WorkPriority = 'critical' | 'high' | 'medium' | 'low';
const PRIORITY_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface OpenItemInput {
  id: string;
  key?: string | null;
  title: string;
  priority: string;
  storyPoints: number | null;
  createdAt: string;
  /** `work_items.estimate_model`. */
  estimateModel: string | null;
  /** `work_items.estimate_forecast` as stored. */
  estimateForecast: Record<string, unknown> | null;
  /** `work_items.estimated_cost_usd` — the $/point estimate, the fallback when no forecast was authorized. */
  estimatedCostUsd: number | null;
}

export type ForecastBasis = 'forecast' | 'estimate' | null;

export interface OpenItemFit {
  id: string;
  key: string | null;
  title: string;
  priority: string;
  storyPoints: number | null;
  model: string | null;
  p25Usd: number | null;
  p75Usd: number | null;
  /** `forecast` = the authorized forecast's p75; `estimate` = the stored $/point estimate; null = none. */
  basis: ForecastBasis;
  /** The p75 of every item ahead of this one in the queue. */
  aheadUsd: number;
  /**
   * p75 <= discretionary remaining minus the items ahead. Null when the item has
   * no forecast or the initiative has no allocation (nothing to fit against).
   */
  fitsRemaining: boolean | null;
}

function finite(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The p25/p75 an item carries, and what they rest on. */
export function itemForecast(i: OpenItemInput): { p25Usd: number | null; p75Usd: number | null; basis: ForecastBasis } {
  const p75 = finite(i.estimateForecast?.['costUsdP75']);
  if (p75 != null) return { p25Usd: finite(i.estimateForecast?.['costUsdP25']), p75Usd: p75, basis: 'forecast' };
  if (i.estimatedCostUsd != null && Number.isFinite(i.estimatedCostUsd)) return { p25Usd: null, p75Usd: i.estimatedCostUsd, basis: 'estimate' };
  return { p25Usd: null, p75Usd: null, basis: null };
}

/**
 * The queue order: priority (critical first), then the older item, then the id.
 * "Higher-priority" in the fit rule means "ahead in this order", so two
 * medium items do not both claim the same dollar.
 */
export function queueOrder(a: OpenItemInput, b: OpenItemInput): number {
  return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.id.localeCompare(b.id);
}

export function fitOpenItems(items: readonly OpenItemInput[], discretionaryRemainingUsd: number | null): OpenItemFit[] {
  let ahead = 0;
  return [...items].sort(queueOrder).map((i) => {
    const f = itemForecast(i);
    const aheadUsd = round2(ahead);
    const fitsRemaining = f.p75Usd == null || discretionaryRemainingUsd == null
      ? null
      : f.p75Usd <= discretionaryRemainingUsd - ahead + 1e-9;
    if (f.p75Usd != null) ahead += f.p75Usd;
    return {
      id: i.id, key: i.key ?? null, title: i.title, priority: i.priority, storyPoints: i.storyPoints,
      model: i.estimateModel, ...f, aheadUsd, fitsRemaining,
    };
  });
}

export interface ForecastSummary {
  p25Usd: number;
  p75Usd: number;
  /** Items with a stored forecast or estimate. */
  estimatedItems: number;
  /** Sized items with neither — money the totals cannot see. */
  unestimatedSizedItems: number;
  /** Items with no size and no estimate. */
  unsizedItems: number;
  /** One row per model, never blended: a Haiku estimate is not an Opus estimate. */
  models: Array<{ model: string | null; p25Usd: number; p75Usd: number; items: number }>;
  mixedModels: boolean;
}

export function summarizeForecast(fits: readonly OpenItemFit[]): ForecastSummary {
  const models = new Map<string | null, { model: string | null; p25Usd: number; p75Usd: number; items: number }>();
  let unestimatedSizedItems = 0;
  let unsizedItems = 0;
  for (const f of fits) {
    if (f.p75Usd == null) {
      if (f.storyPoints != null && f.storyPoints > 0) unestimatedSizedItems++; else unsizedItems++;
      continue;
    }
    const m = models.get(f.model) ?? { model: f.model, p25Usd: 0, p75Usd: 0, items: 0 };
    m.p25Usd += f.p25Usd ?? 0;
    m.p75Usd += f.p75Usd;
    m.items++;
    models.set(f.model, m);
  }
  const rows = [...models.values()].map((m) => ({ ...m, p25Usd: round2(m.p25Usd), p75Usd: round2(m.p75Usd) }))
    .sort((a, b) => b.p75Usd - a.p75Usd);
  return {
    p25Usd: round2(rows.reduce((a, m) => a + m.p25Usd, 0)),
    p75Usd: round2(rows.reduce((a, m) => a + m.p75Usd, 0)),
    estimatedItems: rows.reduce((a, m) => a + m.items, 0),
    unestimatedSizedItems,
    unsizedItems,
    models: rows,
    mixedModels: rows.filter((m) => m.model != null).length > 1,
  };
}

// ─── Run outcomes ───────────────────────────────────────────────────────────

export interface RunOutcomeInput {
  trigger: string;
  status: string;
  outcome: Record<string, unknown> | null;
}

export interface RunOutcomes {
  total: number;
  byStatus: { done: number; failed: number; skipped: number; running: number };
  byTrigger: Array<{ trigger: string; total: number; done: number; failed: number; skipped: number; running: number }>;
  /** Finished runs whose cost passed their per-run budget. */
  overRunBudget: number;
  /** Firings a money gate skipped (allocation, cap, reserve, envelope, user budget). */
  skippedForBudget: number;
}

const BUDGET_SKIP_RE = /budget|allocation|cap\b|reserve|envelope/i;

export function isBudgetSkip(r: RunOutcomeInput): boolean {
  if (r.status !== 'skipped') return false;
  if (r.outcome?.['gate'] != null) return true;
  return BUDGET_SKIP_RE.test(String(r.outcome?.['reason'] ?? ''));
}

export function summarizeRuns(runs: readonly RunOutcomeInput[]): RunOutcomes {
  const byStatus = { done: 0, failed: 0, skipped: 0, running: 0 };
  const triggers = new Map<string, RunOutcomes['byTrigger'][number]>();
  let overRunBudget = 0;
  let skippedForBudget = 0;
  for (const r of runs) {
    const status = (['done', 'failed', 'skipped', 'running'] as const).find((s) => s === r.status);
    const t = triggers.get(r.trigger) ?? { trigger: r.trigger, total: 0, done: 0, failed: 0, skipped: 0, running: 0 };
    t.total++;
    if (status) { byStatus[status]++; t[status]++; }
    triggers.set(r.trigger, t);
    if (r.outcome?.['overRunBudget'] === true) overRunBudget++;
    if (isBudgetSkip(r)) skippedForBudget++;
  }
  return {
    total: runs.length,
    byStatus,
    byTrigger: [...triggers.values()].sort((a, b) => b.total - a.total || a.trigger.localeCompare(b.trigger)),
    overRunBudget,
    skippedForBudget,
  };
}

// ─── The read tier ──────────────────────────────────────────────────────────

/** `obj` without `keys` — withheld means absent, never zero. */
export function withhold<T extends object, K extends string>(obj: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as Omit<T, K>;
}
