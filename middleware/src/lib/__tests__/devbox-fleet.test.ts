// Fleet registry unit tests — status machine, ring buffer, pub/sub.

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
  _resetFleet,
} from '../devbox-fleet.js';

const SID = 'a'.repeat(40);

beforeEach(() => _resetFleet());

describe('registry', () => {
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

  it('a throwing subscriber does not break the fan-out', () => {
    const box = registerBox({ sessionId: SID });
    subscribe(box.id, () => { throw new Error('bad'); });
    const seen: unknown[] = [];
    subscribe(box.id, (ev) => seen.push(ev['type']));
    appendEvent(box.id, { type: 'assistant' });
    expect(seen).toEqual(['assistant']);
  });
});
