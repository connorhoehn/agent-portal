// A devbox that answers, with no microVM behind it.
//
// `lib/devbox-arn.ts` hands every caller one `BedrockAgentCoreClient`, and two
// commands go through it: `InvokeAgentRuntimeCommandCommand` (run a shell
// command in the session, stream stdout back) and `InvokeAgentRuntimeCommand`
// (run a Claude Code task in the session, stream its SSE events back). This
// module is a stand-in for both, over `mock/devbox-workspace.ts`.
//
// WHY A FAKE CLIENT RATHER THAN A MOCK BRANCH IN EACH CALLER. The callers are
// `lib/project-runner.ts` and `lib/sdlc-pipeline.ts`, and what they do with
// the devbox is the whole governance pipeline: snapshot the tree, run the
// task, measure the tree, capture the diff, commit it, hand it to the
// reviewer, run the gates, roll back a blocked change. Branching inside each
// of them would mean an offline pipeline that is a *different* pipeline —
// different sequencing, different failure handling, and no test of the real
// one. Replacing the transport instead means every line of that code runs
// exactly as it does in production, and only the sandbox is imaginary.
//
// AN UNKNOWN COMMAND IS AN ERROR, LOUDLY. Every caller treats a leading
// `fatal:` as a git failure, so an unrecognised probe surfaces as one instead
// of as an empty string — which `readWorkingTree` would read as "the tree is
// clean", the single most misleading answer this module could give.

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { clock } from './core/index.js';
import { demoActive, demoBeatMs } from './demo-pace.js';
import { simulatedFinalMessage, simulatedRunFixture, type SimulatedRunFixture } from './run-report-fixtures.js';
import { LOGOUT_SHIM_COOKIE_ANSWER, logoutShimCookieFolder } from './debrief-fixtures.js';
import type { ProductStep } from './demo-auth-products.js';
import {
  type WorkProduct,
  IDLE_RUN_COST_USD, commitPending, hasCommit, pendingStat, porcelain,
  resetToParent, selectWorkProduct, stageWork, workspaceFor,
} from './devbox-workspace.js';

/** The `sh -c '... echo <b64> | base64 -d > /tmp/.orgiq-probe ...'` wrapper runDevboxShell builds. */
function unwrapProbe(command: string): string {
  const m = /echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/\.orgiq-probe/.exec(command);
  if (!m?.[1]) return command;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

/**
 * Run one shell command against a session's workspace.
 *
 * Ordered most specific first: the capture probe and the commit probe both
 * contain the word `diff`/`add -A`, so a looser match earlier would answer the
 * wrong question with a straight face.
 */
export function runMockShell(sessionId: string, wrapped: string): string {
  const cmd = unwrapProbe(wrapped);
  const ws = workspaceFor(sessionId);

  // The clone, which is how a workspace comes into existence on BOTH paths.
  // Without it `ensureWorkspace` (lib/bot-runner.ts) fell through to the
  // unsupported-command `fatal:` below and every marketplace dispatch 503'd
  // with "clone failed" offline — the run never started, so nothing downstream
  // of it could be exercised either. The command ends in a `git log --oneline
  // -1` verify (providers/agent-projects.ts::buildCloneCommand), so that one
  // line is what a successful clone streams back; anything matching
  // CLONE_FAILURE here would be read as a broken checkout.
  if (/git clone /.test(cmd)) {
    return `${ws.commits[0]!.slice(0, 7)} Initial import\n`;
  }

  const catFile = /cat-file -e ([0-9a-f]{40})/.exec(cmd);
  if (catFile) return hasCommit(sessionId, catFile[1]!) ? '__OK__\n' : '__MISSING__\n';

  const reset = /reset -q --hard ([0-9a-f]{40})~1/.exec(cmd);
  if (reset) { resetToParent(sessionId, reset[1]!); return ''; }

  if (/commit -q -m/.test(cmd)) {
    const sha = commitPending(sessionId);
    // Real git says this and exits non-zero, and `commitCapture` treats a
    // non-sha as "no commit" and falls back to working-tree delivery — which
    // is the behaviour a clean tree should get.
    return sha ? `${sha}\n` : 'nothing to commit, working tree clean\n';
  }

  if (/diff --stat/.test(cmd)) return `${pendingStat(ws)}\n`;
  if (/status --porcelain/.test(cmd)) {
    const lines = porcelain(ws);
    return lines ? `${lines}\n` : '';
  }
  if (/\bdiff\b/.test(cmd)) return ws.pending?.diff ?? '';

  return `fatal: mock devbox: unsupported command (${cmd.slice(0, 120)})\n`;
}

/** One event of a mock run, stamped when it is yielded rather than when planned. */
type MockEvent = Record<string, unknown>;

/** A planned run: its events, and how the stream must end. */
interface PlannedRun {
  events: MockEvent[];
  pace: 'default' | 'demo';
  /** Resolves when somebody answers — the stream holds open until then. */
  awaitAnswer: Promise<void> | null;
  /** Called once the stream has yielded its last event. */
  onDone?: () => void;
}

const say = (text: string): MockEvent => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const use = (name: string, input: Record<string, unknown>): MockEvent =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

/**
 * The plan as a TodoWrite call — the real Claude Code plan wire shape (lab
 * contract §1): items before `done` are completed, the next is in flight.
 */
function todoWrite(plan: readonly string[], doneThrough: number): MockEvent {
  return use('TodoWrite', {
    todos: plan.map((content, i) => ({
      content,
      activeForm: content,
      status: i <= doneThrough ? 'completed' : i === doneThrough + 1 ? 'in_progress' : 'pending',
    })),
  });
}

/** A product's narrated steps, re-emitting the plan whenever a step finishes an item. */
function narrate(plan: readonly string[], steps: readonly ProductStep[], events: MockEvent[]): void {
  for (const st of steps) {
    if (st.tool) events.push(use(st.tool.name, st.tool.input));
    if (st.say) events.push(say(st.say));
    if (st.done !== undefined) events.push(todoWrite(plan, st.done));
  }
}

// ─── Questions a run is waiting on ──────────────────────────────────────────
//
// A product with a `question` ends its run the way a real Claude Code run that
// needs a human does — the last assistant text ends with '?', then
// `devbox_end`, which the fleet reads as `waiting` — but the governed run that
// started it is not over: its work is still to do. So the stream stays OPEN
// after that last frame, exactly as `executeProjectRun` would sit on a real
// runtime that has not returned, until the next task on the same session (the
// operator's answer, through `POST /api/devbox/:sessionId/task`) plays the
// product's `answered` phase. When that phase has streamed, the held run
// closes, `readWorkingTree` finds the staged change, and capture → review →
// gate runs on the governed run that asked — the whole real pipeline, with
// only the sandbox imaginary.
//
// Bounded: an unanswered question releases after MOCK_DEVBOX_ANSWER_TIMEOUT_MS
// (default 20 min) with nothing staged, which the pipeline reads as a run
// that changed nothing. `resetMockDevboxTransport` releases every held run and
// silences every stream in flight, so `POST /api/__mock/reset` never leaves a
// run from the old world writing into the new one.

interface HeldRun { product: WorkProduct; release: () => void; }
const held = new Map<string, HeldRun>();
let epoch = 0;

function answerTimeoutMs(): number {
  const raw = Number(process.env['MOCK_DEVBOX_ANSWER_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000;
}

/** Whether a session's run is holding open on an unanswered question. */
export function isAwaitingAnswer(sessionId: string): boolean {
  return held.has(sessionId);
}

/** Release every held run and silence every stream in flight. */
export function resetMockDevboxTransport(): void {
  epoch++;
  fixtureBySession.clear();
  clearDevboxRecordings();
  const runs = [...held.values()];
  held.clear();
  for (const run of runs) run.release();
}

// ─── What a run of a work item says (docs/learning-loop-design.md, "The mock") ──
//
// A governed run of a work item (its `lab` context names the item) ends with the hand-written fixture
// for it (mock/run-report-fixtures.ts): the `result` event's text is the final message a worker would
// have written, with its `lab-report` block, so `recordRunEnd` reads it exactly as it reads a real
// run's. The tree still changes as before, so capture, review and the gates still run; a fixture that
// failed stops before changing anything. The session's fixture is kept so the `debrief` op can answer
// for it (below), the way a real box resumes the session that did the work.

/** A hand-written stand-in for the Claude Code session id a real devbox_end reports. */
const FIXTURE_CLAUDE_SESSION = '00000000-0000-4000-8000-0000000000e8';

const fixtureBySession = new Map<string, SimulatedRunFixture>();

/** The fixture for the work item a run's `lab` context names, or null (a run with no work item keeps its plain product). */
async function fixtureForLab(lab: unknown): Promise<SimulatedRunFixture | null> {
  const l = (lab && typeof lab === 'object' ? lab : {}) as Record<string, unknown>;
  const itemId = typeof l['work_item_id'] === 'string' ? l['work_item_id'] : '';
  if (!itemId) return null;
  try {
    const { getWorkItem } = await import('../providers/work-items.js');
    const item = await getWorkItem(itemId);
    if (!item) return null;
    // The runbooks this run's frozen brief offered, so the fixture can say what it did with each.
    let given: string[] = [];
    try {
      const { runbookStore } = await import('../lib/runbooks/store-select.js');
      const { offeredFromBrief } = await import('../lib/run-reports/record.js');
      given = offeredFromBrief(await runbookStore().getBrief(String(l['run_ref'] ?? ''))).map((r) => r.id);
    } catch { given = []; }
    return simulatedRunFixture(item, given);
  } catch { return null; }
}

/** The run, ending the way the fixture says: its final message, the skills it loaded, and the session it ended in. */
function withFixture(run: PlannedRun, fx: SimulatedRunFixture): PlannedRun {
  const failed = fx.outcome === 'failed';
  const events: MockEvent[] = [];
  for (const ev of run.events) {
    if (ev['type'] === 'result') {
      for (const skill of fx.skillsLoaded) events.push(use('Skill', { skill }));
      events.push({
        ...ev,
        result: simulatedFinalMessage(fx),
        ...(failed ? { subtype: 'error_during_execution', is_error: true, terminal_reason: fx.failureCode ?? 'failed' } : {}),
      });
    } else if (ev['type'] === 'devbox_end') {
      events.push({ ...ev, claude_session_id: FIXTURE_CLAUDE_SESSION });
    } else {
      events.push(ev);
    }
  }
  return { ...run, events };
}

/** The plan for a fixture that stopped before changing anything: nothing staged, a failed result. */
function failedFixtureRun(fx: SimulatedRunFixture): PlannedRun {
  return withFixture({
    events: [
      say('I read the repository and tried to reproduce this.'),
      { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: IDLE_RUN_COST_USD, result: '' },
      { type: 'devbox_end', exit_code: 0 },
    ],
    pace: 'default', awaitAnswer: null,
  }, fx);
}

function planRun(sessionId: string, prompt: string): PlannedRun {
  // An answer to a held question, whatever it says: the session is what ties
  // it to the run that asked.
  const waiting = held.get(sessionId);
  if (waiting?.product.answered) {
    const { product } = waiting;
    const answered = product.answered!;
    held.delete(sessionId);
    stageWork(sessionId, product.diff);
    const events: MockEvent[] = [];
    narrate(product.plan ?? [], answered.steps, events);
    events.push({
      type: 'result', subtype: 'success', num_turns: answered.steps.length + 1,
      total_cost_usd: answered.costUsd, result: answered.summary,
    });
    events.push({ type: 'devbox_end', exit_code: 0 });
    return { events, pace: product.pace ?? 'default', awaitAnswer: null, onDone: waiting.release };
  }

  const product = selectWorkProduct(prompt);
  const events: MockEvent[] = [];

  if (!product) {
    events.push(say('I read the repository and found nothing to change for this task.'));
    events.push({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: IDLE_RUN_COST_USD, result: 'No change was needed.' });
    events.push({ type: 'devbox_end', exit_code: 0 });
    return { events, pace: 'default', awaitAnswer: null };
  }

  if (product.plan && product.steps) {
    events.push(todoWrite(product.plan, -1));
    narrate(product.plan, product.steps, events);
  } else {
    events.push(say(`Working in the checkout. ${product.summary}`));
    for (const call of product.toolCalls) events.push(use(call.name, { file_path: call.target }));
  }

  if (product.question && product.answered) {
    // Nothing staged: the work is what the answer unlocks.
    events.push(say(product.question));
    events.push({
      type: 'result', subtype: 'success', num_turns: (product.steps?.length ?? 0) + 1,
      total_cost_usd: product.costUsd, result: product.question,
    });
    events.push({ type: 'devbox_end', exit_code: 0 });
    // Held from now, not from when the last frame is yielded, so an answer can
    // never arrive in a gap where the session looks like it asked nothing.
    const answered = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { held.delete(sessionId); resolve(); }, answerTimeoutMs());
      timer.unref?.();
      held.set(sessionId, { product, release: () => { clearTimeout(timer); resolve(); } });
    });
    return { events, pace: product.pace ?? 'default', awaitAnswer: answered };
  }

  stageWork(sessionId, product.diff);
  events.push({
    type: 'result', subtype: 'success',
    num_turns: (product.steps?.length ?? product.toolCalls.length) + 1,
    total_cost_usd: product.costUsd,
    result: product.summary,
  });
  events.push({ type: 'devbox_end', exit_code: 0 });
  return { events, pace: product.pace ?? 'default', awaitAnswer: null };
}

/**
 * Run one agent task against a session's workspace.
 *
 * Emits the same event stream `executeDevboxTask` parses out of a real run —
 * assistant text, tool_use blocks, a `result` with the run's own verdict and
 * cost, then `devbox_end` — and leaves the selected work product uncommitted
 * in the tree, which is what makes the run "change code" as far as
 * `readWorkingTree` is concerned. (A product that asks a question stages
 * nothing until it is answered — see "Questions a run is waiting on".)
 */
export function runMockTask(sessionId: string, prompt: string): string[] {
  return planRun(sessionId, prompt).events.map((e) => `data: ${JSON.stringify(e)}\n`);
}

async function* shellStream(out: string, delayMs = 0): AsyncGenerator<{ chunk: { contentDelta: { stdout: string } } }> {
  if (delayMs > 0) await sleep(delayMs);
  yield { chunk: { contentDelta: { stdout: out } } };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

/**
 * Milliseconds between a mock run's events.
 *
 * `MOCK_DEVBOX_PACE_MS` overrides; default 900ms in development and 0 under
 * jest so the suites stay instant. A real devbox task takes a minute or two,
 * and yielding every event in one tick made a run begin and end inside the
 * same event-loop turn — so a computer in the lab never *showed* as running,
 * it simply had a finished run attached to it. The pace is per event, so the
 * five-ish events of a typical work product run for a few seconds. A `demo`
 * product paces by the demo's beat instead (mock/demo-pace.ts).
 */
function devboxPaceMs(pace: 'default' | 'demo' = 'default'): number {
  if (pace === 'demo') return demoBeatMs();
  const raw = process.env['MOCK_DEVBOX_PACE_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  return process.env['NODE_ENV'] === 'test' ? 0 : 900;
}

/**
 * How long the clone that boots a microVM takes — the window a freshly minted
 * computer reads `provisioning` (lib/bot-runner.ts ensureWorkspace).
 * `MOCK_DEVBOX_PROVISION_MS` overrides; default 2.5s in development, two demo
 * beats while the demo runs, 0 under jest.
 */
function provisionMs(): number {
  const raw = process.env['MOCK_DEVBOX_PROVISION_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  if (demoActive()) return 2 * demoBeatMs();
  return process.env['NODE_ENV'] === 'test' ? 0 : 2_500;
}

async function* taskStream(run: PlannedRun): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const pace = devboxPaceMs(run.pace);
  const started = epoch;
  try {
    for (const ev of run.events) {
      if (pace > 0) await sleep(pace);
      if (epoch !== started) return;            // the world was reset under this run
      yield enc.encode(`data: ${JSON.stringify({ ...ev, ts: clock.nowIso() })}\n`);
    }
  } finally {
    run.onDone?.();
  }
  // Hold the run open on its question — see "Questions a run is waiting on".
  if (run.awaitAnswer && epoch === started) await run.awaitAnswer;
}

/**
 * A `BedrockAgentCoreClient` that never leaves the process.
 *
 * Cast rather than subclassed: the SDK client's surface is large and none of
 * it beyond `send` is reachable from the devbox callers, so implementing the
 * rest would be dead code pretending to be a contract.
 */
function commandName(command: unknown): string {
  return (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? '';
}

// ─── What the fake microVM was sent (DE-45) ──────────────────────────────────
//
// Every shell command the fake runtime receives (wrapper and decoded probe,
// both), and every credentialed git op with its token reduced to a boolean.
// Tests assert no command ever carried a credential: the token belongs in a
// git op's payload, never in shell text.

export interface RecordedGitOp { sessionId: string; op: string; repo: string; target: string; authenticated: boolean }

const shellLog: string[] = [];
const gitLog: RecordedGitOp[] = [];
const LOG_CAP = 500;

/** Shell commands received since the last reset, oldest first (wrapper, then decoded probe when wrapped). */
export function recordedShellCommands(): readonly string[] { return [...shellLog]; }
/** Credentialed git ops received since the last reset — never the token itself. */
export function recordedGitOps(): readonly RecordedGitOp[] { return gitLog.map((g) => ({ ...g })); }
export function clearDevboxRecordings(): void { shellLog.length = 0; gitLog.length = 0; }

function record<T>(log: T[], entry: T): void {
  log.push(entry);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
}

/** The git entrypoint (agents/devbox/main.py `_run_git`), offline: a clone seeds the workspace. */
async function* gitStream(sessionId: string, payload: Record<string, unknown>): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const op = String(payload['op'] ?? '');
  const repo = String(payload['repo'] ?? '');
  const target = String(payload['target'] ?? '');
  record(gitLog, { sessionId, op, repo, target, authenticated: typeof payload['token'] === 'string' && payload['token'] !== '' });
  const frame = (ev: Record<string, unknown>): Uint8Array => enc.encode(`data: ${JSON.stringify(ev)}\n`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !target.startsWith('/')) {
    yield frame({ type: 'git_end', op, exit_code: 2, error: 'repo must be owner/name and target an absolute path' });
    return;
  }
  yield frame({ type: 'git_start', op, repo, target, authenticated: gitLog[gitLog.length - 1]!.authenticated });
  if (op === 'clone') {
    const delay = provisionMs();
    if (delay > 0) await sleep(delay);
    const ws = workspaceFor(sessionId);
    yield frame({ type: 'git_output', text: `Cloning into '${target}'...\n${ws.commits[0]!.slice(0, 7)} Initial import\n` });
  } else {
    yield frame({ type: 'git_output', text: `To https://github.com/${repo}.git\n * [new branch] ${String(payload['branch'] ?? '')}\n` });
  }
  yield frame({ type: 'git_end', op, exit_code: 0 });
}

/**
 * The `debrief` op (agents/devbox/main.py `_mvm_debrief`): `{ ok, answer, folder?, cost_usd }`. The run that taught
 * something answers with the hand-written folder; any other run answers that nothing is worth keeping; a session
 * the fake never ran a fixture in cannot be resumed.
 */
async function* debriefStream(sessionId: string): AsyncGenerator<Uint8Array> {
  const fx = fixtureBySession.get(sessionId);
  const out = !fx
    ? { ok: false, error: 'session-unavailable' }
    : fx.key === 'teaches'
      ? { ok: true, answer: LOGOUT_SHIM_COOKIE_ANSWER, folder: logoutShimCookieFolder(), cost_usd: 0 }
      : { ok: true, answer: { kind: 'none', reason: 'The simulated run has no hand-written runbook to keep.' }, cost_usd: 0 };
  yield new TextEncoder().encode(`data: ${JSON.stringify(out)}\n`);
}

export function mockDevboxClient(): BedrockAgentCoreClient {
  const client = {
    async send(command: unknown): Promise<unknown> {
      const input = ((command as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
      const sessionId = String(input['runtimeSessionId'] ?? 'mock-session');

      // The shell command API — `body: { command, timeout }`.
      const body = input['body'] as { command?: string } | undefined;
      if (body && typeof body.command === 'string') {
        record(shellLog, body.command);
        const decoded = unwrapProbe(body.command);
        if (decoded !== body.command) record(shellLog, decoded);
        // The clone is what boots a microVM, so it is the one command that
        // takes a while — long enough for the lab to show the computer
        // `provisioning` (lib/bot-runner.ts ensureWorkspace).
        const booting = /git clone /.test(unwrapProbe(body.command));
        return { stream: shellStream(runMockShell(sessionId, body.command), booting ? provisionMs() : 0) };
      }

      // The agent task API — `payload` is UTF-8 JSON.
      const payload = input['payload'] as Uint8Array | undefined;
      if (payload) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>; }
        catch { parsed = {}; }
        // A credentialed git op (DE-45) — the image's other entrypoint.
        if (parsed['op'] === 'clone' || parsed['op'] === 'push') return { response: gitStream(sessionId, parsed) };
        // The microVM runner's `debrief` op: the resume turn, answered from the fixture the session ran.
        if (parsed['runner'] === 'microvm' && parsed['op'] === 'debrief') return { response: debriefStream(sessionId) };
        const prompt = String(parsed['prompt'] ?? '');
        const fx = await fixtureForLab(parsed['lab']);
        if (fx) fixtureBySession.set(sessionId, fx); else fixtureBySession.delete(sessionId);
        const run = !fx ? planRun(sessionId, prompt) : fx.outcome === 'failed' ? failedFixtureRun(fx) : withFixture(planRun(sessionId, prompt), fx);
        return { response: taskStream(run) };
      }

      // StopRuntimeSession — what the reaper and `DELETE /boxes/:id` send. It
      // carries a session and nothing else. Offline there is no microVM to
      // stop, so stopping one always succeeds; answering it with the throw
      // below made the reaper's stop fail on every sweep, re-announce the reap
      // into the box's tail each minute and never settle the box.
      if (commandName(command) === 'StopRuntimeSessionCommand') return {};

      throw new Error('mock devbox: unrecognised runtime command');
    },
    destroy(): void { /* nothing to tear down */ },
  };
  return client as unknown as BedrockAgentCoreClient;
}
