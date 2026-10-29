// Fleet registry unit tests — status machine, ring buffer, pub/sub.

// The reaper's default fleet lock is never used here (DE-47 tests pass their
// own); mocking it keeps realtime-modules out of every isolated module copy.
jest.mock('../replica-fleet.js', () => ({ replicaFleet: jest.fn(), replicaId: () => 'test-replica' }));

import {
  registerBox,
  listBoxes,
  getBox,
  getBoxBySession,
  renameBox,
  markStopped,
  removeBox,
  replayEvents,
  subscribe,
  appendEvent,
  subscribeLifecycle,
  setFleetStore,
  hydrateBoxes,
  _resetFleet,
} from '../devbox-fleet.js';
import { decideReaping, MAX_LIFETIME_MS, sweepOnce, type ReaperDeps } from '../devbox-reaper.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SID = 'a'.repeat(40);

beforeEach(() => _resetFleet());

describe('registry', () => {
  it('publishes trusted lifecycle transitions before removal drops owner attribution', () => {
    const seen: Array<{ kind: string; status: string; ownerId?: string }> = [];
    const stop = subscribeLifecycle((event) => seen.push({
      kind: event.kind, status: event.box.status, ownerId: event.box.ownerId,
    }));
    const box = registerBox({ sessionId: SID, ownerId: 'owner-1' });
    appendEvent(box.id, { type: 'task_started' });
    markStopped(box.id);
    removeBox(box.id);
    stop();
    expect(seen).toEqual([
      { kind: 'created', status: 'idle', ownerId: 'owner-1' },
      { kind: 'updated', status: 'running', ownerId: 'owner-1' },
      { kind: 'updated', status: 'stopped', ownerId: 'owner-1' },
      { kind: 'removed', status: 'stopped', ownerId: 'owner-1' },
    ]);
  });

  it('registers and lists boxes, id defaults to session tail', () => {
    const box = registerBox({ sessionId: SID, label: 'worker-1' });
    expect(box.id).toBe(SID.slice(-8));
    expect(box.status).toBe('idle');
    expect(listBoxes()).toHaveLength(1);
    expect(getBoxBySession(SID)?.id).toBe(box.id);
  });

  it('register is idempotent per id', () => {
    const a = registerBox({ sessionId: SID, label: 'one' });
    const b = registerBox({ sessionId: SID, label: 'two' });
    expect(b.id).toBe(a.id);
    expect(b.label).toBe('one');
    expect(listBoxes()).toHaveLength(1);
  });

  it('rename, stop, remove', () => {
    const box = registerBox({ sessionId: SID });
    expect(renameBox(box.id, 'pr-worker')?.label).toBe('pr-worker');
    markStopped(box.id);
    expect(getBox(box.id)?.status).toBe('stopped');
    expect(removeBox(box.id)).toBe(true);
    expect(getBox(box.id)).toBeNull();
    expect(getBoxBySession(SID)).toBeNull();
  });
});

describe('status machine', () => {
  it('task_started → running; devbox_end → idle', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'do the thing' });
    expect(getBox(box.id)?.status).toBe('running');
    expect(getBox(box.id)?.currentTask).toBe('do the thing');
    appendEvent(box.id, { type: 'result', subtype: 'success', num_turns: 3, duration_ms: 9000, total_cost_usd: 0.02, result: 'Done.' });
    appendEvent(box.id, { type: 'devbox_end', exit_code: 0 });
    expect(getBox(box.id)?.status).toBe('idle');
    expect(getBox(box.id)?.lastResult?.turns).toBe(3);
  });

  it('run ending with a question → waiting (operator feedback needed)', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'result', subtype: 'success', result: 'Want me to also add tests?' });
    appendEvent(box.id, { type: 'devbox_end', exit_code: 0 });
    expect(getBox(box.id)?.status).toBe('waiting');
  });

  it('devbox_error → error', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'devbox_error', error: 'boom' });
    expect(getBox(box.id)?.status).toBe('error');
  });

  it('a new task clears the waiting heuristic', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p1' });
    appendEvent(box.id, { type: 'result', result: 'Continue?' });
    appendEvent(box.id, { type: 'devbox_end' });
    expect(getBox(box.id)?.status).toBe('waiting');
    appendEvent(box.id, { type: 'task_started', prompt: 'p2' });
    appendEvent(box.id, { type: 'result', result: 'All done.' });
    appendEvent(box.id, { type: 'devbox_end' });
    expect(getBox(box.id)?.status).toBe('idle');
  });
});

describe('cost-centre accrual', () => {
  it('result accrues spend and tokens (lifetime, summed across runs)', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p1' });
    appendEvent(box.id, {
      type: 'result', total_cost_usd: 0.04, usage: { input_tokens: 8000, output_tokens: 600 }, result: 'done',
    });
    expect(getBox(box.id)?.spendUsd).toBeCloseTo(0.04);
    expect(getBox(box.id)?.tokensUsed).toBe(8600);
    appendEvent(box.id, { type: 'devbox_end' });

    // A second run adds onto the lifetime totals rather than replacing them.
    appendEvent(box.id, { type: 'task_started', prompt: 'p2' });
    appendEvent(box.id, {
      type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 2000, output_tokens: 400 }, result: 'done',
    });
    expect(getBox(box.id)?.spendUsd).toBeCloseTo(0.06);
    expect(getBox(box.id)?.tokensUsed).toBe(11000);
  });

  it('token usage also accrues from an assistant event nested under message.usage', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'assistant', message: { usage: { input_tokens: 500, output_tokens: 100 } } });
    expect(getBox(box.id)?.tokensUsed).toBe(600);
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(600 / 200_000);
  });

  it('task_started resets contextUsed (a new task is a new conversation) but not lifetime tokensUsed', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p1' });
    appendEvent(box.id, { type: 'result', usage: { input_tokens: 50_000, output_tokens: 0 }, result: 'done' });
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(0.25);
    appendEvent(box.id, { type: 'devbox_end' });

    appendEvent(box.id, { type: 'task_started', prompt: 'p2' });
    expect(getBox(box.id)?.contextUsed).toBe(0);
    expect(getBox(box.id)?.tokensUsed).toBe(50_000); // lifetime counter untouched by the reset
  });

  it('contextUsed clamps below 1 even past the nominal window', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'result', usage: { input_tokens: 500_000, output_tokens: 0 }, result: 'done' });
    expect(getBox(box.id)?.contextUsed).toBeLessThan(1);
  });

  // ── Prompt-cache accounting ────────────────────────────────────────────────
  // Claude Code sends the system prompt and conversation prefix as a prompt
  // cache, so on a real run the cache fields hold nearly all the tokens.
  // Counting only input+output made both gauges read near zero on a box that
  // was genuinely filling up.

  // The exact usage block the deployed devbox reported on 2026-09-09 for a
  // one-sentence, no-tool task. Kept verbatim rather than rounded: the whole
  // point is that the small-looking fields are not where the tokens are.
  const MEASURED_USAGE = {
    input_tokens: 10,
    cache_creation_input_tokens: 21_931,
    cache_read_input_tokens: 0,
    output_tokens: 55,
  };

  it('counts cache-creation tokens — the old sum saw 65 of ~22k', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'result', total_cost_usd: 0.0277, usage: MEASURED_USAGE, result: 'ok' });

    // input + cache_creation + output. Not 65.
    expect(getBox(box.id)?.tokensUsed).toBe(21_996);
    // ~11% of the window, not the 0.03% input+output alone would have shown.
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(21_996 / 200_000, 6);
  });

  it('cache_read counts toward context occupancy but not toward lifetime burn', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, {
      type: 'assistant',
      message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000, output_tokens: 95 } },
    });
    // Occupancy sees the whole re-read prefix: 5 + 30000 + 95.
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(30_100 / 200_000, 6);
    // Burn does not: those 30k were already paid for on the turn that wrote them.
    expect(getBox(box.id)?.tokensUsed).toBe(100);
  });

  it('context is a level, not a running total — a multi-turn run does not pin the gauge', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    // Four turns of a conversation that stays ~40k: each re-reads the prefix.
    for (let i = 0; i < 4; i++) {
      appendEvent(box.id, {
        type: 'assistant',
        message: { usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000, output_tokens: 0 } },
      });
    }
    // Summing prompt sizes would have reached 160k (80% of the window) and kept
    // climbing until it pinned at the 0.99 clamp. The conversation is 40k.
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(40_000 / 200_000, 6);
  });

  it('occupancy holds at the peak rather than walking backwards mid-run', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    appendEvent(box.id, { type: 'assistant', message: { usage: { cache_read_input_tokens: 80_000 } } });
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(0.4, 6);
    // A later event reporting a smaller prompt must not shrink the gauge.
    appendEvent(box.id, { type: 'result', usage: { input_tokens: 10, output_tokens: 5 }, result: 'ok' });
    expect(getBox(box.id)?.contextUsed).toBeCloseTo(0.4, 6);
  });

  it('a model on task_started sets activeModel', () => {
    const box = registerBox({ sessionId: SID });
    expect(getBox(box.id)?.activeModel).toBeUndefined();
    appendEvent(box.id, { type: 'task_started', prompt: 'p', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
    expect(getBox(box.id)?.activeModel).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('an unknown event type accrues nothing', () => {
    const box = registerBox({ sessionId: SID });
    appendEvent(box.id, { type: 'ping', ts: 'now' });
    const b = getBox(box.id);
    expect(b?.spendUsd).toBeUndefined();
    expect(b?.tokensUsed).toBeUndefined();
    expect(b?.contextUsed).toBeUndefined();
    expect(b?.activeModel).toBeUndefined();
  });
});

describe('event log + pub/sub', () => {
  it('ring buffer caps at 500', () => {
    const box = registerBox({ sessionId: SID });
    for (let i = 0; i < 600; i++) appendEvent(box.id, { type: 'assistant', i });
    const events = replayEvents(box.id);
    expect(events).toHaveLength(500);
    expect(events[0]?.['i']).toBe(100);
  });

  it('subscribers receive live events; unsubscribe stops delivery', () => {
    const box = registerBox({ sessionId: SID });
    const seen: unknown[] = [];
    const unsub = subscribe(box.id, (ev) => seen.push(ev['type']));
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    unsub();
    appendEvent(box.id, { type: 'devbox_end' });
    expect(seen).toEqual(['task_started']);
  });

  it('removing a box tells its watchers, so a tail is not left heartbeating into the void', () => {
    // Removing a box cannot close the SSE responses attached to it, and an
    // abandoned tail does not look abandoned — the 25s heartbeat keeps the
    // socket healthy, so onerror never fires and a heartbeat watchdog is
    // reassured by the very signal meant to catch a dead stream. Verified
    // against the running middleware: a box removed at 15:46:04 had its tail
    // heartbeat on until the client gave up 100s later.
    const box = registerBox({ sessionId: SID });
    const seen: Record<string, unknown>[] = [];
    subscribe(box.id, (ev) => seen.push(ev));

    expect(removeBox(box.id)).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'box_removed', boxId: box.id });
  });

  it('a stopped box does NOT emit the terminal event — it still exists and is worth watching', () => {
    const box = registerBox({ sessionId: SID });
    const seen: Record<string, unknown>[] = [];
    subscribe(box.id, (ev) => seen.push(ev));

    markStopped(box.id);

    expect(seen.some((e) => e['type'] === 'box_removed')).toBe(false);
    expect(getBox(box.id)?.status).toBe('stopped');
  });

  it('a throwing subscriber does not break the fan-out', () => {
    const box = registerBox({ sessionId: SID });
    subscribe(box.id, () => { throw new Error('bad'); });
    const seen: unknown[] = [];
    subscribe(box.id, (ev) => seen.push(ev['type']));
    appendEvent(box.id, { type: 'assistant' });
    expect(seen).toEqual(['assistant']);
  });
});

// ─── createdAt is caller-supplied, so it is not trusted ─────────────────────
//
// `POST /api/devbox/boxes` accepts `createdAt` so a client can re-adopt a box
// after a middleware restart without resetting its age. The reaper's
// max-lifetime ceiling is measured from that age, so a future or unparseable
// value silently makes a box immortal — which is the one thing the ceiling
// exists to prevent (a box that keeps itself busy is never idle, so the idle
// timer will not catch it). These assert the consequence via `decideReaping`,
// not just the stored string.
describe('createdAt is clamped, so the max-lifetime ceiling always applies', () => {
  const wayPast = new Date(Date.now() - 10 * MAX_LIFETIME_MS).toISOString();

  it('keeps a past createdAt — that is what re-adoption is for', () => {
    const box = registerBox({ sessionId: 'p'.repeat(40), createdAt: wayPast });
    expect(box.createdAt).toBe(wayPast);
    // And it is still reapable: an old box hits the ceiling immediately.
    expect(decideReaping([box]).map((d) => d.reason)).toContain('max-lifetime');
  });

  it('clamps a future createdAt to now', () => {
    const future = new Date(Date.now() + 10 * 365 * 24 * 3600_000).toISOString();
    const box = registerBox({ sessionId: 'f'.repeat(40), createdAt: future });
    expect(new Date(box.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // The box is young now, not immortal — it will reach the ceiling on time.
    const later = Date.now() + MAX_LIFETIME_MS + 1000;
    expect(decideReaping([box], later).map((d) => d.reason)).toContain('max-lifetime');
  });

  it('treats an unparseable createdAt as now rather than NaN', () => {
    const box = registerBox({ sessionId: 'g'.repeat(40), createdAt: 'not-a-date' });
    expect(Number.isFinite(new Date(box.createdAt).getTime())).toBe(true);
    // NaN would have been skipped by decideReaping's isFinite guard.
    const later = Date.now() + MAX_LIFETIME_MS + 1000;
    expect(decideReaping([box], later).map((d) => d.reason)).toContain('max-lifetime');
  });
});

// ─── Surviving a restart ─────────────────────────────────────────────────────
//
// The registry is in-memory, so before this a restart dropped every box while
// the AgentCore sessions kept running — and the reaper sweeps only what
// listBoxes() returns, so those sessions were outside BOTH timers with nothing
// able to find them again. Proven live on 2026-09-09.

describe('persistence seam', () => {
  it('mirrors create, rename, stop and remove to the store', () => {
    const calls: string[] = [];
    setFleetStore({
      upsert: (b) => calls.push(`upsert:${b.id}:${b.status}:${b.label}`),
      remove: (id) => calls.push(`remove:${id}`),
      touch: (b) => calls.push(`touch:${b.id}`),
    });

    const box = registerBox({ sessionId: SID, label: 'first' });
    renameBox(box.id, 'renamed');
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    markStopped(box.id);
    removeBox(box.id);

    assert_includes(calls, `upsert:${box.id}:idle:first`);
    assert_includes(calls, `upsert:${box.id}:idle:renamed`);
    assert_includes(calls, `touch:${box.id}`);
    assert_includes(calls, `upsert:${box.id}:stopped:renamed`);
    assert_includes(calls, `remove:${box.id}`);
  });

  it('works with no store at all — a laptop must behave exactly as before', () => {
    // The whole mechanism is optional. Aurora mocked, unconfigured or down
    // leaves this module doing what it always did.
    const box = registerBox({ sessionId: SID });
    renameBox(box.id, 'x');
    appendEvent(box.id, { type: 'task_started', prompt: 'p' });
    expect(getBox(box.id)?.label).toBe('x');
    expect(removeBox(box.id)).toBe(true);
  });

  function assert_includes(calls: string[], want: string): void {
    expect(calls).toContain(want);
  }
});

describe('hydration restores the fleet the reaper has to police', () => {
  const AGED = {
    id: 'aged01',
    label: 'survivor',
    sessionId: 'b'.repeat(40),
    status: 'idle' as const,
    // Older than the ceiling: exactly the orphan this work exists for.
    createdAt: new Date(Date.now() - MAX_LIFETIME_MS - 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - MAX_LIFETIME_MS - 60_000).toISOString(),
  };

  it('a hydrated box is visible, addressable by session, and REAPABLE', () => {
    expect(hydrateBoxes([AGED])).toBe(1);
    expect(getBox('aged01')?.label).toBe('survivor');
    expect(getBoxBySession(AGED.sessionId)?.id).toBe('aged01');

    // The point of the whole exercise: the reaper can stop a box this process
    // never created.
    const [decision] = decideReaping(listBoxes());
    expect(decision?.box.id).toBe('aged01');
    expect(decision?.reason).toBe('max-lifetime');
  });

  it('keeps the STORED timestamps rather than re-stamping them', () => {
    hydrateBoxes([AGED]);
    // Re-stamping would hand every box a fresh idle clock on every restart —
    // visible, but never able to age out. Same leak, quieter.
    expect(getBox('aged01')?.createdAt).toBe(AGED.createdAt);
    expect(getBox('aged01')?.lastActivityAt).toBe(AGED.lastActivityAt);
  });

  it('a live box always wins over a stored one with the same id', () => {
    const live = registerBox({ sessionId: SID, id: 'aged01', label: 'live' });
    expect(hydrateBoxes([AGED])).toBe(0);
    expect(getBox('aged01')?.label).toBe(live.label);
  });

  it('restores lifetime spend so a restart does not zero the cost centre', () => {
    hydrateBoxes([{ ...AGED, spendUsd: 0.42, tokensUsed: 1234 }]);
    expect(getBox('aged01')?.spendUsd).toBeCloseTo(0.42);
    expect(getBox('aged01')?.tokensUsed).toBe(1234);
  });
});

// ─── DE-47: fleet state that survives replicas ──────────────────────────────
//
// Each "replica" is its own copy of the fleet and reaper modules
// (jest.isolateModules), attached to ONE in-memory shared store — the shape
// two middleware tasks have over one Redis.

describe('fleet state shared across replicas (DE-47)', () => {
  type FleetMod = typeof import('../devbox-fleet.js');
  type ReaperMod = typeof import('../devbox-reaper.js');
  type Replica = { fleet: FleetMod; reaper: ReaperMod };
  type Fleet = import('../replica-fleet.js').ReplicaFleet;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMemoryFleetBackend } = require('../devbox-fleet-shared.js') as typeof import('../devbox-fleet-shared.js');

  const replicas: Replica[] = [];
  const replica = (id: string, world: ReturnType<typeof createMemoryFleetBackend>, holdTtlMs?: number): Replica => {
    let out!: Replica;
    jest.isolateModules(() => {
      out = {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        fleet: require('../devbox-fleet.js') as FleetMod,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        reaper: require('../devbox-reaper.js') as ReaperMod,
      };
    });
    out.fleet.attachSharedFleet(world, { replicaId: id, touchFlushMs: 0, ...(holdTtlMs ? { holdTtlMs } : {}) });
    replicas.push(out);
    return out;
  };
  afterEach(() => { for (const r of replicas.splice(0)) r.fleet._resetFleet(); });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const stopper = () => {
    const send = jest.fn(async (_cmd: unknown) => ({}));
    return { send, deps: { client: () => ({ send }) as never, runtimeArn: async () => 'arn:runtime', policies: async () => new Map() } };
  };
  const stopsOf = (send: jest.Mock) => send.mock.calls.map(([cmd]) => {
    const c = cmd as { constructor: { name: string }; input: { runtimeSessionId: string } };
    return `${c.constructor.name}:${c.input.runtimeSessionId}`;
  });

  /** A box replica A created and is working on, which replica B only knows from an old boot-time row. */
  async function boxOnABStale() {
    const world = createMemoryFleetBackend();
    const a = replica('task-a', world);
    const b = replica('task-b', world);
    const box = a.fleet.registerBox({ sessionId: SID, id: 'shared1', createdAt: ago(10) });
    b.fleet.hydrateBoxes([{ ...box, lastActivityAt: ago(30) }]);   // the compute registry's copy
    a.fleet.appendEvent('shared1', { type: 'thinking_tokens', n: 1 });
    await settle();
    return { world, a, b };
  }

  it('replica B does not reap a box whose stored activity is fresh', async () => {
    const { b } = await boxOnABStale();
    // B's own copy says idle for 30 minutes — the old failure: it reaped.
    expect(b.reaper.decideReaping(b.fleet.listBoxes()).map((d) => d.reason)).toEqual(['idle']);

    const { send, deps } = stopper();
    expect(await b.reaper.sweepOnce(deps)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(Date.parse(b.fleet.getBox('shared1')!.lastActivityAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('B sees the run A started (status and task clock), and a tail on B sees A\'s events', async () => {
    const { a, b } = await boxOnABStale();
    const seen: unknown[] = [];
    b.fleet.subscribe('shared1', (ev) => seen.push(ev['type']));
    await settle();
    a.fleet.appendEvent('shared1', { type: 'task_started', prompt: 'fix it' });
    a.fleet.appendEvent('shared1', { type: 'assistant', text: 'working' });
    await settle();
    expect(seen).toEqual(['task_started', 'assistant']);
    expect(b.fleet.replayEvents('shared1').map((e) => e['type'])).toEqual(['task_started', 'assistant']);

    await b.fleet.refreshFromShared();
    expect(b.fleet.getBox('shared1')?.status).toBe('running');
    expect(b.fleet.getBox('shared1')?.taskStartedAt).toBe(a.fleet.getBox('shared1')?.taskStartedAt);
    // A's own events are not echoed back into A's buffer.
    expect(a.fleet.replayEvents('shared1').map((e) => e['type'])).toEqual(['thinking_tokens', 'task_started', 'assistant']);
  });

  it('an older snapshot never overwrites a newer one, and a stop elsewhere is a stop here', async () => {
    const { a, b } = await boxOnABStale();
    a.fleet.markStopped('shared1');
    await settle();
    await b.fleet.refreshFromShared();
    expect(b.fleet.getBox('shared1')?.status).toBe('stopped');
  });

  it('a box registered on another replica is hydrated by the refresh, so the leader can police it', async () => {
    const world = createMemoryFleetBackend();
    const a = replica('task-a', world);
    const b = replica('task-b', world);
    a.fleet.registerBox({ sessionId: SID, id: 'only-a', createdAt: ago(5) });
    await settle();
    expect(b.fleet.getBox('only-a')).toBeNull();
    await b.fleet.refreshFromShared();
    expect(b.fleet.getBox('only-a')?.sessionId).toBe(SID);
  });

  it('claims are exclusive across replicas; reservations block claims; a dead replica\'s hold lapses', async () => {
    let clock = Date.now();
    const world = createMemoryFleetBackend({ now: () => clock });
    const a = replica('task-a', world, 1_000);
    const b = replica('task-b', world, 1_000);
    for (const r of [a, b]) r.fleet.hydrateBoxes([{ id: 'box1', label: 'box1', sessionId: SID, status: 'idle', createdAt: ago(1), lastActivityAt: ago(1) }]);

    expect(await a.fleet.claimBox('box1', 'dispatcher:task-a')).toBe(true);
    expect(await b.fleet.claimBox('box1', 'dispatcher:task-b')).toBe(false);
    a.fleet.releaseBox('box1', 'dispatcher:task-a');
    await settle();
    expect(await b.fleet.claimBox('box1', 'dispatcher:task-b')).toBe(true);
    b.fleet.releaseBox('box1', 'dispatcher:task-b');

    b.fleet.reserveBox('box1', 'sdlc:run-1');
    await settle();
    await a.fleet.refreshSharedHolds();
    expect(a.fleet.isReserved('box1')).toBe(true);
    expect(await a.fleet.claimBox('box1', 'dispatcher:task-a')).toBe(false);

    // B dies holding it: nothing renews, and past the TTL the hold is gone.
    b.fleet.attachSharedFleet(null);
    clock += 2_000;
    expect(await a.fleet.claimBox('box1', 'dispatcher:task-a')).toBe(true);
    await a.fleet.refreshSharedHolds();
    expect(a.fleet.allHolds().get('box1')).toEqual(['dispatcher:task-a']);
  });

  it('a run in flight on A holds its box, so B\'s dispatcher cannot claim it until the run ends', async () => {
    const { a, b } = await boxOnABStale();
    a.fleet.appendEvent('shared1', { type: 'task_started', prompt: 'go' });
    await settle();
    await b.fleet.refreshFromShared();
    expect(b.fleet.isReserved('shared1')).toBe(true);
    expect(await b.fleet.claimBox('shared1', 'dispatcher:task-b')).toBe(false);
    a.fleet.appendEvent('shared1', { type: 'devbox_end' });
    await settle();
    await b.fleet.refreshFromShared();
    expect(b.fleet.getBox('shared1')?.status).toBe('idle');
    expect(await b.fleet.claimBox('shared1', 'dispatcher:task-b')).toBe(true);
  });

  it('a claim fails closed when the shared store cannot answer', async () => {
    const world = createMemoryFleetBackend();
    world.hold = async () => { throw new Error('redis down'); };
    const a = replica('task-a', world);
    a.fleet.hydrateBoxes([{ id: 'box1', label: 'box1', sessionId: SID, status: 'idle', createdAt: ago(1), lastActivityAt: ago(1) }]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await a.fleet.claimBox('box1', 'dispatcher:task-a')).toBe(false);
      expect(a.fleet.isReserved('box1')).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('the reaper skips a sweep when the shared state is unreadable, rather than reaping a stale view', async () => {
    const world = createMemoryFleetBackend();
    const a = replica('task-a', world);
    a.fleet.hydrateBoxes([{ id: 'old', label: 'old', sessionId: SID, status: 'idle', createdAt: ago(30), lastActivityAt: ago(30) }]);
    world.readAll = async () => { throw new Error('redis down'); };
    const { send, deps } = stopper();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await a.reaper.sweepOnce(deps)).toEqual([]);
    } finally { warn.mockRestore(); }
    expect(send).not.toHaveBeenCalled();
  });

  /** Two replicas over one lock, the way FencedLease behaves for one key. */
  function lockPair(): { fleetFor: (id: string) => Fleet } {
    let owner: string | null = null;
    return {
      fleetFor: (id) => ({
        id,
        heartbeat: async () => undefined,
        members: async () => ['task-a', 'task-b'],
        peers: async () => [id === 'task-a' ? 'task-b' : 'task-a'],
        async withLock(_name, _ttl, fn) {
          if (owner) return null;
          owner = id;
          try { return await fn({ signal: new AbortController().signal, token: 1, assertLive() {} }); } finally { owner = null; }
        },
        leave: async () => undefined,
        stop: () => undefined,
      }),
    };
  }

  it('only the lock holder\'s sweep issues StopRuntimeSessionCommand', async () => {
    const world = createMemoryFleetBackend();
    const a = replica('task-a', world);
    const b = replica('task-b', world);
    const stale = { id: 'idle1', label: 'idle1', sessionId: SID, status: 'idle' as const, createdAt: ago(30), lastActivityAt: ago(30) };
    for (const r of [a, b]) r.fleet.hydrateBoxes([stale]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendA = jest.fn(async (_cmd: unknown) => { await gate; return {}; });
    const sendB = jest.fn(async (_cmd: unknown) => ({}));
    const deps = (send: jest.Mock) => ({ client: () => ({ send }) as never, runtimeArn: async () => 'arn:runtime', policies: async () => new Map() });
    const locks = lockPair();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tickA = a.reaper.reaperTick(deps(sendA), locks.fleetFor('task-a'));
      for (let i = 0; i < 50 && sendA.mock.calls.length === 0; i++) await settle();
      expect(sendA).toHaveBeenCalledTimes(1);

      // B ticks while A holds the lock mid-sweep.
      expect(await b.reaper.reaperTick(deps(sendB), locks.fleetFor('task-b'))).toEqual({ ran: 'locked-elsewhere', decisions: [] });
      release();
      const done = await tickA;
      expect(done.ran).toBe('swept');
      expect(done.decisions.map((d) => d.box.id)).toEqual(['idle1']);
    } finally { warn.mockRestore(); }
    expect(stopsOf(sendA)).toEqual([`StopRuntimeSessionCommand:${SID}`]);
    expect(sendB).not.toHaveBeenCalled();
  });

  it('a fenced lease stops the sweep before the next stop call', async () => {
    const world = createMemoryFleetBackend();
    const a = replica('task-a', world);
    const other = 'c'.repeat(40);
    a.fleet.hydrateBoxes([
      { id: 'idle1', label: 'idle1', sessionId: SID, status: 'idle', createdAt: ago(31), lastActivityAt: ago(31) },
      { id: 'idle2', label: 'idle2', sessionId: other, status: 'idle', createdAt: ago(30), lastActivityAt: ago(30) },
    ]);
    let live = true;
    // The first stop call outlives the lease (a Redis stall, a GC pause).
    const send = jest.fn(async (_cmd: unknown) => { live = false; return {}; });
    const fenced: Fleet = {
      ...lockPair().fleetFor('task-a'),
      async withLock(_name, _ttl, fn) {
        return fn({
          signal: new AbortController().signal, token: 7,
          assertLive() { if (!live) throw new Error('Replica lock lost: expired'); },
        });
      },
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let tick;
    try {
      tick = await a.reaper.reaperTick({ client: () => ({ send }) as never, runtimeArn: async () => 'arn:runtime', policies: async () => new Map() }, fenced);
    } finally { warn.mockRestore(); }
    expect(tick.ran).toBe('lock-unavailable');
    expect(send).toHaveBeenCalledTimes(1);
    expect(a.fleet.getBox('idle2')?.status).toBe('idle');   // never stopped, never marked
  });
});


// ─── DE-50: the reaper speaks in metric lines ────────────────────────────────

describe('reaper alerts (DE-50)', () => {
  const old = new Date(Date.now() - 10 * MAX_LIFETIME_MS).toISOString();
  const deps = (send: jest.Mock, extra: Partial<ReaperDeps> = {}): ReaperDeps => ({
    client: () => ({ send }) as never,
    runtimeArn: async () => 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/devbox',
    policies: async () => new Map(),
    refresh: async () => undefined,
    ...extra,
  });
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { log.mockRestore(); warn.mockRestore(); });
  const lines = (type: string) => log.mock.calls.map((c) => String(c[0]))
    .filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['type'] === type);

  it('a successful stop writes a devbox-reaped JSON line with its reason, and no console.warn', async () => {
    const box = registerBox({ sessionId: 'r'.repeat(40), createdAt: old });
    const send = jest.fn(async () => ({}));
    const decisions = await sweepOnce(deps(send));
    expect(decisions.map((d) => d.reason)).toEqual(['max-lifetime']);
    expect(lines('devbox-reaped')).toEqual([expect.objectContaining({ reason: 'max-lifetime', boxId: box.id })]);
    expect(warn).not.toHaveBeenCalled();
    expect(getBox(box.id)?.status).toBe('stopped');
  });

  it('a stop that fails writes devbox-reap-failed', async () => {
    const box = registerBox({ sessionId: 's'.repeat(40), createdAt: old });
    const send = jest.fn(async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); });
    await sweepOnce(deps(send));
    expect(lines('devbox-reap-failed')).toEqual([expect.objectContaining({ boxId: box.id, error: 'throttled' })]);
  });

  it('a paused fleet stops idle boxes (reason paused) and leaves running ones', async () => {
    const idle = registerBox({ sessionId: 'i'.repeat(40) });
    const busy = registerBox({ sessionId: 'b'.repeat(40) });
    appendEvent(busy.id, { type: 'task_started', prompt: 'x' });
    const send = jest.fn(async () => ({}));
    const decisions = await sweepOnce(deps(send, { fleetPaused: async () => true }));
    expect(decisions.map((d) => [d.box.id, d.reason])).toEqual([[idle.id, 'paused']]);
    expect(getBox(busy.id)?.status).toBe('running');
    expect(lines('devbox-reaped')).toEqual([expect.objectContaining({ reason: 'paused', boxId: idle.id })]);
  });

  it('housekeeping runs every sweep, even over an empty fleet (the stats line is the heartbeat)', async () => {
    const housekeeping = jest.fn(async () => undefined);
    await sweepOnce(deps(jest.fn(), { housekeeping }));
    expect(housekeeping).toHaveBeenCalledTimes(1);
  });

  it('no console.warn remains on the reaper\'s successful-stop path', () => {
    const src = readFileSync(resolve(__dirname, '../devbox-reaper.ts'), 'utf8');
    const stop = src.slice(src.indexOf('markStopped(d.box.id);'), src.indexOf('} catch (err) {', src.indexOf('markStopped(d.box.id);')));
    expect(stop).not.toMatch(/console\.warn/);
  });
});
