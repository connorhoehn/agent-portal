// The whiteboard's helpers (lib/interviewsBoard.ts; WHITEBOARD-PLAN steps 1 and 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as YT from 'yjs';
import { BOARD_DOCUMENT_PREFIX, BOARD_TEMPLATE_NAMES, boardCheckpoints, boardTitleOf, readBoardTemplate, boardChannel, boardDocumentId, fitBoardView, flushBoardWithin, openingRegion, openingView, sceneBounds, OPENING_MIN_ZOOM, watchBoardFit, type BoardCheckpoints, insertBoard, readBoardElements, sceneKey, surfaceOf } from '../interviewsBoard.ts';
import { roomTabs } from '../interviewsRoom.ts';
import * as server from '../../../../middleware/src/lib/interviews/board/channel.ts';
import { architectureBoard, blueprintBoard, masterBoard, masterTemplateFor, promptBoard, providedDesignBoard } from '../../../../middleware/src/lib/interviews/board/templates.ts';
import { TWITTER_DESIGN, TWITTER_PROMPT } from '../../../../middleware/src/mock/interviews-design-twitter.ts';

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
  assert.equal(frames.length, 14);
  assert.ok(frames.includes('Clarifying questions'));
  assert.ok(frames.includes('Non-functional requirements'));
});

test('"Design Twitter" goes in as the Architecture kit: Notes, the palette of grouped components, an empty Design frame', () => {
  const doc = new Y.Doc();
  const twitter = architectureBoard('Design Twitter');
  assert.equal(insertBoard(doc, twitter), twitter.elements.length);
  const els = readBoardElements(doc);
  assert.deepEqual(els.filter((e) => e.type === 'frame').map((e) => e['name']), ['Notes', 'Components', 'Design']);
  assert.ok(els.some((e) => e.type === 'text' && e['originalText'] === 'Design Twitter'));
  // The binding keeps each component's group: one group per palette component, as built.
  const groups = new Set(els.filter((e) => e['frameId'] === 'ak-palette').flatMap((e) => e.groupIds ?? []));
  assert.equal(groups.size, 12);
});

test('"Design Twitter" in the master template goes in whole, and its provided design adds beside it on a reveal (no id shared)', () => {
  const doc = new Y.Doc();
  const board = masterBoard(TWITTER_PROMPT, { palette: true });
  assert.equal(insertBoard(doc, board), board.elements.length);
  const provided = providedDesignBoard(TWITTER_DESIGN);
  assert.equal(insertBoard(doc, provided), provided.elements.length);
  assert.equal(readBoardElements(doc).length, board.elements.length + provided.elements.length);
});

test('the kit editor offers the four templates, built around the question\'s title', async () => {
  assert.deepEqual([...BOARD_TEMPLATE_NAMES], [blueprintBoard().name, promptBoard('x').name, architectureBoard('x').name, masterTemplateFor('x').name]);
  assert.equal(boardTitleOf('Design Twitter: people post short messages.'), 'Design Twitter');
  assert.equal(boardTitleOf('Design a URL shortener for 100M links a month. Then scale it.'), 'Design a URL shortener for 100M links a month');
  assert.equal(boardTitleOf('  '), 'The prompt');
  let asked = '';
  const fetcher = (async (url: string) => { asked = url; return new Response(JSON.stringify({ items: [blueprintBoard(), architectureBoard('Design Twitter')] })); }) as unknown as typeof fetch;
  assert.equal((await readBoardTemplate('Architecture kit', 'Design Twitter', fetcher))!.name, 'Architecture kit');
  assert.match(asked, /\/board-templates\?title=Design%20Twitter$/);
  assert.equal(await readBoardTemplate('Nope', 'x', fetcher), null);
  assert.equal(await readBoardTemplate('Blueprint', 'x', (async () => new Response('', { status: 403 })) as unknown as typeof fetch), null);
});

test('a second document, fed the first one\'s update, holds the same board (what the other seat sees)', () => {
  const lead = new Y.Doc();
  const candidate = new Y.Doc();
  lead.on('update', (u: Uint8Array) => Y.applyUpdate(candidate, u));
  insertBoard(lead, blueprintBoard());
  assert.equal(sceneKey(readBoardElements(candidate)), sceneKey(readBoardElements(lead)));
});

test('fitting a board sends Excalidraw its own "Zoom to fit" (Shift+1) with its toolbars out of the way for that keystroke only; nothing to fit without a canvas', () => {
  const g = globalThis as { KeyboardEvent?: unknown };
  const had = g.KeyboardEvent;
  class Fake extends Event { code: string; shiftKey: boolean; constructor(type: string, init: Record<string, unknown>) { super(type, init); this.code = String(init['code'] ?? ''); this.shiftKey = Boolean(init['shiftKey']); } }
  g.KeyboardEvent = Fake;
  try {
    const classes = new Set(['App-toolbar']);
    const bottom = new Set(['App-toolbar']);
    const toolbar = { classList: { remove: (c: string) => classes.delete(c), add: (c: string) => classes.add(c) } };
    const footer = { classList: { remove: (c: string) => bottom.delete(c), add: (c: string) => bottom.add(c) } };
    const sent: Array<{ type: string; code: string; shiftKey: boolean; bubbles: boolean; toolbarFound: boolean }> = [];
    const container = {
      querySelectorAll: (q: string) => (q === '.App-toolbar' ? [toolbar, footer] : []),
      dispatchEvent: (e: Fake) => { sent.push({ type: e.type, code: e.code, shiftKey: e.shiftKey, bubbles: e.bubbles, toolbarFound: classes.has('App-toolbar') || bottom.has('App-toolbar') }); return true; },
    };
    const root = { querySelector: (q: string) => (q === '.excalidraw' ? container : null) } as unknown as ParentNode;
    assert.equal(fitBoardView(root), true);
    assert.deepEqual(sent, [{ type: 'keydown', code: 'Digit1', shiftKey: true, bubbles: true, toolbarFound: false }]);
    assert.ok(classes.has('App-toolbar') && bottom.has('App-toolbar'), 'both toolbars have their class back');
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

test('the kit editor writes a starting board only when its scene moved: same ids and versions read as the same board', async () => {
  const { boardSceneKey } = await import('../interviewsBoard.ts');
  const a = [{ id: 'f', type: 'frame', version: 2 }, { id: 's', type: 'rectangle', version: 1 }];
  assert.equal(boardSceneKey(a), boardSceneKey([...a].reverse()), 'order does not matter');
  assert.notEqual(boardSceneKey(a), boardSceneKey([{ ...a[0]!, version: 3 }, a[1]!]), 'a moved shape does');
  assert.equal(boardSceneKey([...a, { id: 'x', type: 'text', version: 4, isDeleted: true }]), boardSceneKey(a), 'a deleted shape is not on the board');
  // A board read back off the canvas (the binding's elements) keys the same as the kit's stored copy.
  const ydoc = new Y.Doc();
  insertBoard(ydoc, blueprintBoard());
  const read = readBoardElements(ydoc) as unknown as Array<Record<string, unknown>>;
  assert.equal(boardSceneKey(read), boardSceneKey(read.map((e) => ({ ...e }))));
});

test('a checkpoint counts as posted only once the server took it: a failed post is tried again on the next flush; one post at a time', async () => {
  let board: Array<Record<string, unknown>> = [{ id: 'a', type: 'rectangle', version: 1 }];
  const posts: string[] = [];
  let ok = false;
  let gate: Promise<void> | null = null;
  const checkpoints = boardCheckpoints(() => board as never, async (elements) => {
    posts.push(sceneKey(elements));
    if (gate) await gate;
    return ok;
  });
  assert.equal(await checkpoints.flush(), false, 'the server did not take it');
  ok = true;
  assert.equal(await checkpoints.flush(), true, 'the same board is posted again on the next flush');
  assert.equal(await checkpoints.flush(), true, 'and then not again');
  assert.deepEqual(posts, ['a:1', 'a:1']);
  board = [];
  assert.equal(await checkpoints.flush(), true, 'an empty board is nothing to post');
  assert.equal(posts.length, 2);
  // Two flushes at once (a tick and the end): the second waits for the first, and posts only if the board moved since.
  board = [{ id: 'a', type: 'rectangle', version: 2 }];
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const first = checkpoints.flush();
  const second = checkpoints.flush();
  gate = null;
  open();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(posts, ['a:1', 'a:1', 'a:2']);
});

test('ending the round waits for the board\'s closing checkpoint, but never longer than the bound', async () => {
  const steps: string[] = [];
  const quick: BoardCheckpoints = { flush: async () => { steps.push('flushed'); return true; } };
  assert.equal(await flushBoardWithin(quick, 1000), true);
  steps.push('ended');
  assert.deepEqual(steps, ['flushed', 'ended']);
  const hung: BoardCheckpoints = { flush: () => new Promise<boolean>(() => {}) };
  const started = Date.now();
  assert.equal(await flushBoardWithin(hung, 30), false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await flushBoardWithin(null, 30), true, 'no board open: nothing to wait for');
});

test('the board fits itself until the person touches it, wherever the board\'s wrapper is drawn later; nothing outside it counts', () => {
  const doc = new Y.Doc();
  insertBoard(doc, blueprintBoard());
  const listeners = new Map<string, (e: { isTrusted: boolean; target: unknown }) => void>();
  const page = {
    addEventListener: (type: string, fn: (e: { isTrusted: boolean; target: unknown }) => void) => { listeners.set(type, fn); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  const timers: Array<() => void> = [];
  let fits = 0;
  const stop = watchBoardFit(doc, '[data-board="b"]', {
    page, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, fit: () => { fits += 1; },
  });
  const inBoard = { closest: (q: string) => (q === '[data-board="b"]' ? {} : null) };
  const elsewhere = { closest: () => null };
  timers.shift()!();
  assert.equal(fits, 1, 'fits while untouched');
  listeners.get('pointerdown')!({ isTrusted: true, target: elsewhere });
  listeners.get('wheel')!({ isTrusted: false, target: inBoard });
  timers.shift()!();
  assert.equal(fits, 2, 'a press elsewhere, or a synthetic wheel, hands nothing over');
  // The wrapper was drawn after the hook started (the canvas loads lazily): the press still reaches the page's listener.
  listeners.get('wheel')!({ isTrusted: true, target: inBoard });
  for (const t of timers.splice(0)) t();
  assert.equal(fits, 2, 'after the person moved the view, no fit');
  stop();
  assert.equal(listeners.size, 0, 'the listeners go with the board');
});

test('watchBoardFit: no fit while the canvas follows someone, and the fit comes back when it stops', () => {
  const doc = new Y.Doc();
  insertBoard(doc, blueprintBoard());
  const page = { addEventListener: () => {}, removeEventListener: () => {} };
  const timers: Array<() => void> = [];
  let fits = 0;
  let held = true;
  const stop = watchBoardFit(doc, '[data-board="b"]', {
    page, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, fit: () => { fits += 1; }, held: () => held,
  });
  timers.shift()!();
  assert.equal(fits, 0, 'following: the followed camera is the view');
  held = false;
  timers.shift()!();
  assert.equal(fits, 1);
  stop();
});

test('a master template board opens on its prompt at a readable zoom, not fitted whole; other boards fit as before', () => {
  const board = masterBoard(TWITTER_PROMPT, { palette: true }).elements;
  const all = sceneBounds(board)!;
  const prompt = openingRegion(board)!;
  assert.ok(prompt.x1 <= all.x1 + 1 && prompt.x2 < all.x2 / 2, 'the prompt is the board\'s left part');
  // A room pane about 900 px wide: zoom 1 (the prompt's 620 px column fits), the prompt's top-left 32 px in.
  const W = 900, H = 620;
  const v = openingView(board, { width: W, height: H })!;
  assert.equal(v.zoom, 1);
  assert.equal(v.zoomOutSteps, 0);
  const cx = (all.x1 + all.x2) / 2, cy = (all.y1 + all.y2) / 2;
  // After the fit and the reset the view's centre is the board's; the wheel moves its left edge to the prompt's.
  assert.equal(cx - W / 2 + v.deltaX / v.zoom, prompt.x1 - 32);
  assert.equal(cy - H / 2 + v.deltaY / v.zoom, prompt.y1 - 32);
  // A narrow pane zooms out in Excalidraw's 0.1 steps, never below the readable floor.
  const narrow = openingView(board, { width: 520, height: 600 })!;
  assert.equal(narrow.zoom, 0.7);
  assert.equal(narrow.zoomOutSteps, 3);
  assert.equal(openingView(board, { width: 200, height: 600 })!.zoom, OPENING_MIN_ZOOM);
  // A board without a prompt part (the record of another round, a provided design) keeps the whole-board fit.
  assert.equal(openingRegion(blueprintBoard().elements), null);
  assert.equal(openingView(blueprintBoard().elements, { width: W, height: H }), null);
  assert.equal(openingView([], { width: W, height: H }), null);
});
