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

import { listBoxes, appendEvent, isReserved, type FleetBox } from './devbox-fleet.js';

/** A scripted run. Delays are relative to the previous step. */
interface Step {
  afterMs: number;
  event: Record<string, unknown>;
}

/**
 * The agent CLI's own shape for a spoken line and a tool call.
 *
 * Helpers rather than hand-written objects because the shape is nested and
 * easy to approximate: an `assistant` event carries `message.content[]`, and a
 * flatter `{ type: 'assistant', text }` parses to NOTHING in the portal's tail
 * pane. The bot then appears to run in silence — the fixture looks right in
 * this file and the surface it feeds shows an empty pane. The library's
 * mockTail fixture had exactly that bug; a render test caught it there.
 */
const says = (text: string): Record<string, unknown> => ({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
});
const uses = (name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] },
});

/**
 * Model these scripted bot runs resolve to — the cheapest allowlisted model
 * (devboxModels.ts DEFAULT_DEVBOX_MODEL), since a maintenance cron bot has no
 * reason to reach for anything pricier. Kept as a literal here rather than
 * importing the portal's list: this file is middleware-only and the two are
 * already required to agree by the runtime's own allowlist.
 */
const MOCK_RUN_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Plausible input/output token counts for a scripted result — enough to
 *  move `tokensUsed`/`contextUsed` visibly without pretending to be exact. */
const usage = (inputTokens: number, outputTokens: number): { input_tokens: number; output_tokens: number } => ({
  input_tokens: inputTokens, output_tokens: outputTokens,
});

const JOBS: { title: string; prompt: string; steps: Step[] }[] = [
  {
    title: 'nightly-dependency-audit',
    prompt: 'Audit dependencies for advisories and open a change request for anything critical.',
    steps: [
      { afterMs: 900, event: says('Reading the lockfile and resolving the dependency graph.') },
      { afterMs: 1400, event: uses('Bash', { command: 'npm audit --json' }) },
      { afterMs: 2200, event: says('3 advisories: 1 high, 2 moderate. Checking whether the high one is reachable.') },
      { afterMs: 1800, event: uses('Grep', { pattern: 'serialize-javascript' }) },
      { afterMs: 2600, event: says('Reachable from the report renderer only. Bumping it and pinning the transitive.') },
      { afterMs: 1500, event: uses('Edit', { file: 'package.json' }) },
      { afterMs: 2400, event: { type: 'result', subtype: 'success', num_turns: 6, duration_ms: 12800, total_cost_usd: 0.0412, usage: usage(8400, 620), result: 'Bumped serialize-javascript to 6.0.2; the two moderates are dev-only and left alone.' } },
      { afterMs: 300, event: { type: 'devbox_end' } },
    ],
  },
  {
    title: 'flaky-test-triage',
    prompt: 'Find tests that failed intermittently this week and say why.',
    steps: [
      { afterMs: 800, event: says('Pulling the last 40 CI runs.') },
      { afterMs: 1600, event: uses('Bash', { command: 'gh run list --limit 40 --json conclusion,name' }) },
      { afterMs: 2400, event: says('Two suites flap: session-epoch and the canary rollup. Both look time-dependent.') },
      { afterMs: 2000, event: uses('Read', { file: 'src/lib/__tests__/session-epoch.test.ts' }) },
      { afterMs: 2800, event: says('session-epoch compares in whole seconds and the fixture straddles a boundary.') },
      { afterMs: 1900, event: { type: 'result', subtype: 'success', num_turns: 5, duration_ms: 11200, total_cost_usd: 0.0298, usage: usage(6100, 480), result: 'Both flakes are clock-boundary, not ordering. Wrote it up — want me to pin the clock in the fixtures?' } },
      { afterMs: 300, event: { type: 'devbox_end' } },
    ],
  },
  {
    title: 'schema-drift-check',
    prompt: 'Compare the deployed Aurora schema against schema/*.sql and report drift.',
    steps: [
      { afterMs: 900, event: says('Dumping the live schema.') },
      { afterMs: 1700, event: uses('Bash', { command: 'psql -c "\\\\d+ public.*"' }) },
      { afterMs: 2500, event: says('One table differs: environments has a column the checked-in DDL does not.') },
      { afterMs: 2100, event: { type: 'devbox_error', error: 'connection reset while reading pg_catalog — the cluster scaled down mid-query' } },
    ],
  },
];

/**
 * Play a scripted run for a DISPATCHED job, in the same vocabulary the cron
 * simulation uses — one fake-run dialect, not two.
 *
 * This exists because the dispatcher runs queue work through the exact path
 * the portal uses (`runDevboxTask`), and that path dead-ends offline with
 * "devbox runtime not deployed". Which meant the one journey the Work page is
 * FOR — pick a suggested card, queue it, watch it run — ended in a red
 * "job failed" banner on every offline machine. A journey that cannot ever
 * succeed in the environment people develop in reads as designed to fail.
 *
 * The steps are generic on purpose: this is a demo of the pipeline, not of
 * the task, so it narrates picking the work up and landing it rather than
 * pretending to know what the prompt means. The prompt's first line is
 * echoed so a tail reads coherently next to the job banner above it.
 */
export async function playDispatchedRun(opts: {
  title: string;
  prompt: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<{ summary: string; turns: number; durationMs: number; costUsd: number; toolCalls: number }> {
  const emit = (ev: Record<string, unknown>) =>
    opts.onEvent?.({ ...ev, ts: new Date().toISOString() });
  const firstLine = opts.prompt.split('\n')[0] ?? opts.title;
  const startedAt = Date.now();

  const steps: { afterMs: number; event: Record<string, unknown> }[] = [
    { afterMs: 400, event: { type: 'devbox_start', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' } },
    { afterMs: 900, event: says(`Picking up: ${firstLine.slice(0, 140)}`) },
    { afterMs: 1200, event: uses('Bash', { command: 'git status --short' }) },
    { afterMs: 1600, event: says('Workspace is clean. Reading the code this touches before changing anything.') },
    { afterMs: 1400, event: uses('Grep', { pattern: opts.title.split(' ')[0] ?? 'TODO' }) },
    { afterMs: 1800, event: uses('Read', { file: 'src/' }) },
    { afterMs: 2200, event: says('Found the relevant surface. Making the change and running the tests.') },
    { afterMs: 1500, event: uses('Edit', { file: 'src/' }) },
    { afterMs: 2000, event: uses('Bash', { command: 'npm test' }) },
  ];
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, step.afterMs));
    emit(step.event);
  }

  const durationMs = Date.now() - startedAt;
  const summary = `Done (simulated): ${opts.title}. The change is in the workspace with tests green; review the diff and open a change request if it holds.`;
  const result = {
    type: 'result', subtype: 'success', num_turns: 6,
    duration_ms: durationMs, total_cost_usd: 0.0341,
    usage: { input_tokens: 6200, output_tokens: 1900 },
    result: summary,
  };
  await new Promise((r) => setTimeout(r, 1800));
  emit(result);
  emit({ type: 'devbox_end' });
  return { summary, turns: 6, durationMs, costUsd: 0.0341, toolCalls: 5 };
}

const TICK_MS = 15_000;
/** Leave a gap after a run so a box is not permanently seized. */
const COOLDOWN_MS = 45_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastFinishedAt = 0;
let jobIndex = 0;

/**
 * Next idle box, round-robin rather than always the first.
 *
 * Always taking `[0]` meant every run landed on the same computer — and if
 * that one belongs to a session other than the person watching, the per-box
 * visibility rules hide it and the fixture looks broken while working
 * perfectly. Rotating means whoever is looking sees a run before long.
 */
function claimable(): FleetBox | null {
  // A reserved box is someone's (an open governed run, the demo's agents).
  const idle = listBoxes().filter((b) => b.status === 'idle' && !isReserved(b.id));
  if (idle.length === 0) return null;
  return idle[jobIndex % idle.length] ?? null;
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
  // Model announcement lives on task_started (rather than a separate
  // devbox_start event) because that is already the run-start event this
  // mock emits — devbox-fleet.ts's appendEvent reads `model` off either.
  appendEvent(box.id, {
    type: 'task_started', prompt: job.prompt, model: MOCK_RUN_MODEL, ts: new Date().toISOString(),
  });

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
  // MOCK_BOT_DEBUG=1 prints what the tick sees — the fastest way to tell
  // "no idle box" apart from "ran on one you cannot see".
  if (process.env['MOCK_BOT_DEBUG'] === '1') {
    console.log('[mock-bot] tick — boxes:', listBoxes().map((b) => `${b.id}:${b.status}`).join(',') || '(none)');
  }
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
