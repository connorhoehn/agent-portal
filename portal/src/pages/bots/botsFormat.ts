// Pure derivations shared across the bots surfaces (list, wizard, detail).
// Nothing here is React — see `__tests__/botsFormat.test.ts`.

import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp.ts';
import type { Bot, BotRun } from './BotsPage';

// ─── List filtering ──────────────────────────────────────────────────────────

export type BotStatusFilter = 'all' | 'enabled' | 'paused';

/** Paused is either half: operator-disabled OR self-paused (budget). */
export function botIsPaused(bot: Pick<Bot, 'enabled' | 'pausedReason'>): boolean {
  return !bot.enabled || bot.pausedReason != null;
}

/** "5 bots" when nothing is filtered out, "2 of 5 bots match" once a search
 *  or status filter narrows the list — the count line above the table must
 *  track what the table is actually showing, not the unfiltered fetch
 *  (DEFECTS.md #9: searching a name that matched nothing still read "5 bots"
 *  over an empty table). */
export function botsSummaryLine(total: number, shown: number): string {
  const noun = total === 1 ? 'bot' : 'bots';
  if (shown === total) return `${total} ${noun}`;
  return `${shown} of ${total} ${noun} match`;
}

export function filterBots(bots: Bot[], opts: { search: string; status: BotStatusFilter }): Bot[] {
  const q = opts.search.trim().toLowerCase();
  return bots.filter((b) => {
    if (opts.status === 'enabled' && botIsPaused(b)) return false;
    if (opts.status === 'paused' && !botIsPaused(b)) return false;
    if (!q) return true;
    const haystack = [b.name, b.agentProjectRepo, b.orgProjectName].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// ─── FormField wiring ────────────────────────────────────────────────────────

/** What a FormField's render-prop wiring may be spread onto a native/library
 *  control. The library hands `labelId` along for controls that take
 *  `aria-labelledby`; spreading it onto a DOM input makes React warn "does
 *  not recognize the `labelId` prop" on every load. Keep the id + aria
 *  wiring, drop the label id. Same gap as `assessment/assessmentFormat.ts`'s
 *  `inputWiring`, duplicated locally — bots/** owns its own files. */
export function inputWiring<W extends { labelId: string }>(wiring: W): Omit<W, 'labelId'> {
  const { labelId: _labelId, ...rest } = wiring;
  void _labelId;
  return rest;
}

// ─── Wizard review step ──────────────────────────────────────────────────────

export interface Estimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
}

export function resolveTargetLabel(params: {
  targetKind: 'codebase' | 'initiative';
  agentProjectId: string;
  orgProjectId: string;
  projects: Array<{ id: string; repoFullName: string }>;
  orgProjects: Array<{ id: string; name: string }>;
}): string {
  if (params.targetKind === 'codebase') {
    return params.projects.find((p) => p.id === params.agentProjectId)?.repoFullName ?? '—';
  }
  return params.orgProjects.find((p) => p.id === params.orgProjectId)?.name ?? '—';
}

export function resolveModelLabel(modelId: string, models: Array<{ id: string; label: string }>): string {
  return models.find((m) => m.id === modelId)?.label ?? modelId;
}

export function budgetsSummaryText(params: {
  budgetPerRunUsd: string;
  budgetPerDayUsd: string;
  maxRunsPerDay: number;
}): string {
  const perRun = params.budgetPerRunUsd.trim() ? `$${Number(params.budgetPerRunUsd).toFixed(2)}/run` : 'no per-run cap';
  const perDay = params.budgetPerDayUsd.trim() ? `$${Number(params.budgetPerDayUsd).toFixed(2)}/day` : 'no daily cap';
  return `${perRun} · ${perDay} · max ${params.maxRunsPerDay}/day`;
}

export function reviewTriggerText(step4: { trigger: 'manual' | 'cron' | 'pr_watch'; cronExpr: string }): string {
  if (step4.trigger === 'cron') return `cron: ${step4.cronExpr}`;
  if (step4.trigger === 'pr_watch') return 'on new PRs (stored now, activates with the PR poller)';
  return 'manual';
}

// ─── Bot detail: run summary ────────────────────────────────────────────────
//
// DEFECTS.md program-owner #9: the detail page's header ("last ran 1h ago"),
// its guardrails footer ("today: 2/4 runs"), and its RUNS table ("This bot
// has never fired") each drew from a DIFFERENT source — `bot.lastRunAt` and
// `bot.todayRunCount` come off the bot record, the RUNS table off a separate
// `/api/bots/:id/runs` fetch — so a bot whose run history hasn't caught up to
// (or, in dev:mock, never populates alongside) its summary fields reads as a
// self-contradiction. Deriving both display facts from the SAME `runs` array
// the table already renders makes that impossible: no runs can never coexist
// with a "last ran" claim, in mock or in Aurora.

/** Parse an Aurora timestamp — naive ("2026-09-04 06:00:00") or zoned
 *  ("2026-09-04 06:00:00+00", whose `+00` is not a legal ISO offset) — or a
 *  proper ISO string, alike. This used to be a private copy of the same three
 *  lines every bots surface carried; they all now share `lib/pgTimestamp`,
 *  which is what stopped the `+00` case from being wrong in five places. */
function parseBotTs(iso: string): number {
  return parsePgTimestampAsUtc(iso)?.getTime() ?? Number.NaN;
}

/**
 * "Today" here means the SERVER'S day, not the browser's.
 *
 * This counted the viewer's local calendar day until 2026-09-08, and that is a
 * different day from the one the budget brake uses. `maxRunsPerDay` is enforced
 * in SQL against `r.started_at >= date_trunc('day', NOW())` on the cluster
 * (providers/bots.ts BOT_SELECT), i.e. UTC — so a bot with runs at 00:00Z and
 * 08:36Z has used 2 of its 4 for the purposes of the gate that will actually
 * refuse the third. Counted in New York the 00:00Z run falls on *yesterday*,
 * and the guardrails footer read "today: 1/4 run" beside a list row reading
 * "2/4 runs", understating how close the bot was to the cap for every viewer
 * west of UTC, every evening. Observed live on obs-nightly-maintenance.
 */
function isSameServerDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear()
    && da.getUTCMonth() === db.getUTCMonth()
    && da.getUTCDate() === db.getUTCDate();
}

export interface BotRunSummary {
  /** False when `runs` is empty — nothing here may say "last ran" anywhere
   *  on the page once this is false. */
  hasRun: boolean;
  /** ISO timestamp of the most recent run, or null when `hasRun` is false.
   *  Callers format it (e.g. with the shared `relativeTime()`) — this module
   *  stays string-in/string-out, no relative-time formatting of its own. */
  lastRunAt: string | null;
  /** Count of runs (any status) that started on the SERVER's current day —
   *  the same day boundary `maxRunsPerDay` is enforced against — counted from
   *  the SAME array, so the guardrails footer can neither claim runs the RUNS
   *  table doesn't show nor disagree with the cap that will refuse the next
   *  one. See `isSameServerDay`. */
  todayRunCount: number;
}

/** `runs` need not be pre-sorted — the newest `startedAt` wins regardless of
 *  input order, so a caller's existing sort (BotDetailPage already sorts
 *  newest-first for the table) is a convenience, not a requirement. */
export function botRunSummary(
  runs: Array<Pick<BotRun, 'startedAt'>>,
  now: Date = new Date(),
): BotRunSummary {
  if (runs.length === 0) return { hasRun: false, lastRunAt: null, todayRunCount: 0 };
  const nowMs = now.getTime();
  let newest = runs[0]!;
  let newestMs = parseBotTs(newest.startedAt);
  let todayRunCount = 0;
  for (const r of runs) {
    const ms = parseBotTs(r.startedAt);
    if (ms > newestMs) { newest = r; newestMs = ms; }
    if (isSameServerDay(ms, nowMs)) todayRunCount += 1;
  }
  return { hasRun: true, lastRunAt: newest.startedAt, todayRunCount };
}

/** The exact "last ran …" / "never fired" phrase both the list's "Last ran"
 *  column and the detail header's meta line render — one function, so the
 *  wording (and the definition of "has this bot run") can never diverge
 *  between the two surfaces (DEFECTS.md org-leader #20 / program-owner #9).
 *  `when` formats a resolved ISO timestamp into relative text (the shared
 *  `relativeTime` from `lib/relativeTime`, passed in rather than
 *  reimplemented here — this module stays framework-free).
 *
 *  Caveat this does NOT fix: `GET /api/bots` (the list) returns only each
 *  bot's own `lastRunAt` field, never a `runs` array — the list cannot
 *  literally feed this function the same evidence `GET /api/bots/:id/runs`
 *  gives the detail page. Reusing `botRunSummary` at least means both
 *  surfaces agree on what "no runs" means (empty array → 'never fired',
 *  not the looser 'never'), but when a bot's `lastRunAt` column is
 *  populated with no backing run row — which in dev:mock is every seeded
 *  bot, not only the one a given audit happened to open, because
 *  `listBotRuns()` unconditionally returns `[]` in mock while `MOCK_BOTS`
 *  bakes in a `lastRunAt` — the list will still read "last ran <time>"
 *  against a detail page reading "never fired". That mismatch is a
 *  middleware/mock-fixture bug (`middleware/src/providers/bots.ts`), not a
 *  wording or logic bug in these two pages, and is out of scope here. */
export function lastRanText(
  runs: Array<Pick<BotRun, 'startedAt'>>,
  when: (iso: string) => string,
  now?: Date,
): string {
  const summary = botRunSummary(runs, now);
  return summary.hasRun ? `last ran ${when(summary.lastRunAt!)}` : 'never fired';
}

/** The list-column variant of `lastRanText`: the list has no `runs` array,
 *  only the bot record's own `lastRunAt` — this wraps that single field in
 *  a one-element runs array so the SAME function (and so the same
 *  "never fired" wording) renders it. See `lastRanText`'s caveat: this
 *  narrows the *wording* gap between list and detail, not the underlying
 *  data gap for a bot whose `lastRunAt` is mock-fabricated. */
export function botListLastRanText(
  bot: Pick<Bot, 'lastRunAt'>,
  when: (iso: string) => string,
  now?: Date,
): string {
  return lastRanText(bot.lastRunAt ? [{ startedAt: bot.lastRunAt }] : [], when, now);
}

// ─── List rollup (StatStrip) ─────────────────────────────────────────────────

export interface BotsRollup {
  enabled: number;
  paused: number;
  spendTodayUsd: number;
  /** Sum of `budgetPerDayUsd` across bots that carry one. `null` when no bot
   *  in the fetched set has a daily budget set — the "of $N daily budget"
   *  hint has nothing true to say in that case, rather than claiming a $0
   *  budget across the fleet. */
  budgetTodayUsd: number | null;
  /** Bots at or above 80% of their own `budgetPerDayUsd` — the same
   *  threshold the per-row `ProgressBar` warns at (see the `budget` column). */
  nearBudgetCount: number;
}

/** Client-side aggregate over the fetched `bots[]` for the page's StatStrip.
 *  Pure and total: an empty roster returns all-zero counts and a null budget,
 *  never throws on an empty array. */
export function botsRollup(bots: Bot[]): BotsRollup {
  let enabled = 0;
  let paused = 0;
  let spendTodayUsd = 0;
  let budgetTodayUsd = 0;
  let hasBudget = false;
  let nearBudgetCount = 0;
  for (const bot of bots) {
    if (botIsPaused(bot)) paused += 1; else enabled += 1;
    spendTodayUsd += bot.todaySpendUsd;
    if (bot.budgetPerDayUsd != null) {
      hasBudget = true;
      budgetTodayUsd += bot.budgetPerDayUsd;
      if (bot.todaySpendUsd >= bot.budgetPerDayUsd * 0.8) nearBudgetCount += 1;
    }
  }
  return { enabled, paused, spendTodayUsd, budgetTodayUsd: hasBudget ? budgetTodayUsd : null, nearBudgetCount };
}

export function estimateSummaryText(params: {
  loading: boolean;
  error: string | null;
  estimate: Estimate | null;
}): string {
  if (params.loading) return 'estimating…';
  if (params.error) return `No estimate available (${params.error}).`;
  const e = params.estimate;
  if (!e) return '—';
  if (e.basis === 'prior') {
    return `No history yet — prior for this model tier, wide range: $${e.costUsdP25.toFixed(2)}–$${e.costUsdP75.toFixed(2)} · ${Math.round(e.minutesP25)}–${Math.round(e.minutesP75)} min`;
  }
  return `Similar runs: $${e.costUsdP25.toFixed(2)}–$${e.costUsdP75.toFixed(2)} · ${Math.round(e.minutesP25)}–${Math.round(e.minutesP75)} min · based on ${e.sampleCount} ${e.sampleCount === 1 ? 'run' : 'runs'} ${e.basis === 'repo' ? 'on this repo' : 'with this model'}`;
}
