// Starting boards for system design rounds (WHITEBOARD-PLAN step 2): Excalidraw elements built in code, so the seed,
// the tests and a later importer share one shape. Two boards ship with the seeded backend kit:
//
//   Blueprint     seven labelled frames (Clarifying questions first, then Requirements, Non-functional requirements,
//                 API, High-level design, Data model, Trade-offs), each with a few starter stickies to talk through.
//   Prompt only   one prompt card above the same seven frames, empty; or above another list of frames, such as
//                 INTERVIEW_SECTIONS' five (Clarifying questions, Functional, Non-functional, High-level design, Deep dive).
//
// The elements carry every field Excalidraw 0.18 reads, a fractional `index` in order, and stickies as a rectangle with
// its bound text, so the canvas draws them without repairing anything.
import type { KitBoard } from '../types.js';

type El = Record<string, unknown>;
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The n-th fractional index in order: a0..az, then b00..bzz. */
export function boardIndex(n: number): string {
  return n < 62 ? `a${DIGITS[n]}` : `b${DIGITS[Math.floor(n / 62) % 62]}${DIGITS[n % 62]}`;
}

/** A stable small number from a string (the element's seed and nonce, so a rebuilt board is identical). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2_000_000_000;
}

function base(id: string, type: string, x: number, y: number, width: number, height: number, extra: El = {}): El {
  return {
    id, type, x, y, width, height, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: hash(id), version: 1,
    versionNonce: hash(`${id}:nonce`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
  };
}

const FONT = 16;
const LINE = 1.25;
/** Break text at spaces so each line holds about `chars` characters. */
function wrap(text: string, chars: number): string {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > chars) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

/** A rectangle with centred text bound to it (a sticky, or the prompt card). */
function card(id: string, x: number, y: number, width: number, height: number, text: string, opts: { fill: string; frameId?: string | null; fontSize?: number }): El[] {
  const fontSize = opts.fontSize ?? FONT;
  const wrapped = wrap(text, Math.max(8, Math.floor((width - 20) / (fontSize * 0.55))));
  const lines = wrapped.split('\n');
  const tw = Math.min(width - 10, Math.max(...lines.map((l) => l.length)) * fontSize * 0.55);
  const th = lines.length * fontSize * LINE;
  const textId = `${id}-text`;
  const frameId = opts.frameId ?? null;
  return [
    base(id, 'rectangle', x, y, width, height, { backgroundColor: opts.fill, strokeWidth: 1, roundness: { type: 3 }, frameId, boundElements: [{ type: 'text', id: textId }] }),
    base(textId, 'text', x + (width - tw) / 2, y + (height - th) / 2, tw, th, {
      frameId, text: wrapped, originalText: text, fontSize, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: id, autoResize: true, lineHeight: LINE,
    }),
  ];
}

/** The seven sections a system design answer walks through, clarifying questions first, with the stickies the Blueprint starts each one with. */
export const DESIGN_SECTIONS: ReadonlyArray<{ id: string; name: string; stickies: readonly string[] }> = [
  { id: 'clarify', name: 'Clarifying questions', stickies: ['Who uses it, and for what?', 'How big: users, requests, data', 'Read/write mix, latency, consistency'] },
  { id: 'requirements', name: 'Requirements', stickies: ['Who are the users?', 'The core flows: write and read', 'What is out of scope?'] },
  { id: 'nfr', name: 'Non-functional requirements', stickies: ['Scale: reads and writes per second', 'Latency target (p99)', 'Availability and durability'] },
  { id: 'api', name: 'API', stickies: ['The main endpoints', 'Request and response shapes', 'Idempotency and errors'] },
  { id: 'hld', name: 'High-level design', stickies: ['Clients, API and services', 'Where the state lives', 'Caches and queues'] },
  { id: 'data', name: 'Data model', stickies: ['Entities and keys', 'Access patterns', 'Partitioning'] },
  { id: 'tradeoffs', name: 'Trade-offs', stickies: ['What did you give up?', 'Failure modes', 'What it costs to run'] },
];

/** The five frames of a classic system design interview, empty: what the "Design Twitter" question opens on. */
export const INTERVIEW_SECTIONS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'clarify', name: 'Clarifying questions' },
  { id: 'functional', name: 'Functional' },
  { id: 'nonfunctional', name: 'Non-functional' },
  { id: 'hld', name: 'High-level design' },
  { id: 'deepdive', name: 'Deep dive' },
];

const FRAME_W = 440;
const FRAME_H = 300;
const GAP = 60;
const STICKY_W = 190;
/** Frames per row: three, so a narrow room pane fits the board at a readable zoom (the seventh sits alone below). */
const COLUMNS = 3;
const STICKY_H = 90;
const STICKY_FILL = '#ffec99';
const NOTE_FILL = '#b2f2bb';

/** The frames in rows of COLUMNS starting at `top`, with each section's stickies when `stickies` is set. */
function sections(prefix: string, top: number, stickies: boolean, list: ReadonlyArray<{ id: string; name: string; stickies?: readonly string[] }> = DESIGN_SECTIONS): El[] {
  const out: El[] = [];
  list.forEach((s, i) => {
    const fx = (i % COLUMNS) * (FRAME_W + GAP);
    const fy = top + Math.floor(i / COLUMNS) * (FRAME_H + GAP);
    const frameId = `${prefix}-${s.id}`;
    if (stickies && s.stickies) {
      s.stickies.forEach((text, j) => {
        out.push(...card(`${frameId}-s${j + 1}`, fx + 20 + (j % 2) * (STICKY_W + 20), fy + 30 + Math.floor(j / 2) * (STICKY_H + 20), STICKY_W, STICKY_H, text, { fill: STICKY_FILL, frameId }));
      });
    }
    // The frame after its children: Excalidraw draws a frame's name above it and clips its children to it.
    out.push(base(frameId, 'frame', fx, fy, FRAME_W, FRAME_H, { name: s.name, strokeWidth: 1, roughness: 0 }));
  });
  return out;
}

const indexed = (els: El[]): El[] => els.map((e, n) => ({ ...e, index: boardIndex(n) }));

/**
 * A board with a person's stickies added: each into the free fourth place of a section's frame (`frame` is the
 * section's id, as DESIGN_SECTIONS names it), green like a note the candidate wrote. For the mock world's checkpoints.
 */
export function withNotes(board: KitBoard, notes: ReadonlyArray<{ frame: string; text: string }>): KitBoard {
  const frames = new Map(board.elements.filter((e) => e['type'] === 'frame').map((e) => [String(e['id']), e]));
  const added: El[] = [];
  for (const n of notes) {
    const frame = [...frames.entries()].find(([id]) => id.endsWith(`-${n.frame}`))?.[1];
    if (!frame) continue;
    const id = `${String(frame['id'])}-note`;
    added.push(...card(id, Number(frame['x']) + 20 + STICKY_W + 20, Number(frame['y']) + 30 + STICKY_H + 20, STICKY_W, STICKY_H, n.text, { fill: NOTE_FILL, frameId: String(frame['id']) }));
  }
  const n0 = board.elements.length;
  return { name: board.name, elements: [...board.elements, ...added.map((e, i) => ({ ...e, index: boardIndex(n0 + i) }))] };
}

/** "Blueprint": the seven frames, each with its starter stickies. */
export function blueprintBoard(): KitBoard {
  return { name: 'Blueprint', elements: indexed(sections('bp', 0, true)) };
}

/** "Prompt only": one prompt card above empty frames, the Blueprint's seven unless another list is given. */
export function promptBoard(prompt: string, frames: ReadonlyArray<{ id: string; name: string }> = DESIGN_SECTIONS): KitBoard {
  const width = COLUMNS * FRAME_W + (COLUMNS - 1) * GAP;
  return { name: 'Prompt only', elements: indexed([...card('po-prompt', 0, 0, width, 100, prompt, { fill: '#a5d8ff', fontSize: 24 }), ...sections('po', 160, false, frames)]) };
}
