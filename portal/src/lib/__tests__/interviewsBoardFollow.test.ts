import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_CANVAS_KEY, BOARD_NOTICE_MS, boardPeers, cameraToContain, canvasSizeTicker, followLabel, followStep, followTarget, initialFollow,
  isOwnBoardInput, visibleArea, type FollowMode,
} from '../interviewsBoardFollow.ts';

test('visibleArea: the scene rectangle a camera shows (Excalidraw: view = (scene + scroll) * zoom)', () => {
  assert.deepEqual(visibleArea({ scrollX: 0, scrollY: 0, zoom: 1 }, { width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual(visibleArea({ scrollX: -1000, scrollY: 200, zoom: 2 }, { width: 800, height: 600 }), { x: 1000, y: -200, width: 400, height: 300 });
});

test('cameraToContain: a rectangle that fits at the preferred zoom is centred at that zoom', () => {
  const cam = cameraToContain({ x: 1000, y: 0, width: 400, height: 300 }, { width: 800, height: 600 }, { zoom: 1 });
  assert.equal(cam.zoom, 1);
  const seen = visibleArea(cam, { width: 800, height: 600 });
  assert.equal(seen.x + seen.width / 2, 1200);
  assert.equal(seen.y + seen.height / 2, 150);
});

test('cameraToContain: a larger rectangle zooms out until it fits, with the margin, and never past the floor', () => {
  const canvas = { width: 800, height: 600 };
  const rect = { x: 0, y: 0, width: 1600, height: 600 };
  const cam = cameraToContain(rect, canvas, { zoom: 1, margin: 0 });
  assert.equal(cam.zoom, 0.5);
  const seen = visibleArea(cam, canvas);
  assert.ok(seen.x <= rect.x && seen.x + seen.width >= rect.x + rect.width);
  assert.ok(seen.y <= rect.y && seen.y + seen.height >= rect.y + rect.height);
  const margin = cameraToContain(rect, canvas, { zoom: 1, margin: 0.1 });
  assert.ok(margin.zoom < 0.5);
  assert.equal(cameraToContain({ x: 0, y: 0, width: 1e6, height: 10 }, canvas, { zoom: 1 }).zoom, 0.1);
  // A degenerate rectangle (a pointer) is centred at the preferred zoom.
  const point = cameraToContain({ x: 50, y: 60, width: 0, height: 0 }, canvas, { zoom: 2 });
  assert.equal(point.zoom, 2);
  assert.deepEqual(visibleArea(point, canvas), { x: 50 - 200, y: 60 - 150, width: 400, height: 300 });
});

test('follow: the lead follows from the start, the panel and the candidate do not', () => {
  assert.equal(initialFollow('lead'), 'following');
  assert.equal(initialFollow('panel'), 'off');
  assert.equal(initialFollow('candidate'), 'off');
});

test('follow: own input pauses following, the control resumes it, and stops it', () => {
  let m: FollowMode = 'following';
  m = followStep(m, 'own-input');
  assert.equal(m, 'paused');
  assert.equal(followStep(m, 'own-input'), 'paused');
  m = followStep(m, 'toggle');
  assert.equal(m, 'following');
  assert.equal(followStep(m, 'toggle'), 'off');
  assert.equal(followStep('off', 'own-input'), 'off');
  assert.equal(followStep('off', 'toggle'), 'following');
});

test('follow: the canvas follows the candidate only while following and while the candidate is on the board', () => {
  const candidate = { clientId: '7', userId: 'guest-1', displayName: 'Candidate' };
  assert.equal(followTarget('following', candidate), 'guest-1');
  assert.equal(followTarget('following', { ...candidate, userId: undefined }), '7');
  assert.equal(followTarget('paused', candidate), null);
  assert.equal(followTarget('off', candidate), null);
  assert.equal(followTarget('following', null), null);
});

test('follow: the control names the candidate and says the state', () => {
  assert.equal(followLabel('following', 'Mateo Rossi'), 'Following Mateo');
  assert.equal(followLabel('paused', 'Mateo Rossi'), 'Follow Mateo');
  assert.equal(followLabel('off', ''), 'Follow the candidate');
});

test('own input: a trusted press, wheel or key inside the canvas; never a pointer move, a synthetic event, or one outside', () => {
  const inside = { closest: (q: string) => (q === '[data-board="b"]' ? {} : null) };
  const outside = { closest: () => null };
  assert.equal(isOwnBoardInput({ type: 'pointerdown', isTrusted: true, target: inside }, '[data-board="b"]'), true);
  assert.equal(isOwnBoardInput({ type: 'wheel', isTrusted: true, target: inside }, '[data-board="b"]'), true);
  assert.equal(isOwnBoardInput({ type: 'keydown', isTrusted: true, target: inside }, '[data-board="b"]'), true);
  assert.equal(isOwnBoardInput({ type: 'pointermove', isTrusted: true, target: inside }, '[data-board="b"]'), false);
  assert.equal(isOwnBoardInput({ type: 'keydown', isTrusted: false, target: inside }, '[data-board="b"]'), false);
  assert.equal(isOwnBoardInput({ type: 'pointerdown', isTrusted: true, target: outside }, '[data-board="b"]'), false);
});

test('boardPeers: the other people on the board from awareness, by the diagram record, the candidate by caret name', () => {
  const states = new Map<number, unknown>([
    [1, { diagram: { user: { userId: 'lead-1', displayName: 'Dana' } } }],
    [7, { diagram: { user: { userId: 'guest-1', displayName: 'Candidate' }, viewport: { scrollX: 1, scrollY: 2, zoom: 1 } }, [BOARD_CANVAS_KEY]: { width: 900, height: 500 } }],
    [9, { other: true }],
  ]);
  const peers = boardPeers(states, 1);
  assert.deepEqual(peers.map((p) => p.clientId), ['7']);
  assert.equal(peers[0]!.userId, 'guest-1');
  assert.deepEqual(peers[0]!.canvas, { width: 900, height: 500 });
  assert.deepEqual(peers[0]!.viewport, { scrollX: 1, scrollY: 2, zoom: 1 });
});

test('canvasSizeTicker: publishes the canvas size at most every interval, the latest size last, and only a change', () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: Array<{ width: number; height: number }> = [];
  const tick = canvasSizeTicker((s) => sent.push(s), 100, { now: () => now, setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; }, clearTimer: () => {} });
  tick({ width: 800, height: 600 });
  assert.equal(sent.length, 1);
  now = 20; tick({ width: 810, height: 600 });
  now = 40; tick({ width: 820, height: 600 });
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1);
  now = 100; timers[0]!.fn();
  assert.deepEqual(sent.at(-1), { width: 820, height: 600 });
  now = 300; tick({ width: 820, height: 600 });
  assert.equal(sent.length, 2);
  now = 500; tick({ width: 700, height: 600 });
  assert.equal(sent.length, 3);
});

test('the "added to the board" notice clears itself after a few seconds', () => {
  assert.ok(BOARD_NOTICE_MS >= 3000 && BOARD_NOTICE_MS <= 8000);
});
