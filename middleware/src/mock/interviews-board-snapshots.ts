// The whiteboard checkpoints' fixture (WHITEBOARD-PLAN step 1): the mock world's interview_board_snapshots.
//
// Ingrid's finished System design round (iv-b8w3q6ld in mock/interviews.ts, Hugo leads, the ledger question) was worked
// on the Blueprint: four checkpoints over the hour, each the Blueprint with the notes she had added by then, in step with
// her transcript (mock/interviews-records.ts).
// Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts). Registered from its own
// module (lib/interviews/board/snapshots.ts imports it).
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import { blueprintBoard, withNotes } from '../lib/interviews/board/templates.js';
import type { BoardSnapshotRecord } from '../lib/interviews/board/snapshots.js';

const IV = 'iv-b8w3q6ld';
const HUGO = 'u-hugo';

/** The notes Ingrid added, in order, and the minute each checkpoint was taken after. */
const NOTES: ReadonlyArray<{ frame: string; text: string }> = [
  { frame: 'clarify', text: 'Peak rate? Active-passive or active-active?' },
  { frame: 'requirements', text: 'A capture is never booked twice' },
  { frame: 'nfr', text: '2,000 writes a second at peak' },
  { frame: 'hld', text: 'Entry pair and outbox in one transaction; a worker publishes' },
  { frame: 'data', text: 'Entries by account and time; a table of keys' },
  { frame: 'api', text: 'Capture and refund, each with an idempotency key' },
  { frame: 'tradeoffs', text: 'Balances lag a second; sync replication costs ms' },
];
const CHECKPOINTS: ReadonlyArray<{ minute: number; notes: number }> = [
  { minute: 6, notes: 1 }, { minute: 14, notes: 3 }, { minute: 33, notes: 5 }, { minute: 45, notes: 7 },
];

function rows(): BoardSnapshotRecord[] {
  return CHECKPOINTS.map(({ minute, notes }, i) => {
    const elements = withNotes(blueprintBoard(), NOTES.slice(0, notes)).elements;
    return {
      interviewId: IV, seq: i + 1, at: seedAt(-7, 14, minute, 0), whoId: HUGO, side: 'panel',
      elements: elements.filter((e) => !e['isDeleted']).length, scene: JSON.stringify(elements),
    };
  });
}

export const interviewBoardSnapshotsFixture = defineFixture<BoardSnapshotRecord>({
  key: 'interviews.board-snapshots',
  scenarios: { default: rows, empty: () => [] },
});
