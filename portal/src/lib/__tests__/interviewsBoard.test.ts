// The whiteboard's helpers (lib/interviewsBoard.ts; WHITEBOARD-PLAN steps 1 and 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as YT from 'yjs';
import { BOARD_DOCUMENT_PREFIX, boardChannel, boardDocumentId, fitBoardView, insertBoard, readBoardElements, sceneKey, surfaceOf } from '../interviewsBoard.ts';
import { roomTabs } from '../interviewsRoom.ts';
import * as server from '../../../../middleware/src/lib/interviews/board/channel.ts';
import { blueprintBoard, promptBoard } from '../../../../middleware/src/lib/interviews/board/templates.ts';

// The library's binding is CommonJS and requires yjs itself; under node the Y.Doc must come from that same copy (the
// browser bundle has one copy).
const Y = createRequire(import.meta.url)('yjs') as typeof YT;

test('the names match the server\'s, by value', () => {
  assert.equal(BOARD_DOCUMENT_PREFIX, server.BOARD_DOCUMENT_PREFIX);
  for (const id of ['iv-k1p5w8ra', '123e4567-e89b-12d3-a456-426614174000', 'x'.repeat(38), 'x'.repeat(39), '../pad']) {
    assert.equal(boardDocumentId(id), server.boardDocumentId(id));
    assert.equal(boardChannel(id), server.boardChannel(id));
  }
  assert.equal(boardChannel('iv-a'), 'doc:ivboard:iv-a');
});

test('a technical round is on the pad unless it says board; a behavioural round has neither', () => {
  assert.equal(surfaceOf({ type: 'technical' }), 'pad');
  assert.equal(surfaceOf({ type: 'technical', surface: 'board' }), 'board');
  assert.equal(surfaceOf({ type: 'behavioural', surface: 'board' }), null);
  assert.deepEqual(roomTabs('technical', 'board').map((t) => t.label), ['Board', 'Questions', 'Milo', 'Chat']);
  assert.deepEqual(roomTabs('technical').map((t) => t.label), ['Pad', 'Questions', 'Milo', 'Chat']);
});

test('a starting board goes in as one write, beside what is drawn, and a second pick adds nothing', () => {
  const doc = new Y.Doc();
  const updates: number[] = [];
  doc.on('update', () => updates.push(1));
  const blueprint = blueprintBoard();
  assert.equal(insertBoard(doc, blueprint), blueprint.elements.length);
  assert.equal(updates.length, 1);
  assert.equal(readBoardElements(doc).length, blueprint.elements.length);
  assert.equal(insertBoard(doc, blueprint), 0);
  const prompt = promptBoard('Design a URL shortener for 100M links a month');
  assert.equal(insertBoard(doc, prompt), prompt.elements.length);
  const frames = readBoardElements(doc).filter((e) => e.type === 'frame').map((e) => e['name']);
  assert.equal(frames.length, 12);
  assert.ok(frames.includes('Non-functional requirements'));
});

test('a second document, fed the first one\'s update, holds the same board (what the other seat sees)', () => {
  const lead = new Y.Doc();
  const candidate = new Y.Doc();
  lead.on('update', (u: Uint8Array) => Y.applyUpdate(candidate, u));
  insertBoard(lead, blueprintBoard());
  assert.equal(sceneKey(readBoardElements(candidate)), sceneKey(readBoardElements(lead)));
});

test('fitting a board sends Excalidraw its own "Zoom to fit" (Shift+1) at the canvas, and finds nothing to fit without one', () => {
  const g = globalThis as { KeyboardEvent?: unknown };
  const had = g.KeyboardEvent;
  g.KeyboardEvent ??= class extends Event { constructor(type: string, init: Record<string, unknown>) { super(type, init); this.code = String(init['code']); this.shiftKey = Boolean(init['shiftKey']); } code: string; shiftKey: boolean; };
  try {
    const sent: Array<{ type: string; code: string; shiftKey: boolean; bubbles: boolean }> = [];
    const canvas = { dispatchEvent: (e: { type: string; code: string; shiftKey: boolean; bubbles: boolean }) => { sent.push(e); return true; } };
    const asked: string[] = [];
    const root = { querySelector: (q: string) => { asked.push(q); return canvas; } } as unknown as ParentNode;
    assert.equal(fitBoardView(root), true);
    assert.deepEqual(asked, ['.excalidraw']);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]!.type, sent[0]!.code, sent[0]!.shiftKey, sent[0]!.bubbles], ['keydown', 'Digit1', true, true]);
    assert.equal(fitBoardView({ querySelector: () => null } as unknown as ParentNode), false);
    assert.equal(fitBoardView(null), false);
  } finally { g.KeyboardEvent = had; }
});

test('the record page offers the final board and a few timed checkpoints spread over the round', async () => {
  const { boardMoments } = await import('../interviewsBoard.ts');
  const start = '2026-11-18T10:00:00.000Z';
  const snap = (seq: number, min: number) => ({ seq, at: new Date(Date.parse(start) + min * 60_000).toISOString(), who: { id: 'u', name: 'Lead' }, elements: [{ id: `e${seq}`, type: 'rectangle' }] });
  assert.deepEqual(boardMoments([], start), []);
  const one = boardMoments([snap(1, 3)], start);
  assert.deepEqual(one.map((m) => [m.seq, m.label, m.final, m.atMs]), [[1, 'Final, 3:00', true, 180_000]]);
  const twelve = Array.from({ length: 12 }, (_, i) => snap(i + 1, i + 1));
  const five = boardMoments(twelve, start);
  assert.equal(five.length, 5);
  assert.deepEqual(five.map((m) => m.seq), [1, 4, 8, 11, 12]);
  assert.deepEqual(five.map((m) => m.final), [false, false, false, false, true]);
  assert.equal(five[0]!.label, '1:00');
  assert.equal(boardMoments(twelve, start, 3).length, 3);
  assert.equal(boardMoments(twelve.slice(0, 3), start).length, 3, 'fewer than the cap: every one');
  assert.equal(boardMoments([snap(1, 2)], null)[0]!.atMs, 0, 'no start: the clock reads 0');
});
