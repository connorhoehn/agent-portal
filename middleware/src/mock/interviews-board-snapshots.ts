// The whiteboard checkpoints' fixture (WHITEBOARD-PLAN step 1): the mock world's interview_board_snapshots.
//
// Mateo's finished system design round (iv-j6x2d9sb in mock/interviews.ts, Hugo leads, the rate limiter questions)
// was worked on the Blueprint: four checkpoints over the hour, each the Blueprint with the notes he had added by then.
// Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts). Registered from its own
// module (lib/interviews/board/snapshots.ts imports it).
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import { blueprintBoard, withNotes } from '../lib/interviews/board/templates.js';
import type { BoardSnapshotRecord } from '../lib/interviews/board/snapshots.js';

const IV = 'iv-j6x2d9sb';
const HUGO = 'u-hugo';

/** The notes Mateo added, in order, and the minute each checkpoint was taken after. */
const NOTES: ReadonlyArray<{ frame: string; text: string }> = [
  { frame: 'clarify', text: 'Per API key, or per user too?' },
  { frame: 'requirements', text: 'Over the limit: 429 with Retry-After' },
  { frame: 'nfr', text: 'Adds under 2 ms at p99' },
  { frame: 'hld', text: 'Token bucket in Redis, one script per call' },
  { frame: 'data', text: 'Key: api key and window; tokens, last refill' },
  { frame: 'api', text: 'X-RateLimit-Remaining on every answer' },
  { frame: 'tradeoffs', text: 'Fail open when Redis is down; a local bucket backs it' },
];
const CHECKPOINTS: ReadonlyArray<{ minute: number; notes: number }> = [
  { minute: 8, notes: 1 }, { minute: 24, notes: 3 }, { minute: 41, notes: 5 }, { minute: 57, notes: 7 },
];

function rows(): BoardSnapshotRecord[] {
  return CHECKPOINTS.map(({ minute, notes }, i) => {
    const elements = withNotes(blueprintBoard(), NOTES.slice(0, notes)).elements;
    return {
      interviewId: IV, seq: i + 1, at: seedAt(-3, 14, minute, 0), whoId: HUGO, side: 'panel',
      elements: elements.filter((e) => !e['isDeleted']).length, scene: JSON.stringify(elements),
    };
  });
}

export const interviewBoardSnapshotsFixture = defineFixture<BoardSnapshotRecord>({
  key: 'interviews.board-snapshots',
  scenarios: { default: rows, empty: () => [] },
});
