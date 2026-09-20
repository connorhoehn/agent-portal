// Devbox fleet registry — the server-side source of truth for boxes.
//
// Before this module, box state lived in browser localStorage and task streams
// existed only in the tab that started them. The herd/queue vision (boxes as
// workers pulling queued jobs, operators tailing any box read-only) needs the
// middleware to own three things:
//
//   1. The registry — which boxes exist, labels, session ids.
//   2. Status — idle | running | waiting | stopped | error, derived from the
//      task event flow (not client claims). `waiting` = the last run ended by
//      asking the operator a question.
//   3. The event log — every task event teed into a per-box ring buffer with
//      live subscribers, so ANY client can tail ANY box (SSE replay + live).
//
// In-memory (mirrors canary-broker.ts). The portal keeps a localStorage mirror
// and re-adopts boxes if the middleware restarts, so dev-loop restarts don't
// strand sessions. Promote to Aurora when fleets need to survive deploys.

import { parseReportedCost } from './run-cost.js';

export type BoxStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

export interface FleetBox {
  id: string;
  label: string;
  sessionId: string;
  createdAt: string;
  status: BoxStatus;
  lastActivityAt: string;
  /**
   * Who provisioned it, as a session sub. Taken from the session, never the
   * request body — same rule as bot_runs.dispatched_by, and for the same
   * reason: an attribution a caller can set is not an attribution.
   *
   * Absent on boxes the fleet made for itself (the job dispatcher, a bot run)
   * and on boxes that predate the field. Those are nobody's personal computer,
   * so they fall to the project rule below, and to admin when there is no
   * project either.
   */
  ownerId?: string;
  /**
   * The initiative this computer is charged to and shared across.
   *
   * A computer with a project is visible to everyone attached to that
   * initiative — the owner and its SMEs — because that is what makes it a
   * shared work surface rather than one person's shell. A computer without one
   * is personal to its owner.
   */
  projectId?: string;
  /** Prompt of the current/last task (truncated). */
  currentTask?: string;
  /** `costUsd` is null when the run reported no figure — see `parseReportedCost`. */
  lastResult?: { subtype: string; turns: number; durationMs: number; costUsd: number | null };
  /**
   * Dollars charged to this box, summed across every `result` event it has
   * ever produced — lifetime, not per-task, because that is what a cost
   * centre bills against. In a real deployment this is the runtime's own
   * reported `total_cost_usd`; the mock accrues the same field so the
   * Computer Lab's spend column is exercised without a live runtime.
   */
  spendUsd?: number;
  /**
   * Tokens burned on this box, lifetime, summed the same way as `spendUsd`
   * from whichever event actually carries a usage block (a `result` event
   * inline, or an `assistant` event nested under `message.usage` — the two
   * shapes the real CLI stream uses). Real deployments get this from the
   * runtime's own token accounting; the mock sums the scripted runs' usage
   * fields so the same accrual path is exercised offline.
   *
   * Counts input + cache-creation + output. Cache READS are deliberately
   * excluded: a cached prefix is re-sent every turn, so adding it each time
   * would grow this counter without any new tokens being processed.
   */
  tokensUsed?: number;
  /**
   * Fraction (0-1) of the model's context window in use on the CURRENT
   * task — unlike `spendUsd`/`tokensUsed` this resets at `task_started`,
   * because a new task is a new conversation from the model's point of view
   * even though lifetime spend keeps accumulating. Measured against a nominal
   * 200k-token window (Claude's).
   *
   * The PEAK prompt size seen this task, not a sum of the task's turns — the
   * prompt a turn reports already contains the whole conversation so far
   * (mostly as cache reads), so summing turns double-counts the same tokens
   * and marches the gauge to its clamp on any multi-turn run. This is what an
   * operator reads to decide a box needs recycling, so it has to mean
   * occupancy, not throughput.
   */
  contextUsed?: number;
  /**
   * Model the last (or current) run resolved to. Set from a `model` field on
   * a run-start event (`devbox_start`, or `task_started`/`job_started` when
   * that is what announces it) — the same place a real runtime reports back
   * which model it actually used, since a caller's requested model can be
   * downgraded server-side (see devboxModels.ts).
   */
  activeModel?: string;
}

export type FleetEvent = Record<string, unknown>;

const EVENT_BUFFER_CAP = 500;
const TASK_SNIPPET_LEN = 140;

/** Nominal context window (tokens) used to derive `contextUsed`. Claude's. */
const NOMINAL_CONTEXT_WINDOW = 200_000;

interface BoxState {
  box: FleetBox;
  events: FleetEvent[];
  subscribers: Set<(ev: FleetEvent) => void>;
  /** Final assistant text of the last run — drives the `waiting` heuristic. */
  lastResultText: string;
  /**
   * Peak prompt size seen in the box's CURRENT task, separate from the
   * lifetime `box.tokensUsed` counter — this is the numerator behind
   * `contextUsed` and gets zeroed at `task_started` while the lifetime counter
   * keeps climbing. A high-water mark, not a running total: context is a level.
   */
  contextTokens: number;
}

const boxes = new Map<string, BoxState>();
const bySession = new Map<string, string>(); // sessionId → boxId

/**
 * Source-owned lifecycle feed. It deliberately carries the full server-side
 * box only to trusted in-process producers; browser/SSE consumers continue to
 * receive the narrow fleet event stream below.
 */
export type FleetLifecycleEvent = { kind: 'created' | 'updated' | 'removed'; box: FleetBox };
const lifecycleSubscribers = new Set<(event: FleetLifecycleEvent) => void>();

function emitLifecycle(kind: FleetLifecycleEvent['kind'], box: FleetBox): void {
  for (const callback of lifecycleSubscribers) {
    try { callback({ kind, box: { ...box } }); } catch { /* producer faults cannot break fleet truth */ }
  }
}

export function subscribeLifecycle(callback: (event: FleetLifecycleEvent) => void): () => void {
  lifecycleSubscribers.add(callback);
  return () => lifecycleSubscribers.delete(callback);
}

/**
 * Optional durable mirror of the registry.
 *
 * The maps above are the running process's source of truth and stay
 * SYNCHRONOUS — `registerBox` is called from request handlers, the dispatcher
 * and the reaper, and making it async would ripple through every one of them.
 * So persistence is a seam rather than a rewrite: the store is told what
 * changed, fire-and-forget, and a store that is absent (no Aurora, mocked
 * Aurora, a laptop) leaves this module behaving exactly as it always did.
 *
 * Why it exists at all: without it a middleware restart drops every box while
 * the AgentCore sessions keep running. `devbox-reaper` reaps only what
 * `listBoxes()` returns, so a forgotten session sits outside BOTH the idle
 * timeout and the max-lifetime ceiling, permanently — and no AgentCore API
 * enumerates live runtime sessions to reconcile against
 * (`list-sessions` is Memory, not Runtime). Verified live on 2026-09-09:
 * after a restart `GET /boxes` returned an empty fleet while the orphan still
 * answered commands with its workspace intact.
 */
export interface FleetStore {
  /** A box was created, renamed, or changed status. Full row, upserted. */
  upsert(box: FleetBox): void;
  /** A box is gone for good. */
  remove(id: string): void;
  /**
   * A box's activity clock (and accrued cost) moved. Called on EVERY event, so
   * an implementation must throttle — a short real run emits tens of events and
   * `thinking_tokens` alone can fire several times a second.
   */
  touch(box: FleetBox): void;
}

let store: FleetStore | null = null;

/** Attach (or, with null, detach) the durable mirror. */
export function setFleetStore(next: FleetStore | null): void {
  store = next;
}

/**
 * Load persisted boxes into the registry at boot.
 *
 * Writes straight into the maps rather than going through `registerBox`,
 * because `registerBox` stamps a FRESH `lastActivityAt` and runs `createdAt`
 * through `trustedCreatedAt`. Re-stamping here would hand every hydrated box a
 * brand-new idle clock on every restart — which is precisely the bug this
 * whole mechanism exists to remove, only quieter: the box would be visible and
 * still never age out. The stored timestamps ARE the truth; use them.
 *
 * Event buffers are deliberately not restored. They are a cache of a stream
 * that has already ended, capped at 500, and a tail that replays a dead run
 * from before the restart is worse than one that starts empty.
 */
export function hydrateBoxes(rows: readonly FleetBox[]): number {
  let loaded = 0;
  for (const box of rows) {
    if (boxes.has(box.id)) continue;      // a live box always wins over a stored one
    boxes.set(box.id, {
      box: { ...box },
      events: [],
      subscribers: new Set(),
      lastResultText: '',
      contextTokens: 0,
    });
    bySession.set(box.sessionId, box.id);
    // A persisted box did not pass through registerBox in this process. Let
    // trusted lifecycle consumers reconcile its deterministic source event
    // after hydration; browser subscribers remain unchanged.
    emitLifecycle('created', box);
    loaded++;
  }
  return loaded;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * A trustworthy `createdAt` for a box.
 *
 * `POST /api/devbox/boxes` lets a caller supply this so a client can re-adopt
 * a box it already knows about after a middleware restart without resetting
 * the box's age — the age is what the reaper's max-lifetime ceiling is measured
 * from, so preserving a *past* timestamp is the point of the parameter.
 *
 * A future or unparseable one has no such meaning, and both defeat the
 * ceiling: `decideReaping` computes `age = now - createdAt` and reaps at
 * `age >= MAX_LIFETIME_MS`, so a future date makes `age` negative and an
 * unparseable one makes it `NaN` — and the `Number.isFinite` guard then skips
 * the box. Either way the 60-minute ceiling never fires again. That ceiling is
 * not a tidiness feature: it is there for the box that keeps itself busy, which
 * the idle timer by design will not catch, so evading it means paying for a
 * microVM indefinitely. Verified against the running middleware before this
 * fix — `createdAt` ten years ahead was accepted verbatim and reported
 * `lifetimeMsLeft` of ~10 years.
 *
 * So: accept the past, clamp the future to now, and treat garbage as now.
 * Clamping rather than rejecting keeps re-adoption working — the caller is
 * usually a browser whose clock is merely skewed, not an attacker — while
 * making the ceiling unconditional.
 */
function trustedCreatedAt(supplied: string | undefined): string {
  if (!supplied) return now();
  const t = new Date(supplied).getTime();
  if (!Number.isFinite(t)) return now();
  return t > Date.now() ? now() : new Date(t).toISOString();
}

export function registerBox(opts: {
  sessionId: string; label?: string; id?: string; createdAt?: string;
  ownerId?: string; projectId?: string;
}): FleetBox {
  const id = opts.id ?? opts.sessionId.slice(-8);
  const existing = boxes.get(id);
  if (existing) return existing.box;
  const box: FleetBox = {
    id,
    label: opts.label ?? `computer-${boxes.size + 1}`,
    sessionId: opts.sessionId,
    createdAt: trustedCreatedAt(opts.createdAt),
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    status: 'idle',
    lastActivityAt: now(),
  };
  boxes.set(id, { box, events: [], subscribers: new Set(), lastResultText: '', contextTokens: 0 });
  bySession.set(opts.sessionId, id);
  store?.upsert(box);
  emitLifecycle('created', box);
  return box;
}

export function listBoxes(): FleetBox[] {
  return [...boxes.values()].map((s) => s.box)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getBox(id: string): FleetBox | null {
  return boxes.get(id)?.box ?? null;
}

export function getBoxBySession(sessionId: string): FleetBox | null {
  const id = bySession.get(sessionId);
  return id ? getBox(id) : null;
}

export function renameBox(id: string, label: string): FleetBox | null {
  const s = boxes.get(id);
  if (!s) return null;
  s.box.label = label;
  store?.upsert(s.box);
  return s.box;
}

export function markStopped(id: string): void {
  const s = boxes.get(id);
  if (!s) return;
  s.box.status = 'stopped';
  s.box.lastActivityAt = now();
  store?.upsert(s.box);
  emitLifecycle('updated', s.box);
}

/**
 * Remove a box, telling anyone tailing it that this is the end of the stream.
 *
 * The terminal event is the point. Removing a box drops the registry entry but
 * cannot by itself close the SSE responses already attached to it, and an
 * abandoned tail does not look abandoned: `initSSE`'s 25s heartbeat keeps
 * arriving, so the socket stays healthy, `onerror` never fires, and a
 * heartbeat-watchdog client (portal RunTimeline / JobDetailPage) is reassured
 * by the very signal that is supposed to catch a dead stream. Observed on
 * 2026-09-09 against the running middleware: a box was removed at 15:46:04 and
 * its tail went on heartbeating every 25s until the CLIENT gave up at 15:47:44.
 * A viewer would have sat in front of a live-looking log that could never
 * produce another line.
 *
 * So say so explicitly, and only here: `markStopped` deliberately does NOT emit
 * this, because a stopped box still exists and is still worth watching.
 */
export function removeBox(id: string): boolean {
  const s = boxes.get(id);
  if (!s) return false;
  for (const cb of s.subscribers) {
    try { cb({ type: 'box_removed', boxId: id, ts: now() }); } catch { /* one bad subscriber must not block the rest */ }
  }
  s.subscribers.clear();
  // Emit before removing it: this is the last point at which the server has
  // the durable owner/project join needed to make a safe deletion event.
  emitLifecycle('removed', s.box);
  bySession.delete(s.box.sessionId);
  boxes.delete(id);
  store?.remove(id);
  return true;
}

/** Snapshot of a box's event buffer (oldest-first). */
export function replayEvents(id: string): FleetEvent[] {
  return [...(boxes.get(id)?.events ?? [])];
}

export function subscribe(id: string, cb: (ev: FleetEvent) => void): () => void {
  const s = boxes.get(id);
  if (!s) return () => {};
  s.subscribers.add(cb);
  return () => { s.subscribers.delete(cb); };
}

/**
 * The two token numbers an event carries, from whichever shape the CLI stream
 * actually uses: a `result` event carries `usage` inline; an `assistant` event
 * nests it under `message.usage` (the same nested shape `says()`/`uses()` in
 * mock-bot-runner.ts model). Returns nulls for an event with no usage block at
 * all, which is most of them (tool calls, status events).
 *
 * Both numbers must count the CACHE fields, and that is the whole point of
 * this function. Claude Code sends the system prompt and conversation prefix
 * as a prompt cache, so on a real run `cache_creation_input_tokens` /
 * `cache_read_input_tokens` are where nearly all the tokens live and
 * `input_tokens` is a rounding error. Measured against the deployed devbox on
 * 2026-09-09, a one-sentence no-tool task reported
 * `input_tokens: 10, cache_creation_input_tokens: 21931, output_tokens: 55` —
 * so summing only input+output counted 65 tokens from that event out of
 * ~22k actually processed (91 across the whole run, once the assistant turn
 * was added). The box's context gauge read 0.05% when true occupancy was
 * ~11%. That gauge is the signal for "this box needs recycling", so
 * undercounting it ~240x does not make it merely imprecise, it makes it
 * useless.
 *
 * The two numbers are genuinely different and must not be conflated:
 *
 *   prompt  — how big the conversation was on this turn. A LEVEL. Includes
 *             cache_read, because a re-read prefix still occupies the window.
 *   fresh   — tokens new to the conversation this turn. A FLOW. Excludes
 *             cache_read, because those tokens were already counted on the
 *             turn that created them; adding them every turn would inflate a
 *             long run's lifetime burn without any new tokens being processed.
 */
function extractUsage(ev: FleetEvent): { prompt: number; fresh: number } | null {
  interface UsageBlock {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  }
  const direct = ev['usage'] as UsageBlock | undefined;
  const nested = (ev['message'] as { usage?: UsageBlock } | undefined)?.usage;
  const usage = direct ?? nested;
  if (!usage) return null;

  const n = (v: unknown): number => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const cacheWrite = n(usage.cache_creation_input_tokens);
  const cacheRead = n(usage.cache_read_input_tokens);

  return {
    prompt: input + cacheWrite + cacheRead + output,
    fresh: input + cacheWrite + output,
  };
}

/**
 * Tee a task event into the box's log and drive the status machine.
 * Synthetic `task_started` events (emitted by the route before invoking the
 * runtime) flip the box to running; `devbox_end` settles it back to idle — or
 * `waiting` when the run's final answer ends with a question for the operator.
 *
 * Also drives the cost-centre fields (`spendUsd`, `tokensUsed`,
 * `contextUsed`, `activeModel`). These exist so the Computer Lab's per-box
 * cost story renders in mock mode exactly as it would against a real
 * runtime — in production every one of these numbers comes from the
 * runtime's own telemetry (Bedrock's `total_cost_usd`/`usage`, the model it
 * actually resolved to); this function's job is only to accrue them onto the
 * box the same way regardless of who is producing the events.
 */
export function appendEvent(id: string, ev: FleetEvent): void {
  const s = boxes.get(id);
  if (!s) return;

  const priorStatus = s.box.status;

  s.events.push(ev);
  if (s.events.length > EVENT_BUFFER_CAP) s.events.shift();
  s.box.lastActivityAt = now();
  // Every event moves the idle clock, so this is the hot path — the store is
  // responsible for throttling, not the caller.
  store?.touch(s.box);

  const type = ev['type'];

  // Tokens accrue from ANY event carrying a usage block, not just `result` —
  // a long run's intermediate `assistant` turns burn context too, and waiting
  // for the final result would make contextUsed jump from 0 to its true value
  // instead of climbing as the run progresses.
  //
  // The two counters move differently on purpose (see extractUsage): lifetime
  // burn SUMS the fresh tokens of every turn, while context occupancy TRACKS
  // THE PEAK prompt size rather than summing. Summing prompt sizes was the
  // old behaviour and is wrong by construction — a conversation's context is
  // how big it currently is, not the total of how big it has ever been, so on
  // a multi-turn run the sum races past the window and pins the gauge at 99%
  // while the box is nowhere near full. Peak rather than last, because a
  // `result` event's usage can report a smaller prompt than the assistant turn
  // that preceded it, and a gauge that walks backwards mid-run reads as a bug.
  const usage = extractUsage(ev);
  if (usage) {
    if (usage.fresh > 0) s.box.tokensUsed = (s.box.tokensUsed ?? 0) + usage.fresh;
    if (usage.prompt > s.contextTokens) s.contextTokens = usage.prompt;
    s.box.contextUsed = Math.min(0.99, s.contextTokens / NOMINAL_CONTEXT_WINDOW);
  }

  // Model announcement: whichever run-start event carries one. `devbox_start`
  // is the runtime's own announcement; `task_started`/`job_started` cover the
  // mock and any caller that folds the model into the kickoff event instead.
  const model = ev['model'];
  if (
    (type === 'devbox_start' || type === 'task_started' || type === 'job_started') &&
    typeof model === 'string' && model
  ) {
    s.box.activeModel = model;
  }

  if (type === 'task_started') {
    s.box.status = 'running';
    s.box.currentTask = String(ev['prompt'] ?? '').slice(0, TASK_SNIPPET_LEN);
    s.lastResultText = '';
    // A new task is a new conversation from the model's point of view, even
    // though lifetime spend/tokensUsed on the box keep climbing across tasks.
    s.contextTokens = 0;
    s.box.contextUsed = 0;
  } else if (type === 'result') {
    // One parser for the reported cost, shared with `lib/devbox-runner.ts`,
    // which reads the same event on the durable path. This was independently
    // `Number(ev['total_cost_usd'] ?? 0)` in both places, and only one of them
    // got fixed the first time.
    const cost = parseReportedCost(ev);
    s.box.lastResult = {
      subtype: String(ev['subtype'] ?? ''),
      turns: Number(ev['num_turns'] ?? 0),
      durationMs: Number(ev['duration_ms'] ?? 0),
      costUsd: cost,
    };
    // Lifetime spend, summed rather than replaced — a box racks up cost
    // across every run it has ever played, which is the whole point of a
    // cost centre: it bills against the box's life, not its last task.
    if (cost !== null && cost > 0) {
      s.box.spendUsd = (s.box.spendUsd ?? 0) + cost;
    }
    if (typeof ev['result'] === 'string') s.lastResultText = ev['result'];
  } else if (type === 'devbox_end') {
    if (s.box.status === 'running') {
      s.box.status = s.lastResultText.trimEnd().endsWith('?') ? 'waiting' : 'idle';
    }
  } else if (type === 'devbox_error') {
    s.box.status = 'error';
  }

  if (s.box.status !== priorStatus) emitLifecycle('updated', s.box);

  for (const cb of s.subscribers) {
    try { cb(ev); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

/** Test hook — wipe all fleet state. */
export function _resetFleet(): void {
  boxes.clear();
  bySession.clear();
  store = null;
  lifecycleSubscribers.clear();
}
