// The pad log's fixture (docs/interviews-tenant-plan.md decision 12, row I4.3): the mock world's interview_pad_events.
//
// Mateo's finished coding round (iv-j6x2d9sb in mock/interviews.ts, Hugo leads), lined up with the transcript stand-in
// in mock/interviews-records.ts: Hugo inserts the rate-limiter question and sets the language, Mateo types the bucket,
// pastes a small helper of his own (a paste is an event, not an accusation), and the pad is snapshotted twice. The
// candidate's id is the records stand-in's (`guest:iv-j6x2d9sb`). Registered from its own module
// (lib/interviews/pad/log/store.ts imports it). Times follow mock/interviews.ts's `at()`: days from today's UTC midnight.
import { clock, defineFixture } from './core/index.js';
import type { PadEventRecord } from '../lib/interviews/pad/log/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const IV = 'iv-j6x2d9sb';
const HUGO = 'u-hugo';
const MATEO = 'guest:iv-j6x2d9sb';

/** Seconds after the round's start (-3d 14:00). */
function at(seconds: number): string {
  const now = clock.now().getTime();
  const midnight = now - (now % DAY_MS);
  return new Date(midnight - 3 * DAY_MS + 14 * 60 * 60 * 1000 + seconds * 1000).toISOString();
}

const STARTER = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        pass\n\n    def allow(self, now: float) -> bool:\n        pass\n';
const FIRST = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        self.capacity = capacity\n        self.rate = refill_per_second\n        self.buckets = {}\n\n    def allow(self, key: str, now: float) -> bool:\n        pass\n';
const SECOND = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        self.capacity = capacity\n        self.rate = refill_per_second\n        self.buckets = {}\n\n    def allow(self, key: str, now: float) -> bool:\n        tokens, last = self.buckets.get(key, (self.capacity, now))\n        tokens = clamp(tokens + (now - last) * self.rate, 0, self.capacity)\n        if tokens < 1:\n            self.buckets[key] = (tokens, now)\n            return False\n        self.buckets[key] = (tokens - 1, now)\n        return True\n\n\ndef clamp(value: float, low: float, high: float) -> float:\n    return max(low, min(high, value))\n';

type Row = Omit<PadEventRecord, 'interviewId' | 'seq' | 'at' | 'clientAt'> & { s: number };
const none = { from: null, inserted: null, deleted: null, length: null, lines: null, via: null, language: null, questionId: null, text: null } as const;
const ROWS: Row[] = [
  { ...none, s: 70, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-ratelimit', from: 0, inserted: STARTER.length, length: STARTER.length, language: 'python' },
  { ...none, s: 72, whoId: HUGO, side: 'panel', kind: 'language', language: 'python' },
  { ...none, s: 430, whoId: MATEO, side: 'candidate', kind: 'edit', from: 92, inserted: 34, deleted: 4, length: STARTER.length + 30 },
  { ...none, s: 470, whoId: MATEO, side: 'candidate', kind: 'edit', from: 126, inserted: 49, deleted: 0, length: STARTER.length + 79 },
  { ...none, s: 520, whoId: MATEO, side: 'candidate', kind: 'edit', from: 176, inserted: 9, deleted: 0, length: FIRST.length },
  { ...none, s: 540, whoId: MATEO, side: 'candidate', kind: 'snapshot', length: FIRST.length, language: 'python', text: FIRST },
  { ...none, s: 585, whoId: MATEO, side: 'candidate', kind: 'edit', from: 214, inserted: 262, deleted: 4, length: FIRST.length + 258 },
  { ...none, s: 600, whoId: MATEO, side: 'candidate', kind: 'paste', from: FIRST.length + 258, inserted: 102, lines: 3, via: 'paste', length: SECOND.length },
  { ...none, s: 660, whoId: MATEO, side: 'candidate', kind: 'snapshot', length: SECOND.length, language: 'python', text: SECOND },
];

export const interviewPadLogFixture = defineFixture<PadEventRecord>({
  key: 'interviews.pad-log',
  scenarios: {
    default: () => ROWS.map(({ s, ...r }, i) => ({ ...r, interviewId: IV, seq: i + 1, at: at(s), clientAt: at(s) })),
    empty: () => [],
  },
});
