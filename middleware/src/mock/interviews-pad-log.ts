// The pad log's fixture (docs/interviews-tenant-plan.md decision 12, row I4.3): the mock world's interview_pad_events.
//
// Each finished technical round has a log (Mateo's, Ingrid's coding round and Ravi's, row I5.1). Mateo's finished coding round (iv-j6x2d9sb in mock/interviews.ts, Hugo leads), lined up with the transcript stand-in
// in mock/interviews-records.ts: Hugo inserts the rate-limiter question and sets the language, Mateo types the bucket,
// pastes a small helper of his own (a paste is an event, not an accusation), and the pad is snapshotted twice. The
// candidate's id is the records stand-in's (`guest:iv-j6x2d9sb`). Registered from its own module
// (lib/interviews/pad/log/store.ts imports it). Times follow mock/interviews.ts's `at()`: days from today's UTC midnight.
import { clock, defineFixture } from './core/index.js';
import { LIVE_INTERVIEW_ID, liveStart } from './interviews.js';
import type { PadEventRecord } from '../lib/interviews/pad/log/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HUGO = 'u-hugo';
const WEN = 'u-wen';

/** Seconds after a round's start (`days` from today's UTC midnight, at `hour`). */
function atFor(days: number, hour: number, seconds: number): string {
  const now = clock.now().getTime();
  const midnight = now - (now % DAY_MS);
  return new Date(midnight + days * DAY_MS + hour * 60 * 60 * 1000 + seconds * 1000).toISOString();
}

type Row = Omit<PadEventRecord, 'interviewId' | 'seq' | 'at' | 'clientAt'> & { s: number };
const none = { from: null, inserted: null, deleted: null, length: null, lines: null, via: null, language: null, questionId: null, text: null } as const;

function rowsOf(interviewId: string, days: number, hour: number, rows: Row[]): PadEventRecord[] {
  return rows.map(({ s, ...r }, i) => ({ ...r, interviewId, seq: i + 1, at: atFor(days, hour, s), clientAt: atFor(days, hour, s) }));
}

/** The same rows for a round that started at `start` (an instant), as a live round's do. */
function rowsOfAt(interviewId: string, start: string, rows: Row[]): PadEventRecord[] {
  const t = (s: number) => new Date(Date.parse(start) + s * 1000).toISOString();
  return rows.map(({ s, ...r }, i) => ({ ...r, interviewId, seq: i + 1, at: t(s), clientAt: t(s) }));
}

// ── Mateo (iv-j6x2d9sb, -3d 14:00) ──
const IV = 'iv-j6x2d9sb';
const MATEO = 'guest:iv-j6x2d9sb';
const STARTER = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        pass\n\n    def allow(self, now: float) -> bool:\n        pass\n';
const FIRST = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        self.capacity = capacity\n        self.rate = refill_per_second\n        self.buckets = {}\n\n    def allow(self, key: str, now: float) -> bool:\n        pass\n';
const SECOND = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        self.capacity = capacity\n        self.rate = refill_per_second\n        self.buckets = {}\n\n    def allow(self, key: str, now: float) -> bool:\n        tokens, last = self.buckets.get(key, (self.capacity, now))\n        tokens = clamp(tokens + (now - last) * self.rate, 0, self.capacity)\n        if tokens < 1:\n            self.buckets[key] = (tokens, now)\n            return False\n        self.buckets[key] = (tokens - 1, now)\n        return True\n\n\ndef clamp(value: float, low: float, high: float) -> float:\n    return max(low, min(high, value))\n';

const RETRY_STARTER = '\ndef charge_with_retry(provider, amount_cents: int, card_token: str) -> str:\n    pass\n';
const RETRY_BODY = '\ndef charge_with_retry(provider, amount_cents: int, card_token: str) -> str:\n    key = new_idempotency_key()\n    delay = 0.1\n    for attempt in range(5):\n        try:\n            return provider.charge(amount_cents, card_token, key)\n        except Timeout:\n            time.sleep(delay + random.random() * delay)\n            delay = min(delay * 2, 4.0)\n    raise ChargeFailed(key)\n';
const MATEO_ROWS: Row[] = [
  { ...none, s: 70, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-ratelimit', from: 0, inserted: STARTER.length, length: STARTER.length, language: 'python' },
  { ...none, s: 72, whoId: HUGO, side: 'panel', kind: 'language', language: 'python' },
  { ...none, s: 430, whoId: MATEO, side: 'candidate', kind: 'edit', from: 92, inserted: 34, deleted: 4, length: STARTER.length + 30 },
  { ...none, s: 470, whoId: MATEO, side: 'candidate', kind: 'edit', from: 126, inserted: 49, deleted: 0, length: STARTER.length + 79 },
  { ...none, s: 520, whoId: MATEO, side: 'candidate', kind: 'edit', from: 176, inserted: 9, deleted: 0, length: FIRST.length },
  { ...none, s: 540, whoId: MATEO, side: 'candidate', kind: 'snapshot', length: FIRST.length, language: 'python', text: FIRST },
  { ...none, s: 585, whoId: MATEO, side: 'candidate', kind: 'edit', from: 214, inserted: 262, deleted: 4, length: FIRST.length + 258 },
  { ...none, s: 600, whoId: MATEO, side: 'candidate', kind: 'paste', from: FIRST.length + 258, inserted: 102, lines: 3, via: 'paste', length: SECOND.length },
  { ...none, s: 660, whoId: MATEO, side: 'candidate', kind: 'snapshot', length: SECOND.length, language: 'python', text: SECOND },
  { ...none, s: 1470, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-retry', from: SECOND.length, inserted: RETRY_STARTER.length, length: SECOND.length + RETRY_STARTER.length, language: 'python' },
  { ...none, s: 1750, whoId: MATEO, side: 'candidate', kind: 'edit', from: SECOND.length + 60, inserted: 180, deleted: 4, length: SECOND.length + RETRY_STARTER.length + 176 },
  { ...none, s: 1920, whoId: MATEO, side: 'candidate', kind: 'snapshot', length: (SECOND + RETRY_BODY).length, language: 'python', text: SECOND + RETRY_BODY },
];

// ── Ingrid's coding round (iv-d7q4n9xe, -9d 14:00, Hugo leads): the same two questions, a different approach ──
const INGRID = 'guest:iv-d7q4n9xe';
const I_BUCKET = STARTER.replace('        pass\n\n    def allow', '        self.capacity = capacity\n        self.rate = refill_per_second\n        self.tokens = capacity\n        self.last = 0.0\n\n    def allow');
const I_DONE = I_BUCKET.replace('    def allow(self, now: float) -> bool:\n        pass\n', '    def allow(self, now: float) -> bool:\n        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)\n        self.last = now\n        if self.tokens >= 1:\n            self.tokens -= 1\n            return True\n        return False\n');
const I_HELPER = '\ndef clamp(value, low, high):\n    return max(low, min(high, value))\n';
const INGRID_ROWS: Row[] = [
  { ...none, s: 95, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-ratelimit', from: 0, inserted: STARTER.length, length: STARTER.length, language: 'python' },
  { ...none, s: 98, whoId: HUGO, side: 'panel', kind: 'language', language: 'python' },
  { ...none, s: 380, whoId: INGRID, side: 'candidate', kind: 'edit', from: 92, inserted: 140, deleted: 4, length: I_BUCKET.length },
  { ...none, s: 520, whoId: INGRID, side: 'candidate', kind: 'snapshot', length: I_BUCKET.length, language: 'python', text: I_BUCKET },
  { ...none, s: 560, whoId: INGRID, side: 'candidate', kind: 'edit', from: I_BUCKET.length - 24, inserted: 210, deleted: 0, length: I_DONE.length },
  { ...none, s: 610, whoId: INGRID, side: 'candidate', kind: 'paste', from: I_DONE.length, inserted: I_HELPER.length, lines: 3, via: 'paste', length: I_DONE.length + I_HELPER.length },
  { ...none, s: 900, whoId: INGRID, side: 'candidate', kind: 'snapshot', length: I_DONE.length + I_HELPER.length, language: 'python', text: I_DONE + I_HELPER },
  { ...none, s: 1620, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-retry', from: I_DONE.length + I_HELPER.length, inserted: RETRY_STARTER.length, length: I_DONE.length + I_HELPER.length + RETRY_STARTER.length, language: 'python' },
  { ...none, s: 2050, whoId: INGRID, side: 'candidate', kind: 'snapshot', length: (I_DONE + I_HELPER + RETRY_BODY).length, language: 'python', text: I_DONE + I_HELPER + RETRY_BODY },
];

// ── Ravi's coding round (iv-p2v7j4ye, -2d 15:00, Wen leads): Swift ──
const RAVI = 'guest:iv-p2v7j4ye';
const SWIFT_STARTER = 'struct FeedView: View {\n    var body: some View {\n        List {\n        }\n    }\n}\n';
const SWIFT_FIRST = 'struct FeedView: View {\n    @StateObject private var model = FeedModel()\n\n    var body: some View {\n        List(model.items) { item in\n            Text(item.title)\n                .onAppear { model.loadMoreIfNeeded(after: item) }\n        }\n    }\n}\n';
const SWIFT_MODEL = SWIFT_FIRST + '\nfinal class FeedModel: ObservableObject {\n    @Published var items: [Item] = []\n    private var loadedPages = Set<Int>()\n\n    func loadMoreIfNeeded(after item: Item) {\n        let page = items.count / 20 + 1\n        guard !loadedPages.contains(page) else { return }\n        loadedPages.insert(page)\n    }\n}\n';
const SWIFT_DEBOUNCE_STARTER = 'final class SearchModel: ObservableObject {\n    @Published var query = ""\n    @Published var results: [String] = []\n}\n';
const SWIFT_DEBOUNCE = 'final class SearchModel: ObservableObject {\n    @Published var query = ""\n    @Published var results: [String] = []\n    private var task: Task<Void, Never>?\n\n    func queryChanged(_ text: String) {\n        task?.cancel()\n        task = Task {\n            try? await Task.sleep(nanoseconds: 300_000_000)\n            guard !Task.isCancelled else { return }\n            await search(text)\n        }\n    }\n}\n';
const RAVI_ROWS: Row[] = [
  { ...none, s: 85, whoId: WEN, side: 'panel', kind: 'insert', questionId: 'q-ios-feed', from: 0, inserted: SWIFT_STARTER.length, length: SWIFT_STARTER.length, language: 'swift' },
  { ...none, s: 88, whoId: WEN, side: 'panel', kind: 'language', language: 'swift' },
  { ...none, s: 400, whoId: RAVI, side: 'candidate', kind: 'edit', from: 60, inserted: 180, deleted: 0, length: SWIFT_FIRST.length },
  { ...none, s: 560, whoId: RAVI, side: 'candidate', kind: 'snapshot', length: SWIFT_FIRST.length, language: 'swift', text: SWIFT_FIRST },
  { ...none, s: 700, whoId: RAVI, side: 'candidate', kind: 'paste', from: SWIFT_FIRST.length, inserted: SWIFT_MODEL.length - SWIFT_FIRST.length, lines: 11, via: 'paste', length: SWIFT_MODEL.length },
  { ...none, s: 840, whoId: RAVI, side: 'candidate', kind: 'snapshot', length: SWIFT_MODEL.length, language: 'swift', text: SWIFT_MODEL },
  { ...none, s: 1900, whoId: WEN, side: 'panel', kind: 'insert', questionId: 'q-ios-debounce', from: 0, inserted: SWIFT_DEBOUNCE_STARTER.length, deleted: SWIFT_MODEL.length, length: SWIFT_DEBOUNCE_STARTER.length, language: 'swift' },
  { ...none, s: 2300, whoId: RAVI, side: 'candidate', kind: 'edit', from: 130, inserted: 260, deleted: 0, length: SWIFT_DEBOUNCE.length },
  { ...none, s: 2480, whoId: RAVI, side: 'candidate', kind: 'snapshot', length: SWIFT_DEBOUNCE.length, language: 'swift', text: SWIFT_DEBOUNCE },
];

// ── Kwame's coding round (LIVE_INTERVIEW_ID, live now, Hugo leads): the limiter, first with the off-by-one, then fixed ──
const KWAME = `guest:${LIVE_INTERVIEW_ID}`;
const K_BUCKET = 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        self.capacity = capacity\n        self.rate = refill_per_second\n        self.tokens = capacity\n        self.last = 0.0\n\n    def allow(self, now: float) -> bool:\n        self.tokens += (now - self.last) * self.rate\n        self.last = now\n        if self.tokens > 1:\n            self.tokens -= 1\n            return True\n        return False\n';
const K_CLAMP = '\ndef clamp(value, low, high):\n    return max(low, min(high, value))\n';
const K_FIXED = K_BUCKET.replace('self.tokens += (now - self.last) * self.rate', 'self.tokens = clamp(self.tokens + (now - self.last) * self.rate, 0, self.capacity)').replace('self.tokens > 1', 'self.tokens >= 1') + K_CLAMP;
const KWAME_ROWS: Row[] = [
  { ...none, s: 45, whoId: HUGO, side: 'panel', kind: 'insert', questionId: 'q-be-ratelimit', from: 0, inserted: STARTER.length, length: STARTER.length, language: 'python' },
  { ...none, s: 47, whoId: HUGO, side: 'panel', kind: 'language', language: 'python' },
  { ...none, s: 150, whoId: KWAME, side: 'candidate', kind: 'edit', from: 92, inserted: 110, deleted: 4, length: STARTER.length + 106 },
  { ...none, s: 215, whoId: KWAME, side: 'candidate', kind: 'edit', from: 200, inserted: 190, deleted: 0, length: K_BUCKET.length },
  { ...none, s: 255, whoId: KWAME, side: 'candidate', kind: 'snapshot', length: K_BUCKET.length, language: 'python', text: K_BUCKET },
  { ...none, s: 340, whoId: KWAME, side: 'candidate', kind: 'edit', from: 280, inserted: 60, deleted: 2, length: K_BUCKET.length + 58 },
  { ...none, s: 375, whoId: KWAME, side: 'candidate', kind: 'paste', from: K_BUCKET.length, inserted: K_CLAMP.length, lines: 3, via: 'paste', length: K_BUCKET.length + K_CLAMP.length },
  { ...none, s: 450, whoId: KWAME, side: 'candidate', kind: 'snapshot', length: K_FIXED.length, language: 'python', text: K_FIXED },
];

export const interviewPadLogFixture = defineFixture<PadEventRecord>({
  key: 'interviews.pad-log',
  scenarios: {
    default: () => [...rowsOf(IV, -3, 14, MATEO_ROWS), ...rowsOf('iv-d7q4n9xe', -9, 14, INGRID_ROWS), ...rowsOf('iv-p2v7j4ye', -2, 15, RAVI_ROWS),
      ...rowsOfAt(LIVE_INTERVIEW_ID, liveStart(), KWAME_ROWS)],
    empty: () => [],
  },
});
