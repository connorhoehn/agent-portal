// The offline tails — what the Computer Lab's Bot logs and Agent panes replay.
//
// Before this fixture every seeded box tailed nothing, so a box whose row
// says it is mid-task opened on "waiting for output". These pin the
// properties the seed exists for: every box has a story, the story agrees
// with the row (contract rule 1 — the result frame is the row's own
// lastResult, not a second copy), and seeding the buffer leaves the row
// exactly as the fixture said it was.

// The seed reads its task lines off the board fixture, which resolves
// initiative names through providers/projects.ts — and that drags config.ts
// (import.meta) into the CJS jest build unless it is stood in for.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { fixtureRegistry, freezeClock, unfreezeClock } from '../core/index.js';
import { devboxBoxes } from '../devbox-fleet.js';
import {
  devboxTails, devboxTailTicks, tickMockTails, startMockTailTicker, stopMockTailTicker, mockTailTickerRunning,
} from '../devbox-tail.js';
import {
  _resetFleet, getBox, hydrateBoxes, replayEvents, seedEventLog, type FleetEvent,
} from '../../lib/devbox-fleet.js';

const AT = '2026-09-16T15:20:00.000Z';
let restore: () => void;

beforeEach(() => { restore = freezeClock(AT); fixtureRegistry.resetAll('default'); _resetFleet(); });
afterEach(() => { restore(); unfreezeClock(); fixtureRegistry.resetAll('default'); _resetFleet(); });

describe('devboxTails — the history each offline computer replays', () => {
  // A `provisioning` box has run nothing yet — its microVM is not up — so an
  // empty tail is the honest one; every other box has a story.
  const worked = () => devboxBoxes.rows().filter((b) => b.status !== 'provisioning');

  it('gives every seeded box that has run anything a story, and a provisioning one none', () => {
    const tails = new Set(devboxTails.rows().map((t) => t.boxId));
    for (const box of worked()) expect(tails.has(box.id)).toBe(true);
    for (const box of devboxBoxes.rows().filter((b) => b.status === 'provisioning')) {
      expect(tails.has(box.id)).toBe(false);
    }
  });

  it('builds a finished run\'s result frame from the row, never a second copy of its numbers', () => {
    for (const box of worked()) {
      const events = devboxTails.rows().find((t) => t.boxId === box.id)!.events;
      const result = events.find((e) => e['type'] === 'result');
      if (!box.lastResult) { expect(result).toBeUndefined(); continue; }
      expect(result).toMatchObject({
        num_turns: box.lastResult.turns,
        duration_ms: box.lastResult.durationMs,
        total_cost_usd: box.lastResult.costUsd,
      });
    }
  });

  it('leaves a running box mid-run and ends a waiting box on its question', () => {
    const tailOf = (status: string) => {
      const box = devboxBoxes.rows().find((b) => b.status === status)!;
      return devboxTails.rows().find((t) => t.boxId === box.id)!.events;
    };
    expect(tailOf('running').some((e) => e['type'] === 'result' || e['type'] === 'devbox_end')).toBe(false);
    const waiting = tailOf('waiting');
    const lastSaid = [...waiting].reverse().find((e) => e['type'] === 'assistant') as
      { message: { content: { text?: string }[] } };
    expect(lastSaid.message.content[0]!.text).toMatch(/\?$/);
  });

  it('stamps every frame from the clock, in order, ending no later than the row says', () => {
    for (const { boxId, events } of devboxTails.rows()) {
      const box = devboxBoxes.rows().find((b) => b.id === boxId)!;
      const times = events.map((e) => Date.parse(String(e['ts'])));
      expect(times.every(Number.isFinite)).toBe(true);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(Math.max(...times)).toBeLessThanOrEqual(Date.parse(box.lastActivityAt!));
    }
  });

  it('seeds the replay buffer without running the status machine', () => {
    hydrateBoxes(devboxBoxes.rows().map((b) => ({ ...b })));
    const before = worked().map((b) => ({ ...getBox(b.id)! }));
    for (const { boxId, events } of devboxTails.rows()) seedEventLog(boxId, events);
    for (const row of before) {
      expect(getBox(row.id)).toEqual(row);
      expect(replayEvents(row.id).length).toBeGreaterThan(0);
    }
  });
});

describe('the tail ticker — running computers keep working', () => {
  const hydrate = () => {
    hydrateBoxes(devboxBoxes.rows().map((b) => ({ ...b })));
    for (const { boxId, events } of devboxTails.rows()) seedEventLog(boxId, events);
  };
  const types = (id: string) => replayEvents(id).map((e) => e['type']);

  it('advances every running box and brings the provisioning one up, and nothing else', () => {
    hydrate();
    const running = devboxBoxes.rows().filter((b) => b.status === 'running').map((b) => b.id);
    const settledIds = devboxBoxes.rows().filter((b) => b.status === 'idle' || b.status === 'waiting').map((b) => b.id);
    const lengths = new Map(devboxBoxes.rows().map((b) => [b.id, replayEvents(b.id).length]));

    const advanced = tickMockTails();
    expect(advanced).toBe(running.length + 1);
    for (const id of running) expect(replayEvents(id).length).toBe(lengths.get(id)! + 1);
    for (const id of settledIds) expect(replayEvents(id).length).toBe(lengths.get(id)!);

    // The provisioning box's first tick is its task_started, through the real
    // status machine — so it is running now, with the task its item names.
    const coming = devboxBoxes.rows().find((b) => b.status === 'provisioning')!;
    expect(types(coming.id)).toEqual(['task_started']);
    expect(getBox(coming.id)!.status).toBe('running');
    expect(getBox(coming.id)!.currentTask).toBeTruthy();
  });

  it('keeps going past its lead-in without ever claiming the run finished', () => {
    hydrate();
    for (let i = 0; i < 40; i++) tickMockTails();
    for (const box of devboxBoxes.rows().filter((b) => b.status === 'running')) {
      const ticked = replayEvents(box.id).slice(devboxTails.rows().find((t) => t.boxId === box.id)!.events.length);
      expect(ticked).toHaveLength(40);
      expect(ticked.some((e) => e['type'] === 'result' || e['type'] === 'devbox_end')).toBe(false);
      expect(getBox(box.id)!.status).toBe('running');
    }
  });

  it('emits the plan as the real TodoWrite wire shape', () => {
    hydrate();
    for (let i = 0; i < 6; i++) tickMockTails();
    const plans = replayEvents('box-mock-0001').filter((e) =>
      (e as { message?: { content?: Array<{ name?: string }> } }).message?.content?.[0]?.name === 'TodoWrite');
    expect(plans.length).toBeGreaterThan(1);
    const todos = (plans.at(-1) as unknown as { message: { content: Array<{ input: { todos: Array<{ status: string }> } }> } })
      .message.content[0]!.input.todos;
    expect(todos.every((t) => ['pending', 'in_progress', 'completed'].includes(t.status))).toBe(true);
    expect(todos.filter((t) => t.status === 'in_progress')).toHaveLength(1);
  });

  it('stamps ticked frames from the clock at append time', () => {
    hydrate();
    tickMockTails();
    const last = replayEvents('box-mock-0001').at(-1) as FleetEvent;
    expect(last['ts']).toBe(new Date(AT).toISOString());
  });

  it('reset rewinds every script, and the timer is armed only when asked for', () => {
    hydrate();
    tickMockTails(); tickMockTails();
    expect(devboxTailTicks.rows().length).toBeGreaterThan(0);
    fixtureRegistry.resetAll('default');
    expect(devboxTailTicks.rows()).toEqual([]);

    // Off under jest by default; on when MOCK_TAIL_TICK_MS says so; stoppable.
    stopMockTailTicker();
    startMockTailTicker();
    expect(mockTailTickerRunning()).toBe(false);
    process.env['MOCK_TAIL_TICK_MS'] = '60000';
    try {
      startMockTailTicker();
      expect(mockTailTickerRunning()).toBe(true);
    } finally {
      stopMockTailTicker();
      delete process.env['MOCK_TAIL_TICK_MS'];
    }
    expect(mockTailTickerRunning()).toBe(false);
  });
});

