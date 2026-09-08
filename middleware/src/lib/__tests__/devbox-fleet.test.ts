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
import { decideReaping, MAX_LIFETIME_MS } from '../devbox-reaper.js';

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
