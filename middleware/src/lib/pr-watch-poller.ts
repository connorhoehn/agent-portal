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
import { createBotRun } from '../providers/bots.js';
import { checkConcurrency, botMaxConcurrent } from './bot-runner.js';
import { listPulls, getPullStatus, type PullSummary } from './github-connector.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { firstLine } from './upstream.js';

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
    // No open PRs on the first poll baselines the watermark to 0, not null:
    // "never polled" and "polled, repo was quiet" are different states, and
    // leaving null meant the repo's very first PR arrived into a null-watermark
    // poll and was silently baselined over instead of dispatched.
    return { toDispatch: [], newWatermark: prs.length > 0 ? max : 0 };
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
  model: string;
  repoFullName: string;
  connectionName: string | null;
}

async function watchedBots(): Promise<WatchedBot[]> {
  const rows = await exec(
    `SELECT b.id, b.name, b.prompt_template, b.requires_review, b.pr_watermark,
            b.max_runs_per_day, b.budget_per_day_usd::float8 AS budget_per_day_usd,
            b.model, ap.repo_full_name, ap.connection_name
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
    model: toStr(r['model']),
    repoFullName: toStr(r['repo_full_name']),
    connectionName: r['connection_name'] == null ? null : toStr(r['connection_name']),
  }));
}

/** Same day window and skipped-run exclusion as the bot runner's brakes
 *  (providers/bots.js BOT_SELECT / todayStats). */
async function todayStats(botId: string): Promise<{ spendUsd: number; runCount: number }> {
  const rows = await exec(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend,
            COUNT(*) FILTER (WHERE status <> 'skipped')::int AS runs
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
      // model rides the payload so the job dispatcher runs the bot's configured
      // model, not its own default.
      s('payload', JSON.stringify({ prompt, requiresReview: bot.requiresReview, botId: bot.id, model: bot.model })),
    ],
  );
  const jobId = toStr(jobRows[0]?.['id']);
  // Through the provider's ceiling-guarded insert — the same atomic guard the
  // manual/cron/marketplace paths use, so a pr_watch dispatch cannot slip past
  // the global concurrency ceiling in a race.
  const run = await createBotRun({
    botId: bot.id, trigger: 'pr_watch', jobId, ceiling: botMaxConcurrent(),
    outcome: { prNumber: pr.number, prUrl: pr.url },
  });
  if (!run) {
    // Ceiling refused the row: un-enqueue the job so it does not run untracked,
    // and fail the dispatch — the watermark stays behind and retries next tick.
    await exec(`DELETE FROM agent_jobs WHERE id = :jid AND status = 'queued'`, [s('jid', jobId)]);
    throw new Error('concurrency ceiling reached');
  }
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
      // The global concurrency ceiling, per dispatch — the same brake every
      // other trigger path passes. On refuse: stop without advancing the
      // watermark (and without a skipped row per tick — the PRs are deferred,
      // not consumed) so a freed slot picks them up next tick.
      const congestion = await checkConcurrency();
      if (congestion.kind === 'refuse') {
        console.log(`[pr-watch] bot ${bot.id} deferred at PR #${pr.number}: ${congestion.reason}`);
        failed = true;
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

/**
 * Where the merge-scan cursor lands after a batch. Pure: a full batch means
 * more may remain — advance to the last row's updated_at; a short batch means
 * the backlog under scan is drained — wrap to the start (null) so the next
 * tick begins over. Without the cursor, a backlog larger than one batch made
 * the same first N ids eat every tick's GitHub quota while the rest starved.
 */
export function nextMergeCursor(
  batch: { count: number; lastUpdatedAt: string | null },
  limit: number,
): string | null {
  if (batch.count < limit) return null;
  return batch.lastUpdatedAt;
}

/** Module-state watermark over work_items.updated_at for the merge scan. */
let mergeCursor: string | null = null;

/** Test hook. */
export function _resetMergeCursor(): void { mergeCursor = null; }

/** The marketplace half: settle open-PR work items whose PR reached an end. */
async function settleMergedPrs(tokens: Map<string, string | null>): Promise<{ settled: number; errors: number }> {
  let settled = 0;
  let errors = 0;

  // The lateral picks one connection able to read the PR — and only from a
  // codebase whose repo actually matches the PR url's host+repo. Without the
  // match, any initiative-linked connection was used to poll whatever host the
  // pr_url named: quota burnt on repos nobody linked, and a poller that could
  // be pointed at attacker-chosen repos through a crafted pr_url.
  // Cursor: batches walk updated_at forward, wrapping when a batch comes up
  // short, so a deep backlog rotates through instead of starving the tail.
  const rows = await exec(
    `SELECT wi.id, wi.pr_url, wi.updated_at::text AS updated_at, conn.connection_name
       FROM work_items wi
       JOIN LATERAL (
         SELECT ap.connection_name
           FROM agent_projects ap
          WHERE ap.org_project_id = wi.project_id
            AND ap.connection_name IS NOT NULL
            AND wi.pr_url LIKE '%github.com/' || ap.repo_full_name || '/pull/%'
          LIMIT 1
       ) conn ON TRUE
      WHERE wi.pr_url IS NOT NULL AND wi.pr_status = 'open'
        AND wi.updated_at > :cursor::timestamptz
      ORDER BY wi.updated_at ASC
      LIMIT ${MERGE_SCAN_LIMIT}`,
    [s('cursor', mergeCursor ?? '1970-01-01T00:00:00Z')],
  );
  const lastUpdatedAt = rows.length > 0 ? toStr(rows[rows.length - 1]!['updated_at']) : null;
  mergeCursor = nextMergeCursor({ count: rows.length, lastUpdatedAt }, MERGE_SCAN_LIMIT);

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

// ─── Health ───────────────────────────────────────────────────────────────────
//
// WHY A POLLER NEEDS ITS OWN SHAPE. Everything else in this slice hands a
// caller an `Upstream<T>` and lets the caller decide (lib/upstream.ts). A
// poller has no caller. Nobody is waiting on `pollOnce`, there is no response
// to mark `degraded`, and the two per-item catches below already do the only
// sensible local thing — count the failure and move to the next repo, because
// one unreachable repository must not stop the other thirteen.
//
// So the question is not "how does it say it failed" but "who ever finds out",
// and the honest answer today was NOBODY:
//
//   * `runPollTick`'s catch wrote one `console.warn` and returned. A poller
//     that has thrown on every tick for a day and one with nothing to do are
//     both silent afterwards, because the success line is deliberately only
//     printed when work happened.
//   * `pollOnce`'s `errors` count was computed, printed, and dropped. There is
//     no counter, no last-run timestamp, nothing any surface could read to
//     answer "is PR watch actually running?".
//   * The per-tick warn is not actionable BECAUSE it repeats: a revoked GitHub
//     token produces an identical line every two minutes forever, which is how
//     a log line stops being read.
//
// Two things, then. A RECORDED STATE — in memory, deliberately: this poller's
// most likely failure is Aurora being unreachable, so a durable record would
// be written to the one place it cannot be written when it matters. And a log
// that ESCALATES: the first failure, then silence, then one line when a streak
// crosses the point where it is no longer a blip, then one line when it
// recovers. "It started working again" is the half nobody ever logs, and it is
// the half that tells you whether the thing you fixed was the thing.

/** After this many consecutive failed ticks, say so again — and say for how
 *  long. Eight ticks is ~16 minutes at the default cadence: past a token
 *  refresh, past a deploy, into "somebody should look". */
const FAILURE_STREAK_ALERT = 8;

export interface PrWatchHealth {
  /** Has the poller been started in this process at all? */
  running: boolean;
  /** When the last tick finished, whichever way it went. */
  lastTickAt: string | null;
  /** Did the last tick complete? Null before the first one. */
  lastTickOk: boolean | null;
  /** First line of the last thrown failure, and when. Kept after recovery so
   *  a reader can see what it was, paired with `consecutiveFailures: 0`. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Consecutive whole-tick failures. 0 means the last tick completed. */
  consecutiveFailures: number;
  /** Per-item failures inside the last completed tick — an unreachable repo or
   *  a borrow that failed. Distinct from a tick that threw. */
  lastTickItemErrors: number;
  dispatchedLastTick: number;
  settledLastTick: number;
}

const health: PrWatchHealth = {
  running: false,
  lastTickAt: null,
  lastTickOk: null,
  lastError: null,
  lastErrorAt: null,
  consecutiveFailures: 0,
  lastTickItemErrors: 0,
  dispatchedLastTick: 0,
  settledLastTick: 0,
};

/**
 * What the poller has actually been doing. A copy, so a reader cannot mutate
 * the record it is reading.
 *
 * Not wired to a route here on purpose: adding one changes the HTTP surface
 * and the wire snapshot, which is a separate decision from making the state
 * exist. The state is the part that was missing.
 */
export function prWatchHealth(): PrWatchHealth {
  return { ...health };
}

/** Test seam — forget everything, as a fresh process would. */
export function resetPrWatchHealth(): void {
  Object.assign(health, {
    running: false, lastTickAt: null, lastTickOk: null, lastError: null,
    lastErrorAt: null, consecutiveFailures: 0, lastTickItemErrors: 0,
    dispatchedLastTick: 0, settledLastTick: 0,
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _intervalHandle: NodeJS.Timeout | null = null;

/**
 * One tick, with the failure recorded rather than thrown away.
 *
 * Exported so the health record and the escalation rule can be tested without
 * waiting out a two-minute interval — the state machine is the point of this
 * section, and an untested state machine that only runs on a timer is a state
 * machine nobody has ever seen run.
 */
export async function runPollTick(): Promise<void> {
  try {
    const r = await pollOnce();
    const recovered = health.consecutiveFailures;
    const failedFor = recovered > 0 ? sinceFirstFailure() : null;
    Object.assign(health, {
      lastTickAt: new Date().toISOString(),
      lastTickOk: true,
      consecutiveFailures: 0,
      lastTickItemErrors: r.errors,
      dispatchedLastTick: r.dispatched,
      settledLastTick: r.settled,
    });
    if (recovered > 0) {
      // The recovery line. Without it the log's last word on this poller is
      // whatever went wrong, and a reader cannot tell a fixed problem from a
      // live one without waiting out another interval.
      console.log(`[pr-watch] recovered after ${recovered} failed tick(s)${failedFor ? ` over ${failedFor}` : ''}`);
    }
    // Log only when work happened — a quiet repo must not write a line every
    // two minutes.
    if (r.dispatched > 0 || r.settled > 0 || r.errors > 0) {
      console.log(`[pr-watch] dispatched ${r.dispatched} PR run(s), settled ${r.settled} work item(s), errors ${r.errors}`);
    }
  } catch (err) {
    noteTickFailure(err);
  }
}

let _firstFailureAtMs: number | null = null;

function sinceFirstFailure(): string | null {
  if (_firstFailureAtMs == null) return null;
  const mins = Math.round((Date.now() - _firstFailureAtMs) / 60_000);
  return mins >= 1 ? `${mins}m` : '<1m';
}

/**
 * Record a whole-tick failure, and decide whether to say anything.
 *
 * The first one is logged, because a first failure is news. The rest are not,
 * until the streak reaches FAILURE_STREAK_ALERT and then every multiple of it
 * — so a permanently broken poller re-states itself occasionally with the
 * streak length and elapsed time attached, instead of writing the same
 * contextless line 720 times a day.
 */
function noteTickFailure(err: unknown): void {
  const message = firstLine(err, 'poll failed');
  const now = new Date();
  health.consecutiveFailures++;
  if (health.consecutiveFailures === 1) _firstFailureAtMs = now.getTime();
  Object.assign(health, {
    lastTickAt: now.toISOString(),
    lastTickOk: false,
    lastError: message,
    lastErrorAt: now.toISOString(),
  });

  const n = health.consecutiveFailures;
  if (n === 1) {
    console.warn('[pr-watch] poll failed:', message);
  } else if (n % FAILURE_STREAK_ALERT === 0) {
    console.warn(
      `[pr-watch] poll has failed ${n} consecutive tick(s)${sinceFirstFailure() ? ` over ${sinceFirstFailure()}` : ''} — no PR has been dispatched or settled in that time. Last error: ${message}`,
    );
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
  setTimeout(() => { void runPollTick(); }, COLD_START_DELAY_MS).unref();

  _intervalHandle = setInterval(() => { void runPollTick(); }, intervalMs);
  _intervalHandle.unref();
  health.running = true;
}

/** Stop the background poller. Safe to call when not running. */
export function stopPrWatchPoller(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  health.running = false;
}
