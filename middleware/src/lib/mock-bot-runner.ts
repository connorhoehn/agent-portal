// A simulated bot run, so "watch what a bot is doing" is developable offline.
//
// The scenario this exists for: a cron bot or the job dispatcher picks up an
// idle computer and runs `claude -p "…"` on it, and an SME opens the Computer
// Lab to tail the run — to see it happening rather than to drive it. Every
// piece of that already worked (the fleet's per-box event ring, the tail SSE,
// the lab's tail pane, the rail's activity list) and none of it could be
// exercised without a deployed runtime, because nothing offline ever put an
// event in the ring. The surface looked permanently empty and read as unbuilt.
//
// It claims an IDLE box rather than making its own, which is what the real
// dispatcher does (lib/job-dispatcher.ts) and what keeps this honest in two
// ways: the run appears on a computer the operator can already see, so the
// per-computer visibility rules need no exception; and it models the thing
// that is actually surprising in production — your box starts working and you
// did not start it.
//
// Only under MOCK_AGENTCORE. Set MOCK_BOT_RUNS=0 to silence it.

import { listBoxes, appendEvent, type FleetBox } from './devbox-fleet.js';

/** A scripted run. Delays are relative to the previous step. */
interface Step {
  afterMs: number;
  event: Record<string, unknown>;
}

const JOBS: { title: string; prompt: string; steps: Step[] }[] = [
  {
    title: 'nightly-dependency-audit',
    prompt: 'Audit dependencies for advisories and open a change request for anything critical.',
    steps: [
      { afterMs: 900, event: { type: 'assistant', text: 'Reading the lockfile and resolving the dependency graph.' } },
      { afterMs: 1400, event: { type: 'tool_use', name: 'Bash', input: { command: 'npm audit --json' } } },
      { afterMs: 2200, event: { type: 'assistant', text: '3 advisories: 1 high, 2 moderate. Checking whether the high one is reachable.' } },
      { afterMs: 1800, event: { type: 'tool_use', name: 'Grep', input: { pattern: 'serialize-javascript' } } },
      { afterMs: 2600, event: { type: 'assistant', text: 'Reachable from the report renderer only. Bumping it and pinning the transitive.' } },
      { afterMs: 1500, event: { type: 'tool_use', name: 'Edit', input: { file: 'package.json' } } },
      { afterMs: 2400, event: { type: 'result', subtype: 'success', num_turns: 6, duration_ms: 12800, total_cost_usd: 0.0412, result: 'Bumped serialize-javascript to 6.0.2; the two moderates are dev-only and left alone.' } },
      { afterMs: 300, event: { type: 'devbox_end' } },
    ],
  },
  {
    title: 'flaky-test-triage',
    prompt: 'Find tests that failed intermittently this week and say why.',
    steps: [
      { afterMs: 800, event: { type: 'assistant', text: 'Pulling the last 40 CI runs.' } },
      { afterMs: 1600, event: { type: 'tool_use', name: 'Bash', input: { command: 'gh run list --limit 40 --json conclusion,name' } } },
      { afterMs: 2400, event: { type: 'assistant', text: 'Two suites flap: session-epoch and the canary rollup. Both look time-dependent.' } },
      { afterMs: 2000, event: { type: 'tool_use', name: 'Read', input: { file: 'src/lib/__tests__/session-epoch.test.ts' } } },
      { afterMs: 2800, event: { type: 'assertion', text: 'session-epoch compares in whole seconds and the fixture straddles a boundary.' } },
      { afterMs: 1900, event: { type: 'result', subtype: 'success', num_turns: 5, duration_ms: 11200, total_cost_usd: 0.0298, result: 'Both flakes are clock-boundary, not ordering. Wrote it up — want me to pin the clock in the fixtures?' } },
      { afterMs: 300, event: { type: 'devbox_end' } },
    ],
  },
  {
    title: 'schema-drift-check',
    prompt: 'Compare the deployed Aurora schema against schema/*.sql and report drift.',
    steps: [
      { afterMs: 900, event: { type: 'assistant', text: 'Dumping the live schema.' } },
      { afterMs: 1700, event: { type: 'tool_use', name: 'Bash', input: { command: 'psql -c "\\\\d+ public.*"' } } },
      { afterMs: 2500, event: { type: 'assistant', text: 'One table differs: environments has a column the checked-in DDL does not.' } },
      { afterMs: 2100, event: { type: 'devbox_error', error: 'connection reset while reading pg_catalog — the cluster scaled down mid-query' } },
    ],
  },
];

const TICK_MS = 15_000;
/** Leave a gap after a run so a box is not permanently seized. */
const COOLDOWN_MS = 45_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastFinishedAt = 0;
let jobIndex = 0;

function claimable(): FleetBox | null {
  return listBoxes().find((b) => b.status === 'idle') ?? null;
}

/** Play one scripted run against `box`, pacing the events like a real stream. */
async function play(box: FleetBox): Promise<void> {
  const job = JOBS[jobIndex % JOBS.length]!;
  jobIndex += 1;

  // job_started first, so a tail explains WHY the box suddenly started working
  // — the same courtesy the real dispatcher extends.
  appendEvent(box.id, {
    type: 'job_started', jobId: `mock-${Date.now().toString(36)}`,
    title: job.title, kind: 'devbox:task', ts: new Date().toISOString(), mock: true,
  });
  appendEvent(box.id, { type: 'task_started', prompt: job.prompt, ts: new Date().toISOString() });

  for (const step of job.steps) {
    await new Promise((r) => setTimeout(r, step.afterMs));
    // The box can be removed mid-run; appendEvent no-ops on an unknown id, but
    // stopping early keeps the timeline honest for anyone still watching.
    if (!listBoxes().some((b) => b.id === box.id)) return;
    appendEvent(box.id, { ...step.event, ts: new Date().toISOString() });
  }

  appendEvent(box.id, {
    type: 'job_finished', title: job.title, ok: true, ts: new Date().toISOString(),
  });
}

async function tick(): Promise<void> {
  if (running) return;
  if (Date.now() - lastFinishedAt < COOLDOWN_MS) return;
  const box = claimable();
  if (!box) return;

  running = true;
  try {
    await play(box);
  } catch (err) {
    console.warn('[mock-bot] run failed:', (err as Error).message);
  } finally {
    running = false;
    lastFinishedAt = Date.now();
  }
}

/**
 * Start the simulated bot. No-op unless MOCK_AGENTCORE is on.
 *
 * Returns a stop function; the server does not currently use it, but a test
 * that starts this and never stops it leaks a timer into the next test.
 */
export function startMockBotRunner(): () => void {
  if (process.env['MOCK_AGENTCORE'] !== 'true') return () => {};
  if (process.env['MOCK_BOT_RUNS'] === '0') {
    console.log('[mock-bot] disabled (MOCK_BOT_RUNS=0)');
    return () => {};
  }
  console.log(`[mock-bot] simulating bot runs on idle computers every ${TICK_MS / 1000}s`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  // Do not hold the process open on its own account.
  timer.unref?.();
  return () => { if (timer) clearInterval(timer); timer = null; };
}

/** Test seam: run one tick now rather than waiting for the interval. */
export const _internal = { tick, play, claimable, JOBS };
