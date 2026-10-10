// What each offline computer has been doing — the event log its tail replays.
//
// WHY THIS EXISTS. `GET /api/devbox/boxes/:id/tail` replays the box's event
// buffer (lib/devbox-fleet.ts `replayEvents`) and then streams new events. The
// buffer is filled only by runs that pass through this process, so in dev:mock
// every seeded box tailed NOTHING: the Computer Lab's Bot logs and Agent panes
// opened on "waiting for output" for a box whose row says it is mid-task, and
// a box that "needs you" could not show the question it asked. That is
// contract.ts rule 4 in a quieter form — a seeded surface that looks unbuilt.
//
// WHAT IS SEEDED. One run per box, told by the box row itself: the prompt is
// the row's `currentTask`, the model is its `activeModel`, and a finished
// box's `result` frame is built from its `lastResult` — never a second copy of
// those numbers (contract rule 1). A running box ends mid-run (no result); the
// waiting box ends on the question its task line asks; the dispatcher's box is
// a job, bracketed by `job_started` / `job_finished` the way bot-runner frames
// one.
//
// WIRE SHAPES are copied from the producers, not typed from memory (rule 2):
// `task_started` from routes/devbox.ts `runTaskAndForward`, nested
// `assistant.message.content[]` blocks and `result` from lib/mock-bot-runner.ts
// (which notes that a flat `{type:'assistant', text}` parses to nothing in the
// tail), `job_started`/`job_finished` from lib/bot-runner.ts.
//
// Seeding goes through `seedEventLog`, which fills the buffer WITHOUT running
// the status machine — replaying these through `appendEvent` would flip every
// box to running and accrue its tokens twice. Every timestamp comes from the
// clock (rule 3).

import { clock, defineFixture } from './core/index.js';
import { devboxBoxes, provisioningTaskFor } from './devbox-fleet.js';
import { appendEvent, listBoxes, type FleetBox, type FleetEvent } from '../lib/devbox-fleet.js';

export interface SeededTail {
  boxId: string;
  events: FleetEvent[];
}

/** A tool call, as the runtime streams it. */
const tool = (name: string, input: Record<string, unknown>, ts: string): FleetEvent => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] }, ts,
});

/** The agent talking, as the runtime streams it. */
const say = (text: string, ts: string): FleetEvent => ({
  type: 'assistant', message: { content: [{ type: 'text', text }] }, ts,
});

/** A finished run's tally, read off the box row rather than restated. */
function resultOf(box: FleetBox, text: string, ts: string): FleetEvent[] {
  const r = box.lastResult;
  if (!r) return [];
  return [
    {
      type: 'result', subtype: r.subtype, num_turns: r.turns, duration_ms: r.durationMs,
      total_cost_usd: r.costUsd, result: text, ts,
    },
    { type: 'devbox_end', ts },
  ];
}

/** Minutes before the box's own last activity, so the log ends where the row says it did. */
function before(box: FleetBox, minutes: number): string {
  const last = Date.parse(box.lastActivityAt ?? clock.nowIso());
  return new Date(last - minutes * 60_000).toISOString();
}

function start(box: FleetBox, minutes: number): FleetEvent {
  return {
    type: 'task_started', prompt: box.currentTask ?? 'run started',
    ...(box.activeModel ? { model: box.activeModel } : {}),
    ts: before(box, minutes),
  };
}

/**
 * The run's plan, as Claude Code's TodoWrite (lab wire contract §1): items up
 * to `doneThrough` completed, the next in flight, the rest pending. The lab
 * renders the LATEST one as the run's checklist.
 */
function todo(plan: readonly string[], doneThrough: number, ts: string): FleetEvent {
  return tool('TodoWrite', {
    todos: plan.map((content, i) => ({
      content, activeForm: content,
      status: i <= doneThrough ? 'completed' : i === doneThrough + 1 ? 'in_progress' : 'pending',
    })),
  }, ts);
}

/** Shell output coming back to the agent — the stream-json `tool_result` shape. */
const output = (text: string, ts: string): FleetEvent => ({
  type: 'user', message: { content: [{ type: 'tool_result', content: text }] }, ts,
});

/** Each running box's plan, shared by its seeded history and its ticker. */
const PLANS: Record<string, readonly string[]> = {
  'box-mock-0001': [
    'Reproduce the refresh loop with a grant revoked mid-session',
    'Find where the client retries the refresh',
    'Return a terminal signal for a revoked grant',
    'Cover revocation in the refresh tests',
  ],
  'box-mock-0006': [
    'Reproduce the OOM under burst ingest',
    'Bound the exporter queue',
    'Add back-pressure metrics',
    'Soak-test the collector',
  ],
  'box-mock-0007': [
    'Read the judge prompt and the rubric dimensions',
    'Weight the dimensions in the canary scorer',
    'Re-score the golden set',
    'Compare against the unweighted baseline',
  ],
  'box-mock-0008': [
    'Inventory the OpenSearch collections and their OCU floors',
    'Find collections that can be consolidated',
    'Draft the consolidation plan',
  ],
};

/** Per-box stories, keyed by the seed's box ids (mock/devbox-fleet.ts). */
const STORIES: Record<string, (box: FleetBox) => FleetEvent[]> = {
  // RUNNING — mid-run, so the last tool call is the one in flight.
  'box-mock-0001': (box) => {
    const plan = PLANS['box-mock-0001']!;
    return [
      start(box, 4.2),
      todo(plan, -1, before(box, 4.1)),
      tool('Read', { file_path: 'src/auth/refresh.ts' }, before(box, 3.9)),
      say('Reproduced: revoking the grant leaves the client retrying refresh on a 403.', before(box, 3.6)),
      todo(plan, 0, before(box, 3.5)),
      tool('Grep', { pattern: 'retryOn403' }, before(box, 3.1)),
      say('The retry lives in the session client and treats every 403 as transient.', before(box, 2.4)),
      todo(plan, 1, before(box, 2.3)),
      tool('Edit', { file_path: 'src/auth/refresh.ts' }, before(box, 1.6)),
      tool('Bash', { command: 'npm test -- refresh' }, before(box, 0.4)),
    ];
  },
  // FINISHED on the same initiative.
  'box-mock-0002': (box) => [
    start(box, 9),
    tool('Read', { file_path: 'src/auth/session-cookie.ts' }, before(box, 8.5)),
    tool('Edit', { file_path: 'src/auth/session-cookie.ts' }, before(box, 6)),
    tool('Bash', { command: 'npm test -- session' }, before(box, 2)),
    ...resultOf(box, 'Session cookies now carry a max-age and re-mint on every tenant and role switch; the change is in review.', before(box, 0)),
  ],
  // WAITING — the run ended by asking the question its work depends on.
  'box-mock-0003': (box) => [
    start(box, 6),
    tool('Read', { file_path: 'infra/lib/span-projector-stack.ts' }, before(box, 5.5)),
    tool('Grep', { pattern: 'namespace' }, before(box, 4.8)),
    say('Retrying the metrics listing — the first call was throttled.', before(box, 3.9)),
    tool('Bash', { command: 'aws cloudwatch list-metrics --namespace OrgIQ/Spans' }, before(box, 3.2)),
    say('Two namespaces carry span counts: OrgIQ/Spans and OrgIQ/Projector. Which one should the RED dashboards read?', before(box, 0)),
    { type: 'devbox_end', ts: before(box, 0) },
  ],
  // PERSONAL, finished.
  'box-mock-0004': (box) => [
    start(box, 3),
    tool('Read', { file_path: 'middleware/seeds/roles/orgiq/member.cedar' }, before(box, 2.6)),
    tool('Bash', { command: 'npm test -- guardrail' }, before(box, 1.2)),
    ...resultOf(box, 'The rule fires on the salary prompt; the guardrail blocks it as intended.', before(box, 0)),
  ],
  // UNATTRIBUTED — the dispatcher's box, so its run is a JOB.
  'box-mock-0005': (box) => [
    { type: 'job_started', jobId: 'mock-auth-dep-watch', title: 'auth-dep-watch', kind: 'devbox:task', ts: before(box, 1.6) },
    tool('Bash', { command: 'npm audit --omit=dev' }, before(box, 1.4)),
    say('Two moderate advisories, both dev-only. Retrying the registry fetch for the auth service.', before(box, 0.9)),
    tool('Bash', { command: 'npm outdated --long' }, before(box, 0.6)),
    ...resultOf(box, 'No security advisories on the auth service; patch bumps are listed for review.', before(box, 0)),
    { type: 'job_finished', jobId: 'mock-auth-dep-watch', ok: true, ts: before(box, 0) },
  ],
  // RUNNING — young, early in its plan.
  'box-mock-0006': (box) => {
    const plan = PLANS['box-mock-0006']!;
    return [
      start(box, 5),
      todo(plan, -1, before(box, 4.9)),
      tool('Read', { file_path: 'collector/config/exporters.yaml' }, before(box, 4.2)),
      tool('Bash', { command: 'make burst-ingest' }, before(box, 3)),
      output('collector: queue grew without bound; RSS climbing until the OOM kill', before(box, 2.2)),
      say('Reproduced the OOM: the exporter queue has no size limit.', before(box, 1.4)),
      todo(plan, 0, before(box, 1.3)),
      tool('Edit', { file_path: 'collector/config/exporters.yaml' }, before(box, 0.2)),
    ];
  },
  // RUNNING — further along, context filling.
  'box-mock-0007': (box) => {
    const plan = PLANS['box-mock-0007']!;
    return [
      start(box, 9),
      todo(plan, -1, before(box, 8.9)),
      tool('Read', { file_path: 'prompts/judge/canary-rubric.md' }, before(box, 8)),
      todo(plan, 0, before(box, 6.5)),
      tool('Edit', { file_path: 'src/canary/scorer.ts' }, before(box, 5)),
      say('Dimensions now carry weights from the rubric config rather than an even split.', before(box, 3.6)),
      todo(plan, 1, before(box, 3.5)),
      tool('Bash', { command: 'npm run golden -- --rescore' }, before(box, 0.7)),
    ];
  },
};

function seedTails(): SeededTail[] {
  return devboxBoxes.rows()
    .filter((box) => STORIES[box.id])
    .map((box) => ({ boxId: box.id, events: STORIES[box.id]!(box) }));
}

/**
 * The offline fleet's tails. `empty` is real and worth asking for: a fleet
 * whose boxes have never run anything through this process.
 */
export const devboxTails = defineFixture<SeededTail>({
  key: 'devbox-tails',
  scenarios: {
    default: seedTails,
    empty: () => [],
  },
});

// ─── The ticker — running computers keep working ─────────────────────────────
//
// A seeded history ends where the row says the box is NOW, and a running box's
// tail then sat frozen on its last tool call for as long as anyone watched it —
// a computer whose status says "running" with a log that never moves reads as
// hung. So each running seeded box carries a script of what it does next, and
// a ticker appends the next frame through `appendEvent` — the real status
// machine, so the box's activity clock, context gauge and status all move the
// way a live run's do. A provisioning box's first tick is its `task_started`,
// which is what brings it up.
//
// The script walks the box's plan forward and then iterates on its last item
// (edit, test, read the output) without ever claiming the plan finished: an
// offline agent cannot honestly say it solved anything, and a box that never
// ends its run is stopped by the reaper at the lifetime ceiling exactly as a
// real one would be. Only `running` boxes tick (and a provisioning one coming
// up): a waiting box needs a person, an idle one has finished.
//
// Registered and reset-safe: the cursors are a fixture (`devbox-tail-ticks`),
// so `POST /api/__mock/reset` puts every script back at its first frame, and
// rehydrating the fleet restarts the timer against the new boxes. Every
// timestamp is read from the clock when the frame is appended (rule 3).

type FrameFactory = (ts: string) => FleetEvent;

/** What each box does next: a lead-in, then a loop it repeats. */
interface TickScript { lead: FrameFactory[]; loop: FrameFactory[] }

const t = (name: string, input: Record<string, unknown>): FrameFactory => (ts) => tool(name, input, ts);
const s_ = (text: string): FrameFactory => (ts) => say(text, ts);
const o = (text: string): FrameFactory => (ts) => output(text, ts);
const plan = (boxId: string, doneThrough: number): FrameFactory => (ts) => todo(PLANS[boxId]!, doneThrough, ts);

function scriptFor(boxId: string): TickScript | null {
  switch (boxId) {
    case 'box-mock-0001': return {
      lead: [
        o('refresh: revoked-grant case now answers 401 with a terminal reason'),
        plan(boxId, 2),
        t('Edit', { file_path: 'tests/refresh.integration.test.ts' }),
      ],
      loop: [
        t('Bash', { command: 'npm test -- refresh' }),
        o('one case still retries: the background refresh timer ignores the terminal flag'),
        t('Edit', { file_path: 'src/auth/session-client.ts' }),
        s_('Making the background refresh honour the terminal flag as well.'),
      ],
    };
    case 'box-mock-0006': return {
      lead: [
        t('Bash', { command: 'make burst-ingest' }),
        o('queue capped; RSS flat under burst, the oldest batches are dropped first'),
        plan(boxId, 1),
        t('Edit', { file_path: 'collector/internal/exporter/metrics.go' }),
      ],
      loop: [
        t('Bash', { command: 'go test ./internal/exporter/...' }),
        o('ok  collector/internal/exporter'),
        s_('Watching the dropped-batch counter while the soak runs.'),
        t('Bash', { command: 'make soak' }),
      ],
    };
    case 'box-mock-0007': return {
      lead: [
        o('golden set re-scored; weighted totals written to out/rescore.json'),
        plan(boxId, 2),
        t('Read', { file_path: 'out/rescore.json' }),
      ],
      loop: [
        t('Bash', { command: 'npm run golden -- --compare baseline' }),
        o('weighted and unweighted rankings disagree on the faithfulness-heavy cases'),
        s_('Checking whether the disagreement is the weights or a scoring bug.'),
        t('Grep', { pattern: 'faithfulness' }),
      ],
    };
    case 'box-mock-0008': {
      const prompt = provisioningTaskFor(boxId);
      return {
        lead: [
          (ts) => ({ type: 'task_started', prompt: prompt ?? 'run started', model: 'claude-sonnet-5', ts }),
          plan(boxId, -1),
          t('Bash', { command: 'aws opensearchserverless list-collections' }),
          o('collections listed with their standby replicas and OCU floors'),
          plan(boxId, 0),
        ],
        loop: [
          t('Read', { file_path: 'infra/lib/knowledge-base-stack.ts' }),
          s_('Comparing which collections share an access pattern and could merge.'),
          t('Grep', { pattern: 'CfnCollection' }),
          o('collection definitions found in the knowledge-base and observability stacks'),
        ],
      };
    }
    default: return null;
  }
}

/** Where each box's script is up to. A fixture, so reset rewinds every script. */
interface TickCursor { boxId: string; next: number }
export const devboxTailTicks = defineFixture<TickCursor>({
  key: 'devbox-tail-ticks',
  scenarios: { default: () => [], empty: () => [] },
});

/** Append the next scripted frame to every box that is working. Returns how many advanced. */
export function tickMockTails(): number {
  let advanced = 0;
  const cursors = devboxTailTicks.rows();
  for (const box of listBoxes()) {
    const script = scriptFor(box.id);
    if (!script) continue;
    const coming = box.status === 'provisioning';
    if (box.status !== 'running' && !coming) continue;
    let cursor = cursors.find((c) => c.boxId === box.id);
    if (!cursor) { cursor = { boxId: box.id, next: 0 }; cursors.push(cursor); }
    const i = cursor.next;
    const frame = i < script.lead.length
      ? script.lead[i]!
      : script.loop[(i - script.lead.length) % script.loop.length]!;
    // A provisioning box only ever comes up through its task_started.
    if (coming && i !== 0) continue;
    appendEvent(box.id, frame(clock.nowIso()));
    cursor.next = i + 1;
    advanced++;
  }
  return advanced;
}

/** Milliseconds between ticks: MOCK_TAIL_TICK_MS, default 6s; off under jest unless set. */
function tickMs(): number {
  const raw = process.env['MOCK_TAIL_TICK_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  return process.env['NODE_ENV'] === 'test' ? 0 : 6_000;
}

let ticker: NodeJS.Timeout | null = null;

/** (Re)start the ticker. Called after every mock fleet hydration. */
export function startMockTailTicker(): void {
  stopMockTailTicker();
  const ms = tickMs();
  if (ms <= 0) return;
  ticker = setInterval(() => { try { tickMockTails(); } catch { /* a pinned error world */ } }, ms);
  ticker.unref?.();
}

export function stopMockTailTicker(): void {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

/** Whether the ticker is armed — for tests and the control plane's state. */
export function mockTailTickerRunning(): boolean { return ticker !== null; }
