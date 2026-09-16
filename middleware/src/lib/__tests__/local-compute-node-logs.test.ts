// lib/local-compute-node-logs.ts — the machine's operational scrollback.
// Same contract as local-compute-logs.test.ts (the per-job log) covers for
// its module: idempotency on seq, ordering, and the bound that keeps a
// long-lived worker from growing this without limit. Ownership scoping is
// asserted at the route (routes/__tests__/local-compute-routes.test.ts),
// not here — this module knows nothing about who owns a node.

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import {
  appendNodeLog,
  getNodeLog,
  subscribeNodeLog,
  _resetLocalComputeNodeLogs,
  MAX_NODE_LOG_LINE,
} from '../local-compute-node-logs.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';

beforeEach(() => {
  _resetLocalComputeNodeLogs();
  freezeClock('2026-09-16T12:00:00Z');
});

afterEach(() => {
  unfreezeClock();
});

describe('getNodeLog on a node nothing has appended for', () => {
  it('returns null — a real "nothing shipped yet" state, not an error', () => {
    expect(getNodeLog('node-x')).toBeNull();
  });
});

describe('appendNodeLog / getNodeLog', () => {
  it('appends in arrival order and reports lastSeq', () => {
    appendNodeLog('node-a', 0, '12:00:00 · registered\n');
    appendNodeLog('node-a', 1, '12:00:01 ✓ presence acknowledged\n');
    const log = getNodeLog('node-a');
    expect(log).not.toBeNull();
    expect(log!.nodeId).toBe('node-a');
    expect(log!.lastSeq).toBe(1);
    expect(log!.entries.map((e) => [e.seq, e.text])).toEqual([
      [0, '12:00:00 · registered\n'],
      [1, '12:00:01 ✓ presence acknowledged\n'],
    ]);
  });

  it('is idempotent on seq — a re-shipped line is dropped, not duplicated', () => {
    appendNodeLog('node-a', 0, 'once\n');
    appendNodeLog('node-a', 0, 'once\n');
    expect(getNodeLog('node-a')!.entries).toHaveLength(1);
  });

  it('honours ?since via the since parameter — only entries after a cursor', () => {
    appendNodeLog('node-a', 0, 'a\n');
    appendNodeLog('node-a', 1, 'b\n');
    appendNodeLog('node-a', 2, 'c\n');
    const log = getNodeLog('node-a', 1);
    expect(log!.entries.map((e) => e.seq)).toEqual([2]);
    expect(log!.lastSeq).toBe(2); // lastSeq is over ALL entries, not the filtered view
  });

  it('ignores an empty line', () => {
    appendNodeLog('node-a', 0, '');
    expect(getNodeLog('node-a')).toBeNull();
  });

  it('clamps a single line to MAX_NODE_LOG_LINE', () => {
    appendNodeLog('node-a', 0, 'x'.repeat(MAX_NODE_LOG_LINE + 500));
    const log = getNodeLog('node-a')!;
    expect(log.entries[0]!.text).toHaveLength(MAX_NODE_LOG_LINE);
  });

  it('keeps logs for different nodes separate', () => {
    appendNodeLog('node-a', 0, 'a-line\n');
    appendNodeLog('node-b', 0, 'b-line\n');
    expect(getNodeLog('node-a')!.entries).toHaveLength(1);
    expect(getNodeLog('node-b')!.entries).toHaveLength(1);
    expect(getNodeLog('node-a')!.entries[0]!.text).toBe('a-line\n');
  });
});

describe('bounded: a worker running for weeks cannot grow the ring without limit', () => {
  it('trims the oldest lines once the per-node line-count ceiling is passed', () => {
    for (let i = 0; i < 600; i += 1) appendNodeLog('node-a', i, `line ${i}\n`);
    const log = getNodeLog('node-a')!;
    expect(log.entries.length).toBeLessThanOrEqual(500);
    // The newest line always survives — a too-big tail beats an empty one,
    // but the ring must still be a TAIL, not an arbitrary sample.
    expect(log.entries[log.entries.length - 1]!.text).toBe('line 599\n');
    // The oldest lines are gone.
    expect(log.entries.some((e) => e.text === 'line 0\n')).toBe(false);
  });

  it('trims the oldest lines once the per-node byte ceiling is passed, never dropping the newest', () => {
    // Each line ~2KB; 256KB / 2KB ≈ 128 lines fit, well under the 500-line cap,
    // so this exercises the BYTE ceiling rather than the count one.
    const big = 'y'.repeat(2_000);
    for (let i = 0; i < 200; i += 1) appendNodeLog('node-a', i, `${big}#${i}\n`);
    const log = getNodeLog('node-a')!;
    expect(log.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(log.entries[log.entries.length - 1]!.text.endsWith('#199\n')).toBe(true);
  });

  it('evicts the least-recently-written node once more than MAX_NODES are logging', () => {
    for (let i = 0; i < 201; i += 1) appendNodeLog(`node-${i}`, 0, 'hello\n');
    // node-0 was written first and never touched again — it is the one evicted.
    expect(getNodeLog('node-0')).toBeNull();
    // The most recent 200 survive.
    expect(getNodeLog('node-200')).not.toBeNull();
  });
});

describe('subscribeNodeLog', () => {
  it('delivers newly appended entries to subscribers of that node only', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = subscribeNodeLog('node-a', (e) => seenA.push(e.text));
    const unsubB = subscribeNodeLog('node-b', (e) => seenB.push(e.text));

    appendNodeLog('node-a', 0, 'to a\n');
    appendNodeLog('node-b', 0, 'to b\n');

    expect(seenA).toEqual(['to a\n']);
    expect(seenB).toEqual(['to b\n']);

    unsubA();
    appendNodeLog('node-a', 1, 'after unsub\n');
    expect(seenA).toEqual(['to a\n']); // unaffected — unsubscribed

    unsubB();
  });

  it('one throwing subscriber does not break the fan-out to the others', () => {
    const seen: string[] = [];
    subscribeNodeLog('node-a', () => { throw new Error('boom'); });
    subscribeNodeLog('node-a', (e) => seen.push(e.text));
    expect(() => appendNodeLog('node-a', 0, 'still delivered\n')).not.toThrow();
    expect(seen).toEqual(['still delivered\n']);
  });
});
