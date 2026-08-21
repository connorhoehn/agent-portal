// PR-watch bots + marketplace merge detection — the watermark poller.
//
// Two loops close here, both of which would want a GitHub webhook if the
// middleware had an HTTPS origin. It runs on a laptop, so both poll instead,
// on the pattern the CloudWatch trace poller (cw-trace-ingest.ts) proved out:
// an unref'd interval, a cursor that only advances past work actually handled,
// and logging only when something happened.
//
//   1. PR-watch triggers. Every enabled, un-paused bot with trigger='pr_watch'
//      watches its codebase's open pull requests. A PR number above the bot's
//      watermark is new: the poller dispatches a review run for it through the
//      agent_jobs queue — the same governed path every other bot run takes —
//      records a bot_run, and advances the watermark. The runner's brakes
//      (max runs/day, daily budget) apply identically here; a trigger that
//      fired and was braked is recorded as a skipped run, not a silent nothing.
//
//   2. Marketplace merge detection. A work item whose authorized run delivered
//      a PR sits at pr_status='open' until a human merges or closes it on
//      GitHub — an event nothing here observes. Each tick checks a bounded
//      batch of such items: merged → the story is done; closed-unmerged → the
//      work was declined, which must not be confused with delivered.
//
// The bots table is queried directly with exec() rather than through
// providers/bots.js — the bot CRUD surface is another workstream's; this
// poller needs only the trigger columns and owns only pr_watermark.
//
// BOT_PR_POLLER_DISABLED=1 is the kill switch; BOT_PR_POLL_INTERVAL_MS tunes
// the cadence (default 2 minutes — PR review is not latency-sensitive, and
// each tick spends GitHub API quota per watched repo).

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { borrowApiKey } from '../providers/connected-sources.js';
import { listPulls, getPullStatus, type PullSummary } from './github-connector.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function toBool(v: unknown): boolean { return v === true || v === 'true' || v === 1; }

const COLD_START_DELAY_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 120_000;

// Merge detection is bounded per tick so a backlog of open-PR work items can
// never turn one tick into hundreds of GitHub calls; the next tick takes the
// next batch.
const MERGE_SCAN_LIMIT = 50;

// ─── The watermark, pure ──────────────────────────────────────────────────────

/**
 * Which PRs to dispatch, and where the watermark lands afterwards.
 *
 * A null watermark means the bot has never polled: baseline at the current
 * maximum WITHOUT dispatching anything. Dispatching history would fire a
 * review run for every PR that was already open when the bot was created —
 * a burst of spend nobody asked for, on PRs the team already knows about.
 * The bot watches what happens from now on.
 *
 * Otherwise everything above the watermark dispatches, oldest first so runs
 * land in the order the PRs did, and the watermark moves to the highest
 * number seen. It never moves backwards — a PR list that momentarily omits
 * the newest PR (pagination, eventual consistency) must not re-open history.
 */
export function nextDispatchSet<T extends { number: number }>(
  prs: T[],
  watermark: number | null,
): { toDispatch: T[]; newWatermark: number | null } {
  const max = prs.reduce((m, p) => Math.max(m, p.number), watermark ?? 0);
  if (watermark == null) {
    return { toDispatch: [], newWatermark: prs.length > 0 ? max : null };
  }
  const toDispatch = prs
    .filter((p) => p.number > watermark)
    .sort((a, b) => a.number - b.number);
  return { toDispatch, newWatermark: max };
}

/** bots.pr_watermark is TEXT; anything unparseable reads as "never polled". */
export function parseWatermark(text: string | null): number | null {
  if (text == null || text.trim() === '') return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * owner/repo/number out of a GitHub PR url. Null for anything else — merge
 * detection skips what it cannot parse rather than guessing, since some
 * seeded work items carry mock PR links that point nowhere.
 */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  const number = Number.parseInt(m[3]!, 10);
  if (!Number.isFinite(number)) return null;
  return { owner: m[1]!, repo: m[2]!, number };
}

/** The review mission: the PR's identity + the bot's written mission. */
export function renderPrReviewPrompt(promptTemplate: string, pr: PullSummary): string {
  return [
    `A new pull request was opened on the repository you watch:`,
    `PR #${pr.number}: ${pr.title}`,
    `URL: ${pr.url}`,
    `Branch: ${pr.headRef} → ${pr.baseRef}`,
    '',
    promptTemplate,
  ].join('\n');
}

// ─── One tick ─────────────────────────────────────────────────────────────────

/**
 * One credential borrow per connection per tick, not per bot or work item.
 * A failed borrow caches null so a broken connection costs one warn, not N.
 */
async function tokenFor(cache: Map<string, string | null>, connectionName: string): Promise<string | null> {
  if (cache.has(connectionName)) return cache.get(connectionName) ?? null;
  try {
    const token = await borrowApiKey(connectionName);
    cache.set(connectionName, token);
    return token;
  } catch (err) {
    console.warn(`[pr-watch] could not borrow ${connectionName}:`, (err as Error).message);
    cache.set(connectionName, null);
    return null;
  }
}

interface WatchedBot {
  id: string;
  name: string;
  promptTemplate: string;
  requiresReview: boolean;
  prWatermark: string | null;
  maxRunsPerDay: number;
  budgetPerDayUsd: number | null;
  repoFullName: string;
  connectionName: string | null;
}

async function watchedBots(): Promise<WatchedBot[]> {
  const rows = await exec(
    `SELECT b.id, b.name, b.prompt_template, b.requires_review, b.pr_watermark,
            b.max_runs_per_day, b.budget_per_day_usd::float8 AS budget_per_day_usd,
            ap.repo_full_name, ap.connection_name
       FROM bots b
       JOIN agent_projects ap ON ap.id = b.agent_project_id
      WHERE b.enabled AND b.trigger = 'pr_watch' AND b.paused_reason IS NULL`,
  );
  return rows.map((r) => ({
    id: toStr(r['id']),
    name: toStr(r['name']),
    promptTemplate: toStr(r['prompt_template']),
    requiresReview: toBool(r['requires_review']),
    prWatermark: r['pr_watermark'] == null ? null : toStr(r['pr_watermark']),
    maxRunsPerDay: toNum(r['max_runs_per_day']),
    budgetPerDayUsd: r['budget_per_day_usd'] == null ? null : Number(r['budget_per_day_usd']),
    repoFullName: toStr(r['repo_full_name']),
    connectionName: r['connection_name'] == null ? null : toStr(r['connection_name']),
  }));
}

/** Same day window the bot runner's brakes use (providers/bots.js BOT_SELECT). */
async function todayStats(botId: string): Promise<{ spendUsd: number; runCount: number }> {
  const rows = await exec(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend, COUNT(*)::int AS runs
       FROM bot_runs
      WHERE bot_id = :bid::uuid AND started_at >= date_trunc('day', NOW())`,
    [s('bid', botId)],
  );
  return { spendUsd: toNum(rows[0]?.['spend']), runCount: toNum(rows[0]?.['runs']) };
}

async function recordSkippedRun(botId: string, outcome: Record<string, unknown>): Promise<void> {
  await exec(
    `INSERT INTO bot_runs (bot_id, trigger, status, outcome)
     VALUES (:bid::uuid, 'pr_watch', 'skipped', :outcome::jsonb)`,
    [s('bid', botId), s('outcome', JSON.stringify(outcome))],
  );
}

async function setWatermark(botId: string, watermark: number, ran: boolean): Promise<void> {
  await exec(
    `UPDATE bots SET pr_watermark = :wm, updated_at = NOW()${ran ? ', last_run_at = NOW()' : ''}
      WHERE id = :bid::uuid`,
    [s('bid', botId), s('wm', String(watermark))],
  );
}

/**
 * Dispatch one PR review through the queue path.
 *
 * The queue rather than fireBot: the bot runner is the manual/cron entry and
 * belongs to another workstream; this reuses the machinery below it. The job
 * dispatcher hands the prompt to an idle devbox, and requiresReview on the
 * payload parks the artifact at awaiting_review exactly as initiative-target
 * bot runs do — a PR-watch run gains no ungoverned path.
 */
async function dispatchPrRun(bot: WatchedBot, pr: PullSummary): Promise<void> {
  const prompt = renderPrReviewPrompt(bot.promptTemplate, pr);
  const jobRows = await exec(
    `INSERT INTO agent_jobs (kind, title, payload, created_by)
     VALUES ('devbox:task', :title, :payload::jsonb, 'pr-watch') RETURNING id`,
    [
      s('title', `PR #${pr.number}: ${pr.title}`.slice(0, 300)),
      s('payload', JSON.stringify({ prompt, requiresReview: bot.requiresReview, botId: bot.id })),
    ],
  );
  const jobId = toStr(jobRows[0]?.['id']);
  await exec(
    `INSERT INTO bot_runs (bot_id, trigger, job_id, status, outcome)
     VALUES (:bid::uuid, 'pr_watch', :jid, 'running', :outcome::jsonb)`,
    [s('bid', bot.id), s('jid', jobId),
      s('outcome', JSON.stringify({ prNumber: pr.number, prUrl: pr.url }))],
  );
}

/** The PR-watch half of a tick: one bot at a time, brakes per dispatch. */
async function pollWatchedBots(tokens: Map<string, string | null>): Promise<{ dispatched: number; errors: number }> {
  let dispatched = 0;
  let errors = 0;

  for (const bot of await watchedBots()) {
    if (!bot.connectionName) {
      console.warn(`[pr-watch] bot ${bot.id} "${bot.name}" watches ${bot.repoFullName} with no connection — skipping`);
      continue;
    }
    const token = await tokenFor(tokens, bot.connectionName);
    if (!token) { errors++; continue; }

    let pulls: PullSummary[];
    try {
      pulls = await listPulls(token, bot.repoFullName, { state: 'open' });
    } catch (err) {
      console.warn(`[pr-watch] listPulls failed for ${bot.repoFullName}:`, (err as Error).message);
      errors++;
      continue;
    }

    const watermark = parseWatermark(bot.prWatermark);
    const { toDispatch, newWatermark } = nextDispatchSet(pulls, watermark);

    // First poll: baseline the watermark at the current max and dispatch
    // nothing — see nextDispatchSet. Not last_run_at: the bot did not run.
    if (watermark == null) {
      if (newWatermark != null) await setWatermark(bot.id, newWatermark, false);
      continue;
    }
    if (toDispatch.length === 0) continue;

    // The runner's brakes, same ordering as decideFire: the run cap first
    // (independent of cost, so a mispriced model cannot defeat it), then the
    // daily budget — the only brake that flips the bot's own state.
    const stats = await todayStats(bot.id);
    if (bot.budgetPerDayUsd != null && stats.spendUsd >= bot.budgetPerDayUsd) {
      // Pause and do NOT advance the watermark: pausing removes the bot from
      // the next tick's query, so nothing spams, and resuming re-delivers the
      // PRs that arrived while the budget held it — spend deferred, not lost.
      await recordSkippedRun(bot.id, {
        reason: 'daily budget reached',
        prNumbers: toDispatch.map((p) => p.number),
      });
      await exec(
        `UPDATE bots SET paused_reason = 'daily budget reached', updated_at = NOW() WHERE id = :bid::uuid`,
        [s('bid', bot.id)],
      );
      console.log(`[pr-watch] bot ${bot.id} "${bot.name}" paused: daily budget reached`);
      continue;
    }

    let runsToday = stats.runCount;
    let current = watermark;
    let failed = false;
    for (const pr of toDispatch) {
      if (runsToday >= bot.maxRunsPerDay) {
        // Cap reached mid-batch: record one skipped run naming the rest; the
        // watermark still advances past them (below). Leaving it behind would
        // re-skip the same PRs every tick until midnight — hundreds of rows
        // for one event. Like a braked cron firing, the trigger is consumed;
        // the visible skipped run is the record that it happened.
        await recordSkippedRun(bot.id, {
          reason: `max runs per day reached (${bot.maxRunsPerDay})`,
          prNumbers: toDispatch.filter((p) => p.number >= pr.number).map((p) => p.number),
        });
        break;
      }
      try {
        await dispatchPrRun(bot, pr);
      } catch (err) {
        console.warn(`[pr-watch] dispatch failed for ${bot.repoFullName}#${pr.number}:`, (err as Error).message);
        errors++;
        failed = true;
        break;
      }
      // Advance per dispatch, not per tick, so a crash mid-batch cannot
      // re-dispatch the PRs that already got their run.
      await setWatermark(bot.id, pr.number, true);
      current = pr.number;
      runsToday++;
      dispatched++;
    }
    // Land on the batch's max — covers the cap-skip remainder. Never after a
    // dispatch failure: the watermark stays at the last success so the failed
    // PR retries next tick.
    if (!failed && newWatermark != null && newWatermark > current) {
      await setWatermark(bot.id, newWatermark, current > watermark);
    }
  }

  return { dispatched, errors };
}

/** The marketplace half: settle open-PR work items whose PR reached an end. */
async function settleMergedPrs(tokens: Map<string, string | null>): Promise<{ settled: number; errors: number }> {
  let settled = 0;
  let errors = 0;

  // DISTINCT ON: an initiative can have several linked codebases, and any of
  // their connections can read the PR — one row per work item is enough.
  const rows = await exec(
    `SELECT DISTINCT ON (wi.id) wi.id, wi.pr_url, ap.connection_name
       FROM work_items wi
       JOIN agent_projects ap ON ap.org_project_id = wi.project_id
      WHERE wi.pr_url IS NOT NULL AND wi.pr_status = 'open'
        AND ap.connection_name IS NOT NULL
      ORDER BY wi.id
      LIMIT ${MERGE_SCAN_LIMIT}`,
  );

  for (const row of rows) {
    const id = toStr(row['id']);
    const parsed = parsePrUrl(toStr(row['pr_url']));
    if (!parsed) continue; // seeded/mock PR link — nothing to poll
    const token = await tokenFor(tokens, toStr(row['connection_name']));
    if (!token) { errors++; continue; }

    let status: Awaited<ReturnType<typeof getPullStatus>>;
    try {
      status = await getPullStatus(token, `${parsed.owner}/${parsed.repo}`, parsed.number);
    } catch (err) {
      console.warn(`[pr-watch] getPullStatus failed for ${toStr(row['pr_url'])}:`, (err as Error).message);
      errors++;
      continue;
    }
    if (status.state !== 'closed') continue;

    if (status.merged) {
      // The marketplace's closing step: the PR landing is what "done" means
      // for authorized work — the outcome reached the codebase.
      await exec(
        `UPDATE work_items
            SET pr_status = 'merged', status = 'done', completed_at = NOW(), updated_at = NOW()
          WHERE id = :id`,
        [s('id', id)],
      );
    } else {
      // Closed without merging is declined, not delivered — the work item
      // stays in its current status for a human to re-route.
      await exec(
        `UPDATE work_items SET pr_status = 'closed', updated_at = NOW() WHERE id = :id`,
        [s('id', id)],
      );
    }
    settled++;
  }

  return { settled, errors };
}

export async function pollOnce(): Promise<{ dispatched: number; settled: number; errors: number }> {
  // One borrow per connection per tick, shared across both halves.
  const tokens = new Map<string, string | null>();
  const watch = await pollWatchedBots(tokens);
  const merge = await settleMergedPrs(tokens);
  return {
    dispatched: watch.dispatched,
    settled: merge.settled,
    errors: watch.errors + merge.errors,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _intervalHandle: NodeJS.Timeout | null = null;

async function safePoll(): Promise<void> {
  try {
    const r = await pollOnce();
    // Log only when work happened — a quiet repo must not write a line every
    // two minutes.
    if (r.dispatched > 0 || r.settled > 0 || r.errors > 0) {
      console.log(`[pr-watch] dispatched ${r.dispatched} PR run(s), settled ${r.settled} work item(s), errors ${r.errors}`);
    }
  } catch (err) {
    console.warn('[pr-watch] poll failed:', (err as Error).message);
  }
}

/**
 * Start the background PR poller. Idempotent — calling twice is a no-op.
 *
 * Honours BOT_PR_POLLER_DISABLED=1 as a kill switch, and stands down in mock
 * mode — there is no bots table to watch and no vault to borrow from.
 */
export function startPrWatchPoller(): void {
  if (_intervalHandle) return;
  if (process.env['BOT_PR_POLLER_DISABLED'] === '1') {
    console.log('[pr-watch] BOT_PR_POLLER_DISABLED=1 — skipping start');
    return;
  }
  if (config.mock.aurora) {
    console.log('[pr-watch] skipped (mock aurora)');
    return;
  }

  const intervalMs = toNum(process.env['BOT_PR_POLL_INTERVAL_MS']) || DEFAULT_POLL_INTERVAL_MS;
  console.log(`[pr-watch] starting PR poller, interval ${intervalMs / 1000}s`);

  // Cold-start poll after a short delay rather than immediately: GitHub and
  // the credential vault are not on boot's critical path, and the delay lets
  // schema loading and the schedulers settle first.
  setTimeout(() => { void safePoll(); }, COLD_START_DELAY_MS).unref();

  _intervalHandle = setInterval(() => { void safePoll(); }, intervalMs);
  _intervalHandle.unref();
}

/** Stop the background poller. Safe to call when not running. */
export function stopPrWatchPoller(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
