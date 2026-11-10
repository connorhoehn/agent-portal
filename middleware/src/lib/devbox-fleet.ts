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

import { parseReportedCost, parseResultUsage } from './run-cost.js';
import { estimateUsageCost } from './pricing.js';
import type { FleetSharedBackend } from './devbox-fleet-shared.js';

/**
 * `provisioning` — the box is minted in the registry but its microVM is not up
 * yet (the clone that boots it is still in flight). The first `task_started`
 * moves it to `running`, exactly as it moves an idle box.
 */
export type BoxStatus = 'provisioning' | 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

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
  /**
   * Who created this box, when it was not a person clicking "new computer" in
   * the portal — e.g. `'platform-api'` for a box `routes/internal-devbox.ts`
   * registered on behalf of a chat `/agent` loop. Absent for portal-created
   * boxes, which is the common case and needs no marker. Purely descriptive:
   * it changes nothing about `canSee`/visibility, ownership still comes from
   * `ownerId`/`projectId` — this only tells an operator where a box came from.
   */
  source?: string;
  /**
   * The devbox policy profile this box was created under (DE-40), as the
   * `(id, version)` of a `devbox_profiles` row. Stamped once, at creation or
   * first task, and never moved: a running box does not change rules
   * mid-task. The reaper may use a NEWER version only to shorten a lifetime
   * (lib/devbox-profile.ts lifetimePoliciesFor). Absent on boxes that predate
   * profiles; they resolve through their initiative.
   */
  profileId?: string;
  profileVersion?: number;
  /**
   * When the current task began (DE-48). The reaper bounds a RUNNING box by
   * `now - taskStartedAt` against the task's timeout plus grace, not by box
   * age — a long task on an old, reused box used to be cut at the ceiling.
   * Set at `task_started`; kept after the task ends (only read while running).
   */
  taskStartedAt?: string;
  /**
   * Whose work the box's workspace and Claude Code session hold: the session
   * sub of the last person to send it a task or queue its job, or
   * `bot:<id>` / `fleet` for unattributed work. A box is reused across people (the
   * dispatcher hands any idle box the next job), so this is what decides
   * whether `resume` may continue the conversation (only the same occupant)
   * and whether the workspace is wiped first (lib/devbox-fleet.ts
   * changesHands). Absent on a box no task has reached yet.
   */
  lastOccupant?: string;
}

/**
 * Whether handing `box` to `occupant` crosses from one person's work to
 * another's. A box that never ran a task holds nobody's work; one whose last
 * occupant is unknown (it ran before this field was stored) is treated as
 * someone else's: the conservative reading. The field is persisted with the
 * box (devbox_boxes.last_occupant, the mock restart mirror, the shared fleet
 * record), so a restart does not forget it. Callers wipe only a fleet-owned
 * box on a change of hands (isFleetOwnedBox).
 */
export function changesHands(box: FleetBox, occupant: string): boolean {
  const used = Boolean(box.lastOccupant || box.currentTask || box.lastResult);
  return used && box.lastOccupant !== occupant;
}

/** Record who now occupies the box (see FleetBox.lastOccupant). */
export function setOccupant(id: string, occupant: string): void {
  const s = boxes.get(id);
  if (!s || s.box.lastOccupant === occupant) return;
  s.box.lastOccupant = occupant;
  structural(s);
}

/** A box the fleet made for itself: nobody's personal computer, on no initiative. */
export function isFleetOwnedBox(box: FleetBox): boolean {
  return !box.ownerId && !box.projectId;
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
  /**
   * When this process last changed the box's structure (status, label, task
   * clock), epoch ms. Compared with the shared record's `stateAt` (DE-47) so a
   * refresh adopts another replica's newer status and never an older one.
   */
  stateAt: number;
  /** Unsubscribe from the box's cross-replica event channel, while tailed. */
  remoteTail?: Promise<(() => Promise<void>) | null>;
}

import { mockRestartMirror } from '../mock/restart-state.js';

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
 * Additional mirrors, told the same things as the durable store. The compute
 * registry (work-graph/compute-registry-runtime.ts) is one: it shares box
 * registrations across replicas with a TTL, independently of whether the
 * Aurora mirror above is attached. Returns a detach function.
 */
const mirrors = new Set<FleetStore>();
export function addFleetMirror(mirror: FleetStore): () => void {
  mirrors.add(mirror);
  return () => { mirrors.delete(mirror); };
}

function tellStores(fn: (s: FleetStore) => void): void {
  if (store) fn(store);
  for (const mirror of mirrors) {
    try { fn(mirror); } catch { /* a mirror must never break a registry write */ }
  }
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
      stateAt: 0,
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

/**
 * A readable name for a box the fleet mints for an initiative.
 *
 * The seed's own convention — `auth-migration-1`, `observability-1` — and the
 * reason the lab's rail groups at all: a dispatch used to land on
 * `computer-6`, which sorts next to nothing and says nothing about the work it
 * was created for. The index counts existing boxes on the same initiative, so
 * the second computer on Auth Migration is `auth-migration-2`.
 */
function labelForProject(projectId: string): string {
  const stem = projectId.replace(/^p-/, '');
  const taken = [...boxes.values()].filter((s) => s.box.projectId === projectId).length;
  return `${stem}-${taken + 1}`;
}

export function registerBox(opts: {
  sessionId: string; label?: string; id?: string; createdAt?: string;
  ownerId?: string; projectId?: string; source?: string;
  /** The policy profile the box is created under (DE-40); see FleetBox.profileId. */
  profile?: { id: string; version: number };
  /** Only `provisioning` may be asked for: a box minted before its microVM is
   *  up. Anything else is derived from the event flow, never claimed. */
  status?: 'provisioning';
}): FleetBox {
  const id = opts.id ?? opts.sessionId.slice(-8);
  const existing = boxes.get(id);
  if (existing) return existing.box;
  const box: FleetBox = {
    id,
    label: opts.label ?? (opts.projectId ? labelForProject(opts.projectId) : `computer-${boxes.size + 1}`),
    sessionId: opts.sessionId,
    createdAt: trustedCreatedAt(opts.createdAt),
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.profile ? { profileId: opts.profile.id, profileVersion: opts.profile.version } : {}),
    status: opts.status ?? 'idle',
    lastActivityAt: now(),
  };
  boxes.set(id, { box, events: [], subscribers: new Set(), lastResultText: '', contextTokens: 0, stateAt: 0 });
  bySession.set(opts.sessionId, id);
  structural(boxes.get(id)!);
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
  structural(s);
  return s.box;
}

/**
 * Stamp the profile a box runs under (DE-40). Write-once: a box that already
 * carries a stamp keeps it, because a running box never changes rules
 * mid-task — a newer profile version reaches it only through the reaper's
 * tightening (lib/devbox-profile.ts). Returns the stamp the box now carries.
 */
export function setBoxProfile(id: string, profile: { id: string; version: number }): { id: string; version: number } | null {
  const s = boxes.get(id);
  if (!s) return null;
  if (s.box.profileId && s.box.profileVersion) return { id: s.box.profileId, version: s.box.profileVersion };
  s.box.profileId = profile.id;
  s.box.profileVersion = profile.version;
  structural(s);
  return { ...profile };
}

export function markStopped(id: string): void {
  const s = boxes.get(id);
  if (!s) return;
  s.box.status = 'stopped';
  s.box.lastActivityAt = now();
  structural(s);
  if (shared) releaseBox(id, taskHolder());
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
  tellStores((t) => t.remove(id));
  endRemoteTail(s);
  sharedWrite((b) => b.removeBox(id));
  return true;
}

/** Snapshot of a box's event buffer (oldest-first). */
export function replayEvents(id: string): FleetEvent[] {
  return [...(boxes.get(id)?.events ?? [])];
}

/**
 * Fill a box's replay buffer with history, WITHOUT the status machine.
 *
 * For the offline seed only (mock/devbox-tail.ts): a hydrated box's row
 * already says what state it is in and what it cost, so replaying its history
 * through `appendEvent` would flip it to running and accrue its tokens a
 * second time. Subscribers are not notified — this is the past, not news.
 * Capped like any buffer; a no-op for an unknown box.
 */
export function seedEventLog(id: string, events: readonly FleetEvent[]): void {
  const s = boxes.get(id);
  if (!s) return;
  s.events.push(...events);
  if (s.events.length > EVENT_BUFFER_CAP) s.events.splice(0, s.events.length - EVENT_BUFFER_CAP);
}

export function subscribe(id: string, cb: (ev: FleetEvent) => void): () => void {
  const s = boxes.get(id);
  if (!s) return () => {};
  s.subscribers.add(cb);
  // A tail here must also see a run another replica is executing (DE-47).
  if (shared && !s.remoteTail) startRemoteTail(id, s);
  return () => {
    s.subscribers.delete(cb);
    if (s.subscribers.size === 0) endRemoteTail(s);
  };
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
  tellStores((t) => t.touch(s.box));
  sharedTouch(id);

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
    // The clock the reaper bounds a running box by (DE-48): the task's own
    // start, never the box's. Structural, so it is written through now rather
    // than coalesced — a crash between here and the next flush would leave a
    // running box with no start on its row.
    s.box.taskStartedAt = now();
    s.box.currentTask = String(ev['prompt'] ?? '').slice(0, TASK_SNIPPET_LEN);
    s.lastResultText = '';
    // A new task is a new conversation from the model's point of view, even
    // though lifetime spend/tokensUsed on the box keep climbing across tasks.
    s.contextTokens = 0;
    s.box.contextUsed = 0;
    structural(s);
    // A run in flight is a hold every replica can see (DE-47): another
    // replica's dispatcher, whose copy of this box may still read idle, must
    // not push a job onto it. Only with shared state; one process already
    // knows the box is running.
    if (shared) reserveBox(id, taskHolder());
  } else if (type === 'result') {
    // One parser for the reported cost, shared with `lib/devbox-runner.ts`,
    // which reads the same event on the durable path. This was independently
    // `Number(ev['total_cost_usd'] ?? 0)` in both places, and only one of them
    // got fixed the first time.
    // When no figure was reported, the usage block priced through the table
    // (DE-32; `pricing.ts` sees the Claude rates once lib/model-prices.ts has
    // registered them at boot). Null stays null: a box never accrues a zero.
    const reported = parseReportedCost(ev);
    const usage = reported === null ? parseResultUsage(ev) : null;
    const cost = reported ?? (usage && s.box.activeModel ? estimateUsageCost(s.box.activeModel, usage) : null);
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
    if (shared) releaseBox(id, taskHolder());
  } else if (type === 'devbox_error') {
    s.box.status = 'error';
    if (shared) releaseBox(id, taskHolder());
  }

  if (s.box.status !== priorStatus) {
    // A status another replica must see (idle after a run, error) is
    // structural for the shared record, though the Aurora mirror keeps
    // coalescing it as it always has. task_started was written above.
    if (type !== 'task_started') shareState(s);
    emitLifecycle('updated', s.box);
  }

  for (const cb of s.subscribers) {
    try { cb(ev); } catch { /* one bad subscriber must not break the fan-out */ }
  }
  sharedWrite((b) => b.publish(id, JSON.stringify({ origin: shared!.replicaId, ev })));
}

// ─── Reservations and claims ─────────────────────────────────────────────────
//
// Status says what a box is DOING; it cannot say who is still counting on it.
// A governed run waiting on its operator reads `waiting`, and the box a run
// just finished on reads `idle` — and both claimers (lib/job-dispatcher.ts,
// lib/mock-bot-runner.ts) took exactly those statuses as "free", so a queued
// job could land in the middle of somebody's open run. A reservation is the
// missing fact: a holder names the box as theirs until it releases it, and
// every claimer asks `isReserved` before taking one. Several holders may hold
// one box; it is free when the last lets go.
//
// A CLAIM (`claimBox`) is the exclusive form the dispatcher takes before it
// pushes a job: it succeeds only when nobody else holds the box. With shared
// state attached (DE-47) both live in the shared store too, with an expiry
// this process renews, so a dispatcher on another replica sees them and a
// dead replica's holds lapse on their own. Without shared state they are this
// process's Map, exactly as before.

const reservations = new Map<string, Set<string>>(); // boxId → holders (this process)
/** Holders other processes hold, per box, as of the last shared refresh. */
let remoteHolds = new Map<string, string[]>();

function addLocalHold(id: string, holder: string): void {
  let holders = reservations.get(id);
  if (!holders) { holders = new Set(); reservations.set(id, holders); }
  holders.add(holder);
}

export function reserveBox(id: string, holder: string): void {
  addLocalHold(id, holder);
  sharedWrite((b) => b.hold(id, holder, shared!.holdTtlMs, false).then(() => undefined));
}

export function releaseBox(id: string, holder: string): void {
  const holders = reservations.get(id);
  if (holders) {
    holders.delete(holder);
    if (holders.size === 0) reservations.delete(id);
  }
  const remote = remoteHolds.get(id);
  if (remote?.includes(holder)) {
    const rest = remote.filter((h) => h !== holder);
    if (rest.length) remoteHolds.set(id, rest); else remoteHolds.delete(id);
  }
  sharedWrite((b) => b.release(id, holder));
}

/**
 * Whether anyone holds this box — claimers must leave it alone. Synchronous:
 * other replicas' holds are as fresh as the last `refreshSharedHolds`, which
 * the dispatcher runs every tick and the reaper every sweep.
 */
export function isReserved(id: string): boolean {
  return (reservations.get(id)?.size ?? 0) > 0 || (remoteHolds.get(id)?.length ?? 0) > 0;
}

/**
 * Take the box exclusively for `holder`, or say no. No when anyone else holds
 * it here; with shared state, also when anyone holds it elsewhere — and when
 * the shared store cannot answer, because pushing work onto a box another
 * replica may be using is the failure this exists to stop (fail closed).
 */
export async function claimBox(id: string, holder: string): Promise<boolean> {
  const mine = reservations.get(id);
  if (mine && [...mine].some((h) => h !== holder)) return false;
  addLocalHold(id, holder);
  if (!shared) return true;
  let ok = false;
  try {
    ok = await shared.backend.hold(id, holder, shared.holdTtlMs, true);
  } catch (err) {
    sharedFailed(err);
  }
  if (!ok) {
    const holders = reservations.get(id);
    holders?.delete(holder);
    if (holders && holders.size === 0) reservations.delete(id);
  }
  return ok;
}

/** Holders this process holds, per box (for a UI that shows who is busy). */
export function localHolds(): Map<string, string[]> {
  return new Map([...reservations].map(([id, h]) => [id, [...h]]));
}

/** Holders on every replica, per box, as of the last refresh. */
export function allHolds(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, h] of reservations) out.set(id, [...h]);
  for (const [id, h] of remoteHolds) out.set(id, [...new Set([...(out.get(id) ?? []), ...h])]);
  return out;
}

/** Re-read other replicas' holds for `ids` (default: every known box). Throws when the store cannot answer. */
export async function refreshSharedHolds(ids: readonly string[] = [...boxes.keys()]): Promise<void> {
  if (!shared) return;
  const read = await shared.backend.holders(ids);
  const next = new Map(remoteHolds);
  for (const id of ids) {
    const mine = reservations.get(id);
    const theirs = (read.get(id) ?? []).filter((h) => !mine?.has(h));
    if (theirs.length) next.set(id, theirs); else next.delete(id);
  }
  remoteHolds = next;
}

// ─── Shared state across replicas (DE-47) ────────────────────────────────────

interface SharedAttachment {
  backend: FleetSharedBackend;
  replicaId: string;
  holdTtlMs: number;
  touchFlushMs: number;
  pendingTouch: Map<string, number>;
  touchTimer: NodeJS.Timeout | null;
  renewTimer: NodeJS.Timeout | null;
}

let shared: SharedAttachment | null = null;

/** The hold a run in flight on this replica takes on its box. */
const taskHolder = (): string => `task:${shared?.replicaId ?? 'local'}`;
let lastSharedWarning = 0;

function sharedFailed(err: unknown): void {
  // Loud enough to see, quiet enough not to flood: a Redis outage would
  // otherwise log once per fleet event.
  if (Date.now() - lastSharedWarning < 60_000) return;
  lastSharedWarning = Date.now();
  console.warn('[devbox-fleet] shared state write failed:', (err as Error)?.message ?? String(err));
}

/** Fire-and-forget write to the shared store; a no-op without one. */
function sharedWrite(op: (b: FleetSharedBackend) => Promise<unknown>): void {
  if (!shared) return;
  try { void op(shared.backend).catch(sharedFailed); } catch (err) { sharedFailed(err); }
}

/** Publish this box's structural snapshot to the other replicas. */
function shareState(s: BoxState): void {
  s.stateAt = Math.max(Date.now(), s.stateAt + 1);
  if (!shared) return;
  const rec = { box: { ...s.box }, stateAt: s.stateAt, origin: shared.replicaId };
  sharedWrite((b) => b.putBox(rec));
}

/** A structural change: written through to every mirror and to the shared record. */
function structural(s: BoxState): void {
  tellStores((t) => t.upsert(s.box));
  shareState(s);
}

function flushSharedTouches(): void {
  if (!shared || shared.pendingTouch.size === 0) return;
  const batch = [...shared.pendingTouch];
  shared.pendingTouch.clear();
  for (const [id, ms] of batch) sharedWrite((b) => b.touch(id, ms));
}

/**
 * The activity clock, coalesced like the Aurora mirror's touch: every event
 * calls this, and a write per event would be a storm. Staleness is bounded by
 * the flush interval, which is small against any idle timeout.
 */
function sharedTouch(id: string): void {
  if (!shared) return;
  const s = boxes.get(id);
  if (!s) return;
  const ms = Date.parse(s.box.lastActivityAt) || Date.now();
  if (shared.touchFlushMs <= 0) { sharedWrite((b) => b.touch(id, ms)); return; }
  shared.pendingTouch.set(id, ms);
}

/** Another replica's event: into the buffer and to the tails, never through the status machine. */
function ingestRemoteEvent(id: string, message: string): void {
  if (!shared) return;
  let parsed: { origin?: unknown; ev?: unknown };
  try { parsed = JSON.parse(message) as typeof parsed; } catch { return; }
  if (parsed.origin === shared.replicaId || !parsed.ev || typeof parsed.ev !== 'object') return;
  const s = boxes.get(id);
  if (!s) return;
  const ev = parsed.ev as FleetEvent;
  s.events.push(ev);
  if (s.events.length > EVENT_BUFFER_CAP) s.events.shift();
  // Activity seen is activity: the idle clock moves here too, without a write
  // (the replica running the task owns the shared clock).
  s.box.lastActivityAt = now();
  for (const cb of s.subscribers) {
    try { cb(ev); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

function startRemoteTail(id: string, s: BoxState): void {
  if (!shared) return;
  const backend = shared.backend;
  s.remoteTail = backend.subscribe(id, (m) => ingestRemoteEvent(id, m)).catch((err) => {
    sharedFailed(err);
    return null;
  });
}

function endRemoteTail(s: BoxState): void {
  const pending = s.remoteTail;
  if (!pending) return;
  s.remoteTail = undefined;
  void pending.then((off) => off?.()).catch(() => undefined);
}

/**
 * Bring this process's view up to the shared truth (DE-47). For every shared
 * record: an unknown box is hydrated; a known one takes the newer activity
 * clock, and the other replica's status, task clock and label when its
 * snapshot is newer than ours. A box stopped elsewhere is stopped here. Then
 * other replicas' holds are re-read.
 *
 * Throws when the shared store cannot answer: a caller deciding something
 * irreversible (the reaper) must skip rather than act on a stale local view.
 * A no-op without shared state — one process is its own truth.
 */
export async function refreshFromShared(): Promise<void> {
  if (!shared) return;
  const records = await shared.backend.readAll();
  for (const rec of records) {
    const s = boxes.get(rec.box.id);
    const sharedAct = Math.max(rec.activityMs, Date.parse(rec.box.lastActivityAt) || 0);
    if (!s) {
      if (rec.box.status === 'stopped') continue;
      hydrateBoxes([{ ...rec.box, lastActivityAt: new Date(sharedAct || Date.now()).toISOString() }]);
      const hydrated = boxes.get(rec.box.id);
      if (hydrated) hydrated.stateAt = rec.stateAt;
      continue;
    }
    const prior = s.box.status;
    if (rec.stateAt > s.stateAt) {
      s.box.status = rec.box.status;
      s.box.label = rec.box.label;
      if (rec.box.taskStartedAt) s.box.taskStartedAt = rec.box.taskStartedAt;
      if (rec.box.currentTask !== undefined) s.box.currentTask = rec.box.currentTask;
      if (rec.box.lastOccupant !== undefined) s.box.lastOccupant = rec.box.lastOccupant;
      if (rec.box.profileId && !s.box.profileId) {
        s.box.profileId = rec.box.profileId;
        s.box.profileVersion = rec.box.profileVersion;
      }
      s.stateAt = rec.stateAt;
    } else if (rec.box.status === 'stopped' && s.box.status !== 'stopped') {
      // Stopped is terminal for the session, whoever's snapshot is newer.
      s.box.status = 'stopped';
    }
    const localAct = Date.parse(s.box.lastActivityAt) || 0;
    if (sharedAct > localAct) s.box.lastActivityAt = new Date(sharedAct).toISOString();
    if (s.box.status !== prior) emitLifecycle('updated', s.box);
  }
  await refreshSharedHolds();
}

export interface SharedFleetOptions {
  /** This replica's identity (lib/replica-fleet.ts replicaId()). */
  replicaId: string;
  /** How long a hold lives without renewal. Default DEVBOX_HOLD_TTL_MS or 10 min. */
  holdTtlMs?: number;
  /** Activity flush interval; 0 writes through. Default DEVBOX_SHARED_TOUCH_MS or 5 s. */
  touchFlushMs?: number;
}

/**
 * Attach (or with null, detach) the cross-replica store. On attach this
 * process publishes what it already knows — without overwriting a newer
 * record another replica wrote — and starts renewing its holds.
 */
export function attachSharedFleet(backend: FleetSharedBackend | null, opts?: SharedFleetOptions): void {
  if (shared) {
    flushSharedTouches();
    if (shared.touchTimer) clearInterval(shared.touchTimer);
    if (shared.renewTimer) clearInterval(shared.renewTimer);
    for (const s of boxes.values()) endRemoteTail(s);
    shared = null;
    remoteHolds = new Map();
  }
  if (!backend || !opts) return;
  const envNum = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
  const holdTtlMs = Math.max(1_000, opts.holdTtlMs ?? envNum('DEVBOX_HOLD_TTL_MS', 600_000));
  const touchFlushMs = opts.touchFlushMs ?? envNum('DEVBOX_SHARED_TOUCH_MS', 5_000);
  const att: SharedAttachment = {
    backend, replicaId: opts.replicaId, holdTtlMs, touchFlushMs,
    pendingTouch: new Map(), touchTimer: null, renewTimer: null,
  };
  shared = att;
  if (touchFlushMs > 0) {
    att.touchTimer = setInterval(flushSharedTouches, touchFlushMs);
    att.touchTimer.unref?.();
  }
  // Renew every hold this process holds well inside its expiry.
  att.renewTimer = setInterval(() => {
    for (const [id, holders] of reservations) {
      for (const h of holders) sharedWrite((b) => b.hold(id, h, holdTtlMs, false));
    }
  }, Math.max(500, Math.floor(holdTtlMs / 3)));
  att.renewTimer.unref?.();
  for (const s of boxes.values()) {
    // stateAt 0 for a box only hydrated here: any snapshot another replica
    // wrote is newer, so this never clobbers it.
    const rec = { box: { ...s.box }, stateAt: s.stateAt, origin: att.replicaId };
    sharedWrite((b) => b.putBox(rec));
    if (s.subscribers.size && !s.remoteTail) startRemoteTail(s.box.id, s);
  }
  for (const [id, holders] of reservations) {
    for (const h of holders) sharedWrite((b) => b.hold(id, h, holdTtlMs, false));
  }
}

/** Whether shared state is attached, and which kind. */
export function sharedFleetKind(): FleetSharedBackend['kind'] | null {
  return shared?.backend.kind ?? null;
}

/** Test/ops hook — write any coalesced activity now. */
export function flushSharedFleet(): void {
  flushSharedTouches();
}

/** Test hook — wipe all fleet state. */
export function _resetFleet(): void {
  attachSharedFleet(null);
  boxes.clear();
  bySession.clear();
  reservations.clear();
  remoteHolds = new Map();
  store = null;
  lifecycleSubscribers.clear();
}

/** A private local restart restores stopped fleet history, without subscribers or a new live run. */
export function restoreMockFleetRestart(): void {
  const states = mockRestartMirror('fleet');
  if (!states) return;
  for (const state of states) {
    const current = boxes.get(state.id);
    if (!current) throw Error('mock restart fleet hydration missing box');
    current.events = state.events as FleetEvent[];
    current.lastResultText = state.lastResultText;
    current.contextTokens = state.contextTokens;
  }
}
