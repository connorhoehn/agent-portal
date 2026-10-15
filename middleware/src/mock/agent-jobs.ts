// The agent work queue — `agent_jobs`, offline.
//
// This was `MOCK_JOBS`, a bare module-level array inside
// providers/agent-jobs.ts, plus a second bare `Map` (`MOCK_CLAIM_TOKENS`) for
// the pull-side fencing tokens local workers hold across a claim. Both moved
// here for the reason the floor exists (docs/mock-floor.md): neither
// registered with the fixture registry, so `POST /api/__mock/reset` could not
// undo a claim, a start, a heartbeat, a completed run or a fresh enqueue —
// `mock/core/wire/write-policy.ts` refused the whole pull-side lifecycle as
// `unresettable`, and `_resetMockQueue()` existed only as a jest hook nothing
// in the control plane ever called. A dispatch left the world changed for
// whoever looked at it next, same as the bots/local-compute providers this
// module's siblings (`mock/bots.ts`, `mock/local-compute.ts`) already fixed
// for their own corners of the same surface.
//
// SEEDING. The seeded history is minted from bot runs, not typed twice: every
// `bot_runs` row that carries a `jobId` (`mock/bots.ts` `MOCK_BOT_RUNS`) gets a
// matching `agent_jobs` row here, so a "job →" link off a bot's run history
// always resolves instead of 404ing forever on `GET /api/work/jobs/:id`. Both
// fixtures are read live (`MOCK_BOTS`/`MOCK_BOT_RUNS` are themselves
// `liveRows`/`liveRecordView` projections — see `mock/bots.ts`), so this
// factory always seeds off whatever scenario the bots fixtures are
// currently resolving to.
//
// WHAT STAYS BEHIND. `deriveToolCallList`/`withToolCallList` and the
// `MOCK_TOOL_CYCLE` they read stay in providers/agent-jobs.ts — they are
// read-time projections over a job's `result`, not seed data, and the same
// function serves a real Aurora row exactly as it serves a mock one.
// `mockJobId`/`MOCK_STATUS_RANK`/`mockOrder` also stay there: they are
// id-minting and sort helpers the provider's own mock branches call, not rows
// a reset needs to restore.

import { defineFixture } from './core/index.js';
import { liveRows } from './live.js';
import { MOCK_BOTS, MOCK_BOT_RUNS } from './bots.js';
import type { BotRun } from '../providers/bots.js';
import type { AgentJob, JobStatus } from '../providers/agent-jobs.js';

/**
 * `BotRun.status` -> `AgentJob.status`. Every run `mock/bots.ts` seeds today
 * is `'done'`, but the mapping is written generically (not a single
 * hard-coded `'done'`) so a future `'failed'`/`'running'` fixture lands on the
 * right job state without anyone having to remember to update this file too.
 * `'skipped'` never reaches here in practice (a skipped firing never
 * dispatches, so the bot-run generator never gives it a `jobId`) but maps to
 * `'cancelled'` rather than silently defaulting to `'done'`.
 */
function jobStatusForRunStatus(status: BotRun['status']): JobStatus {
  switch (status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'skipped': return 'cancelled';
  }
}

/**
 * Mint a matching `agent_jobs` row for every seeded bot run that carries a
 * `jobId`, so the "job →" link on a bot's run history (BotDetailPage.tsx)
 * always resolves at `GET /api/work/jobs/:id` instead of 404ing forever —
 * `mock/bots.ts`'s run generator mints jobIds like `job-obs-maint-1` that no
 * job provider knew about before this fixture existed.
 *
 * Reads `MOCK_BOTS`/`MOCK_BOT_RUNS` directly — the SAME fixtures the bots
 * provider and BotDetailPage's run list use — rather than a second, hand-typed
 * list of ids, so the two cannot drift apart: a job's title/model/prompt
 * provenance genuinely comes from the bot that "ran" it, matching how a real
 * dispatch enqueues (`lib/bot-runner.ts` `fireBot`: kind `devbox:task`, title
 * is the bot's name, payload carries prompt/model/botId, `bot_id` column set).
 */
function previousOutcome(run: BotRun | undefined): string | null {
  const reason = run?.outcome['reason'];
  return typeof reason === 'string' && reason !== 'scheduled maintenance' ? reason : null;
}

function seedAgentJobs(): AgentJob[] {
  const jobs: AgentJob[] = [];
  for (const bot of MOCK_BOTS) {
    const history = MOCK_BOT_RUNS[bot.id] ?? [];
    for (const [index, run] of history.entries()) {
      if (!run.jobId || jobs.some((j) => j.id === run.jobId)) continue;
      const status = jobStatusForRunStatus(run.status);
      const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
      const durationMs = run.finishedAt
        ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
        : null;
      const reason = typeof run.outcome['reason'] === 'string' ? run.outcome['reason'] as string : 'scheduled maintenance';
      // A real dispatch is queued, claimed by a box, then started — never three
      // identical instants. Deterministic gaps from the job id keep a reset
      // stable while no two jobs share one.
      const spread = [...run.jobId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 9973, 7);
      const startMs = new Date(run.startedAt).getTime();
      const claimedAtIso = new Date(startMs - (3 + (spread % 22)) * 1000).toISOString();
      const createdAtIso = new Date(startMs - (3 + (spread % 22)) * 1000 - (12 + (spread % 97)) * 1000).toISOString();
      jobs.push({
        id: run.jobId,
        kind: 'devbox:task',
        title: bot.name,
        // The bot's mission plus what its previous firing left behind: a real
        // run starts from its predecessor's outcome, and a prompt that reads
        // differently each time is not one sentence copied across a dozen jobs.
        payload: { prompt: previousOutcome(history[index + 1]) ? `${bot.prompt} Previous run: ${previousOutcome(history[index + 1])}.` : bot.prompt, requiresReview: bot.requiresReview, botId: bot.id, model: bot.model },
        status,
        priority: 100,
        boxId: null,
        sessionId: null,
        attempts: terminal ? 1 : 0,
        // The seed writes max_attempts 1 on every scheduled job. Typing 2 here
        // made a one-shot job read as retryable offline, so the reaper's
        // "attempts 1/1 — exhausted" state was unreachable in dev:mock. New
        // jobs created at run time still default to 2 (`enqueueJob` in
        // providers/agent-jobs.ts); this is the seeded history, and it says 1.
        maxAttempts: 1,
        result: status === 'done'
          ? {
              summary: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
              costUsd: run.costUsd ?? undefined,
              durationMs: durationMs ?? undefined,
              // Pass the outcome's counts through when the seed recorded them —
              // the same two numbers a real run's outcome carries — so the
              // job reads "3 turns · 4 tool calls" and the tool-call strip
              // derives from a count instead of from nothing.
              ...(typeof run.outcome['turns'] === 'number' ? { turns: run.outcome['turns'] } : {}),
              ...(typeof run.outcome['toolCalls'] === 'number' ? { toolCalls: run.outcome['toolCalls'] } : {}),
            }
          : null,
        error: status === 'failed' ? reason : null,
        // Provenance, not a placeholder. A cron firing was minted by the
        // scheduler and nobody authorized it from inside an envelope — which
        // is why bot_runs.dispatched_by is null for one. `?? 'portal'` read
        // that null as "a person did this from the portal", so all nine
        // job-obs-maint-* rows claimed a human origin the seed spells
        // 'scheduler'; /iq/work then attributed scheduled maintenance to
        // someone's morning. Fall back per trigger, and only a genuinely
        // hand-driven run with no attribution column reads as 'portal'.
        createdBy: run.dispatchedBy ?? (run.trigger === 'cron' || run.trigger === 'pr_watch' ? 'scheduler' : 'portal'),
        createdAt: createdAtIso,
        claimedAt: claimedAtIso,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        botId: bot.id,
        botName: bot.name,
        botTrigger: run.trigger,
      });
    }
  }
  return jobs;
}

/**
 * The queue. `empty` — no history, no queued work: the state a Work page's
 * empty-queue copy is written for, and the one a seeded board can never show.
 */
export const agentJobs = defineFixture<AgentJob>({
  key: 'agent-jobs',
  scenarios: {
    default: seedAgentJobs,
    empty: () => [],
    // The queue is the Automate surface's whole subject, and "no jobs" and
    // "we could not read the jobs" are opposite facts a reader must be able
    // to tell apart — an empty queue means the fleet is idle, a failed read
    // means you do not know what the fleet is doing. Without this branch the
    // second state could not be reached on purpose.
    error: () => {
      throw new Error('agent_jobs unavailable: relation does not exist');
    },
  },
});

/**
 * Mock-mode fencing tokens for pull-side (local-compute) claims.
 *
 * NOT part of the `agentJobs` rows: a claim token is a secret the mock queue
 * never projects onto the wire (the real cluster never returns `claim_token`
 * off `SELECT` either — see `COLUMNS` in providers/agent-jobs.ts), so it lives
 * beside the rows rather than on them, exactly like `compute_nodes.token_hash`
 * lives beside — not inside — the `ComputeNode` shape in mock/local-compute.ts.
 * Wrapping `reset` below is what makes it resettable despite that: a Map has
 * no `rows()`/`reset()` of its own to register.
 */
export const MOCK_CLAIM_TOKENS = new Map<string, string>();

// Wrap the fixture's own `reset` so a claim token cannot outlive the rows it
// fences. Same idiom `routes/mock-control.ts` uses to pin a fixture's `rows` —
// the object `defineFixture` returns is a plain, mutable record, and the
// registry holds that exact reference, so patching a method on it here is
// visible to every future `registry.resetAll()` / `POST /api/__mock/reset`.
const baseReset = agentJobs.reset.bind(agentJobs);
agentJobs.reset = (scenario) => {
  MOCK_CLAIM_TOKENS.clear();
  baseReset(scenario);
};

/**
 * The queue, as an array, live — see `mock/live.ts`. Providers push, find and
 * mutate rows in place against this exactly as they did against the old
 * `MOCK_JOBS` literal; the difference is that every write now lands on the
 * fixture's own rows, so `POST /api/__mock/reset` (via the wrapped `reset`
 * above) puts the seed back.
 */
export const mockJobs: AgentJob[] = liveRows(agentJobs);
