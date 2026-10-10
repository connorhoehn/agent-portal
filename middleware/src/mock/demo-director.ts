// The Computer Lab demo director — `POST /api/__mock/scenario {"scenario":"demo"}`.
//
// WHAT IT IS. A short story, told entirely through the platform's own front
// door. Nora DaSilva (`u-nora`, sme on Auth Migration) has three agents pick up
// three of the initiative's open items. Each pickup is a real
// `POST /api/bots/dispatch-work` over HTTP to THIS server with her signed
// session, so it passes the same Cedar gate, grant scope, codebase preflight,
// money brakes and concurrency ceiling as a click in the portal; the computers
// that appear are the ones the governed dispatch mints (lib/bot-runner.ts
// ensureWorkspace → provisioning → running), and what they do is what the
// fake microVM plays for those items (mock/demo-auth-products.ts). Then:
//
//   A (Ada)   fixes the logout bug; capture → review → gate puts the change in
//             the real review queue, and a `delivery` frame lands in its tail.
//   B (Basil) asks a question it cannot answer alone and waits. A person
//             answers through `POST /api/devbox/:sessionId/task` — the lab's
//             Nudge / Agent reply — and the run finishes and is captured. If
//             nobody answers within DEMO_DIRECTOR_AUTO_ANSWER_BEATS, the
//             director answers as Nora through that same route.
//   C (Cleo)  fixes the refresh loop, then reaches for the next open item. Two
//             runs have settled against Nora's sprint envelope by then, and the
//             real dispatch answers 409; the body lands verbatim in C's tail as
//             a `gate_refused` frame (lab wire contract §3).
//
// WHAT IT IS NOT. A side channel. The director never writes a work item, a run,
// a change or a budget row itself. It writes exactly three kinds of thing
// directly: the agents' names onto their computers (through the real
// `PATCH /api/devbox/boxes/:id` route), C's one line of narration before its
// second pickup, and C's `gate_refused` frame — the agent reporting the answer
// the platform gave it. Settling finished runs is the reconcile tick's job
// (lib/bot-runner.ts reconcileBotRuns); the director runs that tick before C's
// second pickup rather than waiting up to 30s for the scheduler's.
//
// PACE. Every wait is a number of beats (mock/demo-pace.ts,
// DEMO_DIRECTOR_PACE_MS). Default 4s → the story takes ~3¼ minutes (measured
// ~145s at a 3s beat); 400ms tells it in ~20s.
//
// LIFECYCLE. Started by the scenario plane after it switches to `demo`;
// stopped by any reset or other scenario (routes/mock-control.ts). State is
// readable at `GET /api/__mock/state` → `demo`.

import { demoBeatMs, setDemoActive, setDemoPaceOverride, sleepBeats } from './demo-pace.js';
import { liveBotRuns } from './bots.js';
import { workItems } from './work-items.js';
import { getBox, replayEvents, appendEvent, reserveBox, releaseBox, type FleetEvent } from '../lib/devbox-fleet.js';
import { reconcileBotRuns } from '../lib/bot-runner.js';
import { clock } from './core/index.js';

/** The dispatcher whose agents these are — sme on Auth Migration. */
export const DEMO_ACTOR = 'u-nora';
/** The model the agents run on — the deployed devbox's. */
export const DEMO_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** What B is told when the director has to answer for Nora. */
export const DEMO_ANSWER = 'Smallest tenant first — one tenant a day, so a bad cutover touches the fewest people.';

export type AgentKey = 'A' | 'B' | 'C';

interface AgentSpec { agent: AgentKey; name: string; workItemId: string; startBeat: number }

/** Who picks up what, and when (in beats after the story starts). */
export const DEMO_AGENTS: readonly AgentSpec[] = [
  { agent: 'A', name: 'Ada', workItemId: 'wi-auth-e2-b3', startBeat: 1 },
  { agent: 'B', name: 'Basil', workItemId: 'wi-auth-e2-s2', startBeat: 3 },
  { agent: 'C', name: 'Cleo', workItemId: 'wi-auth-e1-b4', startBeat: 5 },
];
/** The open item C reaches for once its first one is done. */
export const DEMO_NEXT_ITEM = 'wi-auth-e1-s3';

export interface DemoAgentState {
  agent: AgentKey;
  name: string;
  workItemId: string;
  runId: string | null;
  boxId: string | null;
  sessionId: string | null;
  label: string | null;
  status: string | null;
}

export interface DemoMilestones {
  /** All three agents' computers have started their runs. */
  running3: boolean;
  /** B ended its run on a question and is waiting for a person. */
  questionAsked: boolean;
  /** Somebody answered B on its session; who did is `answeredBy`. */
  questionAnswered: boolean;
  /** A's change was captured for review (its tail carries a `delivery` frame). */
  captured: boolean;
  /** B's answered run was captured for review too. */
  answerCaptured: boolean;
  /** C's second pickup was refused by a money gate (`gate_refused` in its tail). */
  gateRefused: boolean;
}

export interface DemoState {
  phase: 'idle' | 'starting' | 'dispatching' | 'working' | 'done' | 'stopped' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  beatMs: number;
  milestones: DemoMilestones;
  answeredBy: 'person' | 'director' | null;
  agents: DemoAgentState[];
  /** The 409 body C's second pickup received, verbatim. */
  gate: Record<string, unknown> | null;
  errors: string[];
}

const NO_MILESTONES: DemoMilestones = {
  running3: false, questionAsked: false, questionAnswered: false,
  captured: false, answerCaptured: false, gateRefused: false,
};

function freshState(): DemoState {
  return {
    phase: 'idle', startedAt: null, finishedAt: null, beatMs: demoBeatMs(),
    milestones: { ...NO_MILESTONES }, answeredBy: null,
    agents: DEMO_AGENTS.map((a) => ({
      agent: a.agent, name: a.name, workItemId: a.workItemId,
      runId: null, boxId: null, sessionId: null, label: null, status: null,
    })),
    gate: null, errors: [],
  };
}

/** The director's claim on its agents' computers — the same reservation a
 *  governed run holds (lib/devbox-fleet.ts), so no claimer takes them while
 *  the story runs, between and after their runs included. */
const HOLDER = 'demo-director';

/** Per-start options, from the scenario request; each falls back to its env. */
export interface DemoOptions {
  /** Beat length in ms (else DEMO_DIRECTOR_PACE_MS). */
  paceMs?: number;
  /** false → only a person may answer B (else DEMO_DIRECTOR_AUTO_ANSWER_BEATS). */
  autoAnswer?: boolean;
}
let options: DemoOptions = {};

let state: DemoState = freshState();
let current: { signal: { cancelled: boolean }; done: Promise<void> } | null = null;

/** The director's state, with each computer's live status read fresh. */
export function getDemoState(): DemoState {
  return {
    ...state,
    milestones: { ...state.milestones },
    agents: state.agents.map((a) => ({ ...a, status: a.boxId ? getBox(a.boxId)?.status ?? null : null })),
    errors: [...state.errors],
  };
}

/** Stop the story, wherever it is. Idempotent. */
export function stopDemoDirector(): void {
  for (const a of state.agents) if (a.boxId) releaseBox(a.boxId, HOLDER);
  if (current) {
    current.signal.cancelled = true;
    current = null;
    if (state.phase !== 'done' && state.phase !== 'failed') state.phase = 'stopped';
    state.finishedAt ??= clock.nowIso();
  }
  setDemoActive(false);
}

/** Forget everything — the reset button. */
export function resetDemoDirector(): void {
  stopDemoDirector();
  options = {};
  setDemoPaceOverride(null);
  state = freshState();
}

/**
 * Start the story against the server at `baseUrl` (this process). Returns the
 * promise of the whole story, which tests await; the scenario plane does not.
 */
export function startDemoDirector(baseUrl: string, opts: DemoOptions = {}): Promise<void> {
  resetDemoDirector();
  options = { ...opts };
  if (opts.paceMs !== undefined) setDemoPaceOverride(opts.paceMs);
  state.beatMs = demoBeatMs();
  const signal = { cancelled: false };
  state.phase = 'starting';
  state.startedAt = clock.nowIso();
  setDemoActive(true);
  const done = tell(baseUrl, signal).catch((err: unknown) => {
    if (signal.cancelled) return;
    state.errors.push((err as Error).message);
    state.phase = 'failed';
  }).finally(() => {
    if (signal.cancelled) return;
    state.finishedAt = clock.nowIso();
    setDemoActive(false);
    if (current?.done === done) current = null;
  });
  current = { signal, done };
  return done;
}

// ─── HTTP, as Nora ──────────────────────────────────────────────────────────

class Client {
  private cookie = '';
  constructor(private readonly base: string) {}

  async login(userId: string): Promise<void> {
    const res = await fetch(`${this.base}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`demo: could not sign in as ${userId} (${res.status})`);
    // The login clears any old session cookie and then sets the new one, so
    // the same name arrives twice; the LAST non-empty value per name is the
    // jar's answer (sending both made the server read the cleared one).
    const jar = new Map<string, string>();
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) jar.set(name, value); else jar.delete(name);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (!this.cookie) throw new Error('demo: the login answered without a session cookie');
  }

  async send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  }

  /** A streaming route: start it and let it run, without holding the story on it. */
  fireAndForget(path: string, body: unknown): Promise<number> {
    return fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(body),
    }).then(async (res) => { await res.text().catch(() => ''); return res.status; });
  }
}

// ─── Reading the story off the tails ────────────────────────────────────────

function tailOf(agent: DemoAgentState): FleetEvent[] {
  return agent.boxId ? replayEvents(agent.boxId) : [];
}

const has = (events: FleetEvent[], type: string): boolean => events.some((e) => e['type'] === type);

/** A run that ended on a question: a `result` whose text ends with '?'. */
function askedAQuestion(events: FleetEvent[]): boolean {
  return events.some((e) => e['type'] === 'result' && String(e['result'] ?? '').trimEnd().endsWith('?'));
}

/** A task started on the session after it asked — somebody answered it. */
function startedAfterQuestion(events: FleetEvent[]): boolean {
  const asked = events.findIndex((e) => e['type'] === 'result' && String(e['result'] ?? '').trimEnd().endsWith('?'));
  return asked >= 0 && events.slice(asked + 1).some((e) => e['type'] === 'task_started');
}

function observe(): void {
  const [a, b, c] = state.agents as [DemoAgentState, DemoAgentState, DemoAgentState];
  const m = state.milestones;
  if (!m.running3 && [a, b, c].every((x) => has(tailOf(x), 'task_started'))) m.running3 = true;
  const bTail = tailOf(b);
  if (!m.questionAsked && askedAQuestion(bTail)) m.questionAsked = true;
  if (m.questionAsked && !m.questionAnswered && startedAfterQuestion(bTail)) {
    m.questionAnswered = true;
    state.answeredBy ??= 'person';
  }
  if (!m.captured && has(tailOf(a), 'delivery')) m.captured = true;
  if (!m.answerCaptured && has(bTail, 'delivery')) m.answerCaptured = true;
  if (!m.gateRefused && has(tailOf(c), 'gate_refused')) m.gateRefused = true;
}

/** Wait, observing, until `ready()` holds — bounded by `maxBeats`. */
async function until(ready: () => boolean, maxBeats: number, signal: { cancelled: boolean }, what: string): Promise<void> {
  const stepMs = Math.max(25, Math.min(500, demoBeatMs() / 4));
  // A duration on the monotonic timer, not a timestamp: the mock clock (which a
  // test may freeze) is for what rows say, not for how long to wait.
  const deadline = performance.now() + Math.max(maxBeats * demoBeatMs(), 20_000);
  while (!signal.cancelled) {
    observe();
    if (ready()) return;
    if (performance.now() > deadline) throw new Error(`demo: timed out waiting for ${what}`);
    await new Promise<void>((r) => { const t = setTimeout(r, stepMs); t.unref?.(); });
  }
}

function settled(runId: string | null): boolean {
  if (!runId) return false;
  const row = liveBotRuns.rows().find((r) => r.id === runId);
  return row != null && row.status !== 'running';
}

function titleOf(workItemId: string): string {
  return workItems.rows().find((w) => w.id === workItemId)?.title ?? workItemId;
}

// ─── The story ──────────────────────────────────────────────────────────────

async function tell(baseUrl: string, signal: { cancelled: boolean }): Promise<void> {
  const nora = new Client(baseUrl);
  await nora.login(DEMO_ACTOR);
  if (signal.cancelled) return;

  // ── Three pickups, staggered ────────────────────────────────────────────
  state.phase = 'dispatching';
  let elapsed = 0;
  for (const spec of DEMO_AGENTS) {
    await sleepBeats(spec.startBeat - elapsed, signal);
    elapsed = spec.startBeat;
    if (signal.cancelled) return;
    const agent = state.agents.find((x) => x.agent === spec.agent)!;
    const res = await nora.send('POST', '/api/bots/dispatch-work', { workItemId: spec.workItemId, model: DEMO_MODEL });
    if (signal.cancelled) return;
    if (res.status !== 202) {
      throw new Error(`demo: ${spec.name}'s pickup of ${spec.workItemId} answered ${res.status}: ${String(res.body['error'] ?? '')}`);
    }
    const run = res.body['run'] as { id: string; outcome?: { boxId?: string; sessionId?: string } };
    agent.runId = run.id;
    agent.boxId = run.outcome?.boxId ?? null;
    agent.sessionId = run.outcome?.sessionId ?? null;
    if (agent.boxId) reserveBox(agent.boxId, HOLDER);
    const box = agent.boxId ? getBox(agent.boxId) : null;
    if (box) {
      // The agent's name on its computer, through the real rename route.
      const label = `${spec.name} · ${box.label}`;
      const renamed = await nora.send('PATCH', `/api/devbox/boxes/${box.id}`, { label });
      agent.label = renamed.status === 200 ? label : box.label;
    }
  }
  state.phase = 'working';
  const [a, b, c] = state.agents as [DemoAgentState, DemoAgentState, DemoAgentState];

  await until(() => state.milestones.running3, 40, signal, 'all three computers to start');

  // ── B's question: a person answers, or the director does for Nora ───────
  const answering = (async () => {
    await until(() => state.milestones.questionAsked, 80, signal, `${b.name} to ask its question`);
    const patience = options.autoAnswer === false ? 0
      : Number(process.env['DEMO_DIRECTOR_AUTO_ANSWER_BEATS'] ?? 20);
    if (!(patience > 0)) return;              // 0 → only a person may answer
    const waitedUntil = performance.now() + patience * demoBeatMs();
    while (!signal.cancelled && !state.milestones.questionAnswered && performance.now() < waitedUntil) {
      await sleepBeats(0.25, signal);
      if (demoBeatMs() === 0) break;
      observe();
    }
    if (signal.cancelled || state.milestones.questionAnswered || !b.sessionId) return;
    state.answeredBy = 'director';
    void nora.fireAndForget(`/api/devbox/${encodeURIComponent(b.sessionId)}/task`, { prompt: DEMO_ANSWER, resume: true });
  })();

  // ── C: done, settled, reaches for the next item ─────────────────────────
  await until(() => has(tailOf(c), 'delivery') && has(tailOf(a), 'delivery'), 120, signal,
    `${a.name}'s and ${c.name}'s changes to reach review`);
  // Settle what has finished — the scheduler's reconcile tick, run now.
  await until(() => {
    void reconcileBotRuns().catch(() => { /* the next poll retries */ });
    return settled(a.runId) && settled(c.runId);
  }, 40, signal, `${a.name}'s and ${c.name}'s runs to settle`);
  if (signal.cancelled) return;

  await sleepBeats(2, signal);
  if (signal.cancelled || !c.boxId) return;
  const nextTitle = titleOf(DEMO_NEXT_ITEM);
  appendEvent(c.boxId, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: `Done with that one. Picking up the next open item on Auth Migration: ${nextTitle}.` }] },
    ts: clock.nowIso(),
  });
  await sleepBeats(1, signal);
  if (signal.cancelled) return;
  const next = await nora.send('POST', '/api/bots/dispatch-work', { workItemId: DEMO_NEXT_ITEM, model: DEMO_MODEL });
  if (signal.cancelled) return;
  if (next.status === 409 && typeof next.body['gate'] === 'string') {
    state.gate = next.body;
    appendEvent(c.boxId, {
      ...next.body,
      type: 'gate_refused', status: 409,
      workItemId: DEMO_NEXT_ITEM, workItemTitle: nextTitle,
      ts: clock.nowIso(),
    });
  } else {
    state.errors.push(`demo: ${c.name}'s second pickup was expected to be held at a money gate, and answered ${next.status}: ${String(next.body['error'] ?? '')}`);
  }

  // ── B finishes once answered ─────────────────────────────────────────────
  await answering;
  // With only a person allowed to answer, wait as long as the question itself
  // is held open (the fake microVM releases it after 20 minutes), not a few beats.
  const answerBeats = options.autoAnswer === false
    ? Math.ceil((20 * 60_000) / Math.max(1, demoBeatMs())) : 120;
  await until(() => state.milestones.answerCaptured, answerBeats, signal, `${b.name}'s answered run to reach review`);
  observe();
  state.phase = state.errors.length > 0 ? 'failed' : 'done';
}
