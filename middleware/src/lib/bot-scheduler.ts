// Bot scheduler — the third node-cron registry, and the only Aurora-backed one.
//
// The ingest and crawl registries persist to JSON files because their entries
// are middleware configuration. Bots are product data with budgets and an
// audit trail, so Aurora is the source of truth and this module holds only the
// live cron tasks — re-registered from the bots table on boot, and kept in
// step by the CRUD routes calling registerBot/unregisterBot.
//
// Laptop-middleware honesty: in-process cron misses firings while the process
// is down. The catch-up pass below runs a stale cron bot once shortly after
// boot — once, never N times, and through fireBot so every brake still applies.
//
// This is also the home of the one background loop for bots: reconciliation
// (settling finished runs/jobs back onto bot_runs) piggybacks here rather than
// growing a second timer.

import cron from 'node-cron';
import { config } from '../config.js';
import { listBots, type Bot } from '../providers/bots.js';
import { fireBot, reconcileBotRuns, sweepOrphanedRuns } from './bot-runner.js';
import { validateCronExpr } from './ingest-scheduler.js';

const tasks = new Map<string, cron.ScheduledTask>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let inited = false;

const RECONCILE_INTERVAL_MS = 30_000;
const CATCH_UP_DELAY_MS = 20_000;

/**
 * Whether a cron bot that was asleep with the process should fire once at boot.
 *
 * The rule, deliberately simple: fire-once when the bot has never run, or when
 * its last run is older than 24 hours. Inferring each expression's true
 * cadence would catch missed sub-daily firings too, but a wrong inference
 * double-fires — and fireBot's max-runs/budget brakes make the conservative
 * rule safe while the loud "last ran" on the roster makes staleness visible.
 */
export function shouldCatchUp(lastRunAt: string | null, now: Date = new Date()): boolean {
  if (!lastRunAt) return true;
  const last = parseRdsTimestamp(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > 24 * 60 * 60 * 1000;
}

/**
 * Parse a timestamp that may arrive in RDS Data API form. Postgres renders
 * timestamps as 'YYYY-MM-DD HH:MM:SS[.fff]' — no 'T', often no zone — and
 * Date.parse reads that as LOCAL time, shifting every stored UTC instant by
 * the host's offset (a bot could look up-to-a-day staler or fresher than it
 * is). The values are UTC, so normalise to ISO and pin the zone when the
 * string carries none.
 */
export function parseRdsTimestamp(ts: string): number {
  let iso = ts.trim();
  if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
  // Postgres renders a bare-hour offset ('+00'); Date.parse needs '+00:00'.
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  // Append Z only when no zone designator is present ('...Z', '...+00:00').
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso = `${iso}Z`;
  return Date.parse(iso);
}

/**
 * (Re-)register a bot's cron task. Anything that is not an enabled cron bot
 * with a valid expression just clears any existing task — which is how a PATCH
 * to manual, a disable, or a pr_watch bot (stored, polled in a later phase,
 * never cron-scheduled) all fall out of the registry without special cases.
 */
export function registerBot(bot: Bot): void {
  unregisterBot(bot.id);
  if (!bot.enabled || bot.trigger !== 'cron') return;
  if (!bot.cronExpr || !validateCronExpr(bot.cronExpr)) return;
  const task = cron.schedule(bot.cronExpr, () => {
    console.log(`[bots] cron firing ${bot.id} "${bot.name}"`);
    void fireBot(bot.id, { trigger: 'cron' })
      .then((r) => { if (!r.ok) console.log(`[bots] ${bot.id} did not run: ${r.reason}`); })
      .catch((err: unknown) => console.warn(`[bots] cron fire failed for ${bot.id}:`, (err as Error).message));
  }, { scheduled: true, timezone: 'UTC' });
  tasks.set(bot.id, task);
}

export function unregisterBot(botId: string): void {
  tasks.get(botId)?.stop();
  tasks.delete(botId);
}

export async function initBotScheduler(): Promise<void> {
  if (inited) return;
  inited = true;
  if (config.mock.aurora) {
    console.log('[bots] scheduler skipped (mock aurora)');
    return;
  }

  // Boot sweep BEFORE anything is scheduled: in-process runs cannot survive a
  // restart, so agent_project_runs still 'running' from a previous process are
  // failed here, and one reconcile pass settles the bot_runs (and work items)
  // they back — freeing their concurrency slots before the first firing.
  try {
    await sweepOrphanedRuns();
    await reconcileBotRuns();
  } catch (err) {
    // A missing table (schema not yet loaded) must not take boot down.
    console.warn('[bots] boot sweep failed:', (err as Error).message);
  }

  let bots: Bot[] = [];
  try {
    bots = await listBots();
  } catch (err) {
    // A missing bots table (schema not yet loaded) must not take boot down.
    console.warn('[bots] scheduler init failed:', (err as Error).message);
    return;
  }

  const cronBots = bots.filter((b) => b.enabled && b.trigger === 'cron' && b.cronExpr && validateCronExpr(b.cronExpr));
  for (const b of cronBots) registerBot(b);
  console.log(`[bots] scheduled ${cronBots.length} cron bot(s) of ${bots.length}`);

  // Catch-up-once: fired from this single boot-time snapshot, so a bot can
  // never be caught up twice — and via fireBot, so the brakes still apply.
  const stale = cronBots.filter((b) => shouldCatchUp(b.lastRunAt));
  if (stale.length > 0) {
    console.log(`[bots] ${stale.length} cron bot(s) missed their schedule while down — catch-up in ${CATCH_UP_DELAY_MS / 1000}s`);
    setTimeout(() => {
      for (const b of stale) {
        void fireBot(b.id, { trigger: 'cron' })
          .catch((err: unknown) => console.warn(`[bots] catch-up failed for ${b.id}:`, (err as Error).message));
      }
    }, CATCH_UP_DELAY_MS).unref();
  }

  reconcileTimer = setInterval(() => {
    void reconcileBotRuns()
      .then(({ settled }) => { if (settled > 0) console.log(`[bots] reconciled ${settled} finished run(s)`); })
      .catch((err: unknown) => console.warn('[bots] reconcile failed:', (err as Error).message));
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

/** Test hook — stop every task and timer so a process can exit cleanly. */
export function stopBotScheduler(): void {
  for (const id of [...tasks.keys()]) unregisterBot(id);
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  inited = false;
}
