// Unit tests for the assessment event broker (lib/assessment-broker.ts).
// Mirrors the spirit of canary-broker's usage in routes/canary.ts: publish
// fans out to every live subscriber, and replay() serves SSE catch-up —
// here specifically the Last-Event-ID path (replay(afterSeq)) that
// routes/assessment.ts's GET /events relies on.

import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import {
  assessmentBroker,
  decideReplay,
  REPLAY_MAX_AGE_MS,
  type AssessmentEvent,
  type BufferedAssessmentEvent,
} from '../assessment-broker.js';
import { initSSE } from '../sse.js';

// Mirrors the ring buffer's private BUFFER_CAPACITY (assessment-broker.ts) —
// not exported, so the gap tests below flood past it by this literal count
// to force real evictions.
const RING_BUFFER_CAPACITY = 500;

function pullEvent(section: string): AssessmentEvent {
  return { type: 'knowledge.pulled', section, pages: 3, files_pulled: 3, ts: new Date().toISOString() };
}

describe('assessmentBroker', () => {
  it('fans a published event out to every live subscriber', () => {
    const received: AssessmentEvent[] = [];
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      const ev = pullEvent('confluence-eng');
      assessmentBroker.publish(ev);
      expect(received).toContainEqual(ev);
    } finally {
      unsubscribe();
    }
  });

  it('does not deliver to an unsubscribed callback', () => {
    const received: AssessmentEvent[] = [];
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    unsubscribe();
    assessmentBroker.publish(pullEvent('confluence-eng'));
    expect(received).toHaveLength(0);
  });

  it('a bad subscriber does not stop the emit from reaching the next one', () => {
    const received: AssessmentEvent[] = [];
    const unsubBad = assessmentBroker.subscribe(() => { throw new Error('boom'); });
    const unsubGood = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      const ev = pullEvent('confluence-eng');
      expect(() => assessmentBroker.publish(ev)).not.toThrow();
      expect(received).toContainEqual(ev);
    } finally {
      unsubBad();
      unsubGood();
    }
  });

  it('replay() with no argument returns the buffer in insertion order', () => {
    const a = assessmentBroker.publish(pullEvent('a'));
    const b = assessmentBroker.publish(pullEvent('b'));
    const all = assessmentBroker.replay();
    const ia = all.findIndex((x) => x.seq === a.seq);
    const ib = all.findIndex((x) => x.seq === b.seq);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThan(ia);
  });

  it('replay(afterSeq) — the Last-Event-ID catch-up path — returns only events published after that seq', () => {
    const before = assessmentBroker.publish(pullEvent('before'));
    const after1 = assessmentBroker.publish(pullEvent('after1'));
    const after2 = assessmentBroker.publish(pullEvent('after2'));

    const caughtUp = assessmentBroker.replay(before.seq);
    const seqs = caughtUp.map((b) => b.seq);
    expect(seqs).not.toContain(before.seq);
    expect(seqs).toEqual(expect.arrayContaining([after1.seq, after2.seq]));
    // Order preserved.
    expect(seqs.indexOf(after1.seq)).toBeLessThan(seqs.indexOf(after2.seq));
  });

  it('every publish gets a strictly increasing seq', () => {
    const a = assessmentBroker.publish(pullEvent('x'));
    const b = assessmentBroker.publish(pullEvent('y'));
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

// ─── Presence ───────────────────────────────────────────────────────────────

describe('assessmentBroker presence', () => {
  it('touch() registers a new tab and publishes the roster', () => {
    const docId = `doc-${Math.random()}`;
    const received: AssessmentEvent[] = [];
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas Lindqvist', 1_000);
      expect(assessmentBroker.viewersFor(docId, 1_000)).toEqual([
        { sub: 'u-jonas', name: 'Jonas Lindqvist', tab_id: 'tab-1', since: new Date(1_000).toISOString() },
      ]);
      const presenceEvents = received.filter((e) => e.type === 'knowledge.presence');
      expect(presenceEvents).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('a second tab for the SAME user is a distinct roster entry (dedupe is a client-side display concern, not the broker\'s)', () => {
    const docId = `doc-${Math.random()}`;
    assessmentBroker.touch(docId, 'tab-a', 'u-jonas', 'Jonas Lindqvist', 1_000);
    assessmentBroker.touch(docId, 'tab-b', 'u-jonas', 'Jonas Lindqvist', 1_000);
    const viewers = assessmentBroker.viewersFor(docId, 1_000);
    expect(viewers).toHaveLength(2);
    expect(viewers.map((v) => v.tab_id).sort()).toEqual(['tab-a', 'tab-b']);
    expect(new Set(viewers.map((v) => v.sub))).toEqual(new Set(['u-jonas']));
  });

  it('a repeat touch() (heartbeat) on the same tab refreshes it without publishing again', () => {
    const docId = `doc-${Math.random()}`;
    const received: AssessmentEvent[] = [];
    assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 1_000);
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 16_000); // heartbeat, well within TTL
      expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(0);
      // since is stable across heartbeats — only lastSeen moves.
      expect(assessmentBroker.viewersFor(docId, 16_000)).toEqual([
        { sub: 'u-jonas', name: 'Jonas', tab_id: 'tab-1', since: new Date(1_000).toISOString() },
      ]);
    } finally {
      unsubscribe();
    }
  });

  // Finding #5 (REVIEW-2026-09-05.md): `leave` used to delete unconditionally
  // and immediately, which is exactly what let a tab's unmount `leave`
  // (sendBeacon) land after the remount's `enter` `touch` and vanish the
  // viewer from their own roster. `leave` now stages the delete behind a
  // short grace period; this test (updated from its pre-fix form, which
  // asserted the immediate-delete behavior the fix removes) exercises the
  // "nobody cancels it" side past the grace window — see the two tests below
  // for the race the fix actually targets.
  it('leave() past the grace period removes the tab and publishes the shrunk roster exactly once', () => {
    jest.useFakeTimers();
    try {
      const docId = `doc-${Math.random()}`;
      const received: AssessmentEvent[] = [];
      assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 1_000);
      const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
      try {
        assessmentBroker.leave(docId, 'tab-1', 2_000);
        // Still listed immediately after leave() — in grace, no flicker.
        expect(assessmentBroker.viewersFor(docId, 2_000)).toHaveLength(1);
        expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(0);

        jest.advanceTimersByTime(2_000);

        expect(assessmentBroker.viewersFor(docId, 4_000)).toEqual([]);
        const presenceEvents = received.filter((e) => e.type === 'knowledge.presence');
        expect(presenceEvents).toHaveLength(1);
        expect(presenceEvents[0]).toMatchObject({ doc_id: docId, viewers: [] });
      } finally {
        unsubscribe();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('a touch within the grace period cancels a staged leave — viewer stays, no presence event published for the leave', () => {
    jest.useFakeTimers();
    try {
      const docId = `doc-${Math.random()}`;
      assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 1_000); // enter
      const received: AssessmentEvent[] = [];
      const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
      try {
        assessmentBroker.leave(docId, 'tab-1', 1_500); // unmount's stale leave
        jest.advanceTimersByTime(500);
        assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 2_000); // remount's enter, within the 2s grace

        expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(0);
        expect(assessmentBroker.viewersFor(docId, 2_000)).toEqual([
          { sub: 'u-jonas', name: 'Jonas', tab_id: 'tab-1', since: new Date(1_000).toISOString() },
        ]);

        // The cancelled timer must not fire later and delete the now-active entry.
        jest.advanceTimersByTime(5_000);
        expect(assessmentBroker.viewersFor(docId, 7_000)).toHaveLength(1);
        expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('leave() on a tab that was never registered is a no-op (no publish)', () => {
    const docId = `doc-${Math.random()}`;
    const received: AssessmentEvent[] = [];
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      assessmentBroker.leave(docId, 'tab-ghost', 1_000);
      expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('a tab idle past the 45s TTL is purged (and a subsequent touch from a peer publishes the shrunk roster)', () => {
    const docId = `doc-${Math.random()}`;
    assessmentBroker.touch(docId, 'tab-stale', 'u-jonas', 'Jonas', 0);
    assessmentBroker.touch(docId, 'tab-fresh', 'u-amina', 'Amina', 0);
    // tab-fresh keeps heartbeating (every 15s, well under the TTL) —
    // tab-stale never heartbeats again after its initial touch at 0.
    assessmentBroker.touch(docId, 'tab-fresh', 'u-amina', 'Amina', 15_000);
    assessmentBroker.touch(docId, 'tab-fresh', 'u-amina', 'Amina', 30_000);

    // 46s after tab-stale's LAST touch (still 0) — now past the 45s TTL —
    // while tab-fresh's last touch (30s) is only 16s old.
    const received: AssessmentEvent[] = [];
    const unsubscribe = assessmentBroker.subscribe(({ event }) => received.push(event));
    try {
      assessmentBroker.touch(docId, 'tab-fresh', 'u-amina', 'Amina', 46_000); // heartbeat from the still-live tab
      const viewers = assessmentBroker.viewersFor(docId, 46_000);
      expect(viewers).toEqual([{ sub: 'u-amina', name: 'Amina', tab_id: 'tab-fresh', since: new Date(0).toISOString() }]);
      // The purge changed the roster, so it published even though tab-fresh's
      // own touch was "just" a heartbeat.
      expect(received.filter((e) => e.type === 'knowledge.presence')).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('viewersFor() purges stale entries even with no other activity on the doc', () => {
    const docId = `doc-${Math.random()}`;
    assessmentBroker.touch(docId, 'tab-1', 'u-jonas', 'Jonas', 0);
    expect(assessmentBroker.viewersFor(docId, 45_001)).toEqual([]);
  });

  it('viewersFor() on a doc nobody has touched returns an empty roster', () => {
    expect(assessmentBroker.viewersFor(`doc-never-${Math.random()}`)).toEqual([]);
  });
});

// Frame ids must survive a process restart: a tab that reconnects with a
// Last-Event-ID from a previous life must get a full replay, and its client-
// side dedupe (keyed on the id) must never collide with the new counter.
describe('assessmentBroker frame ids across restarts', () => {
  it('prefixes ids with the boot epoch and only honours a floor from this epoch', () => {
    const { assessmentBroker } = require('../assessment-broker.js') as typeof import('../assessment-broker.js');
    const b = assessmentBroker;
    const id = b.frameId(7);
    expect(id).toBe(`${b.epoch}-7`);
    expect(b.afterSeqFromLastEventId(id)).toBe(7);
    expect(b.afterSeqFromLastEventId(`zzzz00-7`)).toBeUndefined();   // previous epoch
    expect(b.afterSeqFromLastEventId('7')).toBeUndefined();          // pre-epoch bare number
    expect(b.afterSeqFromLastEventId(undefined)).toBeUndefined();
    expect(b.afterSeqFromLastEventId(`${b.epoch}-x`)).toBeUndefined();
  });
});

// DEFECTS #5 (assessor) / #8 (lead-assessor) / #7 (program-lead, admin): a
// freshly opened tab was told an hours-old edit happened "just now" — the
// old `replay(undefined)` handed a brand-new connection the whole ring
// buffer with no age check at all. `decideReplay` is the pure function that
// now decides both halves of GET /events' catch-up policy: what a FRESH
// connection (no Last-Event-ID) gets, and what a RECONNECT (Last-Event-ID
// present) gets once bounded by `REPLAY_MAX_AGE_MS`. It supersedes the old
// replaySince/gapFrameFor pair (finding #7, REVIEW-2026-09-05.md), whose
// "replay everything when there's no afterSeq" behavior for the no-Last-
// Event-ID case was itself half of this bug.
describe('decideReplay (DEFECTS #5/#8/#7 — no stale "just now" on connect)', () => {
  function bufferedEvent(seq: number, section: string, ageMs: number, nowMs: number): BufferedAssessmentEvent {
    return { seq, event: { type: 'knowledge.pulled', section, pages: 1, files_pulled: 1, ts: new Date(nowMs - ageMs).toISOString() } };
  }

  it('no Last-Event-ID (afterSeq undefined) delivers nothing — a fresh connection has no prior view to catch up', () => {
    const now = Date.now();
    const buffer = [bufferedEvent(1, 'old', 60 * 60_000, now), bufferedEvent(2, 'new', 1_000, now)];
    const { events, gapped } = decideReplay(buffer, undefined, now);
    expect(events).toEqual([]);
    expect(gapped).toBe(false);
  });

  it('a Last-Event-ID inside the buffer and within the age bound replays exactly the gap, not gapped', () => {
    const now = Date.now();
    const buffer = [
      bufferedEvent(1, 'seen-already', 5 * 60_000, now),
      bufferedEvent(2, 'missed-1', 3 * 60_000, now),
      bufferedEvent(3, 'missed-2', 60_000, now),
    ];
    const { events, gapped } = decideReplay(buffer, 1, now);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(gapped).toBe(false);
  });

  it('a Last-Event-ID older than the age bound is told about a gap, and only the events still within the bound replay', () => {
    const now = Date.now();
    const buffer = [
      bufferedEvent(1, 'ancient-anchor', 90 * 60_000, now),   // this is the client's own Last-Event-ID
      bufferedEvent(2, 'also-too-old', 40 * 60_000, now),     // past REPLAY_MAX_AGE_MS (30m) — dropped
      bufferedEvent(3, 'within-bound', 5 * 60_000, now),      // within the bound — delivered
    ];
    const { events, gapped } = decideReplay(buffer, 1, now, REPLAY_MAX_AGE_MS);
    expect(events.map((e) => e.seq)).toEqual([3]);
    expect(gapped).toBe(true);
  });

  it('frames older than the age bound are dropped even when every seq after afterSeq is still ring-buffer-resident', () => {
    const now = Date.now();
    const buffer = [
      bufferedEvent(1, 'anchor', 50 * 60_000, now),
      bufferedEvent(2, 'stale', 45 * 60_000, now),  // older than the 30m bound
      bufferedEvent(3, 'stale2', 31 * 60_000, now), // still older than the bound
    ];
    const { events, gapped } = decideReplay(buffer, 1, now, 30 * 60_000);
    expect(events).toEqual([]);
    expect(gapped).toBe(true);
  });

  it('is gapped when afterSeq is a real seq from this epoch that the ring buffer has since evicted (capacity, not age)', () => {
    const now = Date.now();
    // afterSeq=5 but the buffer's oldest held entry is seq 10 — everything
    // between 5 and 10 was shifted out by BUFFER_CAPACITY, independent of age.
    const buffer = [bufferedEvent(10, 'oldest-held', 1_000, now), bufferedEvent(11, 'next', 500, now)];
    const { events, gapped } = decideReplay(buffer, 5, now);
    expect(gapped).toBe(true);
    expect(events.map((e) => e.seq)).toEqual([10, 11]);
  });

  it('is NOT gapped when afterSeq sits immediately before the current oldest entry (nothing was evicted, nothing aged out)', () => {
    const now = Date.now();
    const buffer = [bufferedEvent(10, 'oldest-held', 1_000, now)];
    const { gapped } = decideReplay(buffer, 9, now);
    expect(gapped).toBe(false);
  });

  it('an empty buffer with a Last-Event-ID delivers nothing and is not gapped (client is caught up, buffer has nothing at all)', () => {
    const { events, gapped } = decideReplay([], 42, Date.now());
    expect(events).toEqual([]);
    expect(gapped).toBe(false);
  });
});

describe('assessmentBroker.catchUp / gapFrame — wiring decideReplay to the live broker', () => {
  it('catchUp(undefined) delivers nothing for a fresh connection even with a full buffer', () => {
    for (let i = 0; i < 5; i++) assessmentBroker.publish(pullEvent(`fresh-${i}`));
    const { events, gapped } = assessmentBroker.catchUp(undefined);
    expect(events).toEqual([]);
    expect(gapped).toBe(false);
  });

  it('catchUp(afterSeq) matches decideReplay against the broker\'s own buffer', () => {
    const a = assessmentBroker.publish(pullEvent('a'));
    const b = assessmentBroker.publish(pullEvent('b'));
    const { events, gapped } = assessmentBroker.catchUp(a.seq);
    expect(gapped).toBe(false);
    expect(events.some((e) => e.seq === b.seq)).toBe(true);
  });

  it('catchUp is gapped once the ring buffer evicts the client\'s anchor', () => {
    const marker = assessmentBroker.publish(pullEvent('marker'));
    for (let i = 0; i < RING_BUFFER_CAPACITY + 10; i++) assessmentBroker.publish(pullEvent(`flood-${i}`));
    const { gapped } = assessmentBroker.catchUp(marker.seq);
    expect(gapped).toBe(true);
  });

  it('gapFrame() returns a stream.gap frame with a valid, dedupe-safe frame id, never persisted to the ring buffer', () => {
    const before = assessmentBroker.replay().length;
    const gap = assessmentBroker.gapFrame();
    expect(gap.event).toMatchObject({ type: 'stream.gap' });
    expect(typeof gap.event.ts).toBe('string');
    expect(assessmentBroker.afterSeqFromLastEventId(gap.id)).toBeDefined();
    expect(assessmentBroker.replay().length).toBe(before);
  });
});

// Finding #9 (REVIEW-2026-09-05.md): initSSE cleared its heartbeat on 'close'
// but registered no 'error' listener on the response, so a mid-write socket
// reset (Node emits 'error' on the Writable) was an uncaught exception with
// zero listeners — able to crash the whole middleware process.
describe('initSSE (finding #9 — a socket error must not crash the process)', () => {
  function fakeRes() {
    const res = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      writeHead: (...args: unknown[]) => void;
      write: jest.Mock;
    };
    res.writableEnded = false;
    res.writeHead = jest.fn();
    res.write = jest.fn(() => true);
    return res;
  }

  it('does not throw when the response emits "error" mid-stream, and clears the heartbeat', () => {
    jest.useFakeTimers();
    try {
      const res = fakeRes();
      expect(() => initSSE(res as unknown as Response)).not.toThrow();
      // Node throws synchronously on emit('error', ...) with zero listeners
      // registered — exactly the crash this finding describes.
      expect(() => res.emit('error', new Error('socket hang up'))).not.toThrow();

      const writesAfterError = res.write.mock.calls.length;
      jest.advanceTimersByTime(60_000); // several heartbeat ticks, if it were still scheduled
      expect(res.write.mock.calls.length).toBe(writesAfterError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still clears the heartbeat on "close" (pre-existing behavior, unchanged)', () => {
    jest.useFakeTimers();
    try {
      const res = fakeRes();
      initSSE(res as unknown as Response);
      res.emit('close');
      const writesAtClose = res.write.mock.calls.length;
      jest.advanceTimersByTime(60_000);
      expect(res.write.mock.calls.length).toBe(writesAtClose);
    } finally {
      jest.useRealTimers();
    }
  });
});
