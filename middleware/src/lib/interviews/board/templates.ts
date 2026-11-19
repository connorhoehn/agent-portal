// Starting boards for system design rounds (WHITEBOARD-PLAN step 2): Excalidraw elements built in code, so the seed,
// the tests and a later importer share one shape. Three boards ship with the seeded backend kit:
//
//   Blueprint         seven labelled frames (Clarifying questions first, then Requirements, Non-functional requirements,
//                     API, High-level design, Data model, Trade-offs), each with a few starter stickies to talk through.
//   Prompt only       one prompt card above the same seven frames, empty; or above another list of frames, such as
//                     INTERVIEW_SECTIONS' five (Clarifying questions, Functional, Non-functional, High-level design, Deep dive).
//   Architecture kit  the prompt card, a Notes column, a palette of ready-made components (one group each) and an
//                     empty Design frame to build the diagram in (architectureBoard, below).
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

export function base(id: string, type: string, x: number, y: number, width: number, height: number, extra: El = {}): El {
  return {
    id, type, x, y, width, height, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: hash(id), version: 1,
    versionNonce: hash(`${id}:nonce`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
  };
}

const FONT = 16;
const LINE = 1.25;
/** Break text at spaces so each line holds about `chars` characters. */
export function wrap(text: string, chars: number): string {
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

export const indexed = (els: El[]): El[] => els.map((e, n) => ({ ...e, index: boardIndex(n) }));

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

/** "Frames with starter notes" (the Blueprint): the seven frames, each with its starter stickies. */
export function blueprintBoard(): KitBoard {
  return { name: 'Frames with starter notes', elements: indexed(sections('bp', 0, true)) };
}

/** "Prompt and empty frames" (Prompt only): one prompt card above empty frames, the Blueprint's seven unless another list is given. */
export function promptBoard(prompt: string, frames: ReadonlyArray<{ id: string; name: string }> = DESIGN_SECTIONS): KitBoard {
  const width = COLUMNS * FRAME_W + (COLUMNS - 1) * GAP;
  return { name: 'Prompt and empty frames', elements: indexed([...card('po-prompt', 0, 0, width, 100, prompt, { fill: '#a5d8ff', fontSize: 24 }), ...sections('po', 160, false, frames)]) };
}

// ── "Architecture kit": notes on the left, a palette of ready-made components, an empty Design frame ─────────────────
//
// The way a system design round is often run on a whiteboard: the candidate keeps short notes in a column (what each
// component is and why), and builds the diagram beside them from recognisable shapes joined by labelled arrows. The
// palette holds one copy of each shape; each is a single group (the shape's strokes plus its label), so a click selects
// the whole component and Alt-drag or Cmd/Ctrl+D copies it. Every shape is drawn here from the board's own primitives
// (rectangle, ellipse, diamond, line, arrow, text), so the kit's and the checkpoints' checks keep it as it is.

/** The one fill of every component, so the diagram reads as one set. */
export const COMPONENT_FILL = '#ffd43b';
export const HINT_COLOR = '#868e96';
/** A component's icon is drawn in a box of this size; its label sits below. */
export const ICON_W = 100;
export const ICON_H = 64;
/** A label's size: Excalidraw's own default, so a label typed later matches. */
const LABEL_FONT = 20;

type ShapePart = { type: 'rectangle' | 'ellipse' | 'diamond'; x: number; y: number; w: number; h: number; fill?: boolean; stroke?: boolean; round?: boolean };
type LinePart = { type: 'line' | 'arrow'; x: number; y: number; to: Array<[number, number]>; label?: string };
type Part = ShapePart | LinePart;

/** A free text element (no container), `color` its stroke. */
export function freeText(id: string, x: number, y: number, text: string, opts: { fontSize?: number; color?: string; align?: 'left' | 'center'; width?: number; frameId?: string | null; fontFamily?: number } = {}): El {
  const fontSize = opts.fontSize ?? FONT;
  const lines = text.split('\n');
  const width = opts.width ?? Math.max(...lines.map((l) => l.length)) * fontSize * 0.55;
  return base(id, 'text', x, y, width, lines.length * fontSize * LINE, {
    strokeColor: opts.color ?? '#1e1e1e', frameId: opts.frameId ?? null, text, originalText: text, fontSize, fontFamily: opts.fontFamily ?? 2,
    textAlign: opts.align ?? 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: LINE,
  });
}

/** One part of an icon as elements at (ox, oy), the icon box's top-left corner: the shape, and an arrow's bound label. */
function partElements(id: string, p: Part, ox: number, oy: number, dashed: boolean): El[] {
  const look = { strokeStyle: dashed ? 'dashed' : 'solid' };
  if ('to' in p) {
    const points: Array<[number, number]> = [[0, 0], ...p.to];
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const el = base(id, p.type, ox + p.x, oy + p.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      ...look, points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null,
      endArrowhead: p.type === 'arrow' ? 'arrow' : null, roundness: p.type === 'arrow' ? { type: 2 } : null,
      ...(p.type === 'arrow' ? { elbowed: false } : {}),
    });
    if (!p.label) return [el];
    // Excalidraw's own arrow label: a text bound to the arrow (containerId), drawn at its middle.
    const textId = `${id}-label`;
    const end = points[points.length - 1]!;
    const w = p.label.length * LABEL_FONT * 0.55;
    el['boundElements'] = [{ type: 'text', id: textId }];
    return [el, base(textId, 'text', ox + p.x + end[0] / 2 - w / 2, oy + p.y + end[1] / 2 - (LABEL_FONT * LINE) / 2, w, LABEL_FONT * LINE, {
      text: p.label, originalText: p.label, fontSize: LABEL_FONT, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: id, autoResize: true, lineHeight: LINE,
    })];
  }
  return [base(id, p.type, ox + p.x, oy + p.y, p.w, p.h, {
    ...look, backgroundColor: p.fill === false ? 'transparent' : COMPONENT_FILL, strokeColor: p.stroke === false ? 'transparent' : '#1e1e1e',
    roundness: p.round ? { type: 3 } : p.type === 'rectangle' ? null : { type: 2 },
  })];
}

/** A server: a rounded slab with a drive slot. */
const server = (x: number, y: number, w: number, h: number): Part[] => [
  { type: 'rectangle', x, y, w, h, round: true },
  { type: 'line', x: x + 10, y: y + h / 2, to: [[w * 0.35, 0]] },
];

/** A cylinder standing up (a database): the body without a stroke, its two sides as lines, then the lid. */
const cylinder = (): Part[] => [
  { type: 'ellipse', x: 26, y: 46, w: 48, h: 18 },
  { type: 'rectangle', x: 26, y: 9, w: 48, h: 46, stroke: false },
  { type: 'line', x: 26, y: 9, to: [[0, 46]] },
  { type: 'line', x: 74, y: 9, to: [[0, 46]] },
  { type: 'ellipse', x: 26, y: 0, w: 48, h: 18 },
];

/** A cloud: overlapping puffs, then the same puffs a little smaller without a stroke, so only the outline shows. */
const cloud = (): Part[] => {
  const puffs = [{ x: 4, y: 22, w: 46, h: 38 }, { x: 28, y: 4, w: 48, h: 46 }, { x: 56, y: 20, w: 40, h: 38 }, { x: 10, y: 34, w: 80, h: 30 }];
  return [
    ...puffs.map((p): Part => ({ type: 'ellipse', ...p })),
    ...puffs.map((p): Part => ({ type: 'ellipse', x: p.x + 3, y: p.y + 3, w: p.w - 6, h: p.h - 6, stroke: false })),
  ];
};

/**
 * The components the Architecture kit's palette offers, in its order: each a label and the parts of its icon, drawn in
 * a 100 × 64 box. A question picks any of them by id (architectureBoard's `components`); a new one is one entry here.
 */
export const ARCHITECTURE_COMPONENTS: ReadonlyArray<{ id: string; label: string; parts: () => Part[]; dashed?: boolean }> = [
  { id: 'web', label: 'Web client', parts: () => [
    { type: 'rectangle', x: 0, y: 0, w: 100, h: 64, round: true },
    { type: 'line', x: 0, y: 16, to: [[100, 0]] },
    { type: 'ellipse', x: 8, y: 5, w: 6, h: 6, fill: false },
    { type: 'ellipse', x: 18, y: 5, w: 6, h: 6, fill: false },
  ] },
  { id: 'mobile', label: 'Mobile client', parts: () => [
    { type: 'rectangle', x: 32, y: 0, w: 36, h: 64, round: true },
    { type: 'line', x: 44, y: 7, to: [[12, 0]] },
    { type: 'line', x: 44, y: 56, to: [[12, 0]] },
  ] },
  { id: 'cdn', label: 'CDN', parts: cloud },
  { id: 'lb', label: 'Load balancer', parts: () => [
    { type: 'rectangle', x: 18, y: 0, w: 64, h: 64, round: true },
    { type: 'line', x: 28, y: 32, to: [[18, 0]] },
    { type: 'arrow', x: 46, y: 32, to: [[24, -18]] },
    { type: 'arrow', x: 46, y: 32, to: [[26, 0]] },
    { type: 'arrow', x: 46, y: 32, to: [[24, 18]] },
  ] },
  { id: 'app', label: 'App servers', parts: () => [...server(5, 0, 90, 18), ...server(5, 23, 90, 18), ...server(5, 46, 90, 18)] },
  { id: 'auth', label: 'Auth', parts: () => [
    ...server(0, 8, 68, 22), ...server(0, 36, 68, 22),
    { type: 'ellipse', x: 78, y: 12, w: 18, h: 24, fill: false },
    { type: 'rectangle', x: 74, y: 26, w: 26, h: 22, round: true },
  ] },
  { id: 'cache', label: 'Cache', parts: () => [
    { type: 'diamond', x: 5, y: 30, w: 90, h: 34 },
    { type: 'diamond', x: 5, y: 15, w: 90, h: 34 },
    { type: 'diamond', x: 5, y: 0, w: 90, h: 34 },
  ] },
  { id: 'queue', label: 'Message queue', parts: () => [
    { type: 'ellipse', x: 2, y: 12, w: 20, h: 40 },
    { type: 'rectangle', x: 12, y: 12, w: 74, h: 40, stroke: false },
    { type: 'line', x: 12, y: 12, to: [[74, 0]] },
    { type: 'line', x: 12, y: 52, to: [[74, 0]] },
    { type: 'ellipse', x: 76, y: 12, w: 20, h: 40 },
  ] },
  { id: 'workers', label: 'Workers', parts: () => [
    { type: 'rectangle', x: 30, y: 18, w: 62, h: 46, round: true },
    { type: 'rectangle', x: 20, y: 9, w: 62, h: 46, round: true },
    { type: 'rectangle', x: 10, y: 0, w: 62, h: 46, round: true },
  ] },
  { id: 'db-primary', label: 'Database (primary)', parts: cylinder },
  { id: 'db-replica', label: 'Database (replica)', parts: cylinder, dashed: true },
  { id: 'arrow', label: 'Arrow', parts: () => [{ type: 'arrow', x: 0, y: 32, to: [[100, 0]], label: 'reads' }] },
];

/** One component at (x, y): its icon's elements and its label below, all in one group (`<prefix>-g-<id>`), in `frameId`. */
export function architectureComponent(prefix: string, id: string, x: number, y: number, frameId: string | null = null): El[] {
  const c = ARCHITECTURE_COMPONENTS.find((k) => k.id === id);
  if (!c) return [];
  const group = `${prefix}-g-${c.id}`;
  const els = c.parts().flatMap((p, i) => partElements(`${prefix}-${c.id}-${i + 1}`, p, x, y, Boolean(c.dashed)));
  const label = wrap(c.label, 13);
  const lw = Math.max(...label.split('\n').map((l) => l.length)) * LABEL_FONT * 0.55;
  els.push(freeText(`${prefix}-${c.id}-name`, x + (ICON_W - lw) / 2, y + ICON_H + 8, label, { fontSize: LABEL_FONT, align: 'center', width: lw }));
  return els.map((e) => ({ ...e, groupIds: [group], frameId }));
}

/** The Notes column's headed placeholders, in the order the answer is given. */
export const NOTE_HEADINGS: ReadonlyArray<{ id: string; name: string; hint: string }> = [
  { id: 'clarify', name: 'Clarifying questions', hint: 'Who uses it, how many, and how much they read versus write.' },
  { id: 'functional', name: 'Functional', hint: 'The few things it must do.' },
  { id: 'nonfunctional', name: 'Non-functional', hint: 'Scale, latency, availability, consistency.' },
  { id: 'components', name: 'Components', hint: 'One line each: what it is, and why it is there.' },
  { id: 'deepdive', name: 'Deep dive', hint: 'The hardest part, the options, and the trade-off chosen.' },
];

// Sized so a room pane fits the whole board at about half scale and the text still reads: 1280 × 960 in scene units,
// labels at 20, the Notes headings at 24.
const KIT_W = 1280;
const KIT_TOP = 120;
const KIT_H = 840;
const NOTES_W = 340;
const RIGHT_X = NOTES_W + 40;
const RIGHT_W = KIT_W - RIGHT_X;
const CELL_W = 150;
const CELL_H = 140;
const PALETTE_COLUMNS = 6;
const HINT_FONT = 18;
export const ARCHITECTURE_HINT = 'Click selects a whole component; Alt-drag or Cmd/Ctrl+D copies it into Design.\nDouble-click an arrow to label it: reads, writes.';

/**
 * "Architecture kit": the prompt card across the top; on the left a Notes frame of headed placeholders; on the right a
 * Components frame with the palette (all of ARCHITECTURE_COMPONENTS unless `components` names some) and a short hint
 * on copying, and under it a large empty Design frame where the diagram is built.
 */
export function architectureBoard(prompt: string, opts: { components?: readonly string[] } = {}): KitBoard {
  const out: El[] = [...card('ak-prompt', 0, 0, KIT_W, 80, prompt, { fill: 'transparent', fontSize: 32 })];
  NOTE_HEADINGS.forEach((h, i) => {
    const y = KIT_TOP + 24 + i * 168;
    out.push(freeText(`ak-notes-${h.id}`, 20, y, h.name, { fontSize: 24, frameId: 'ak-notes' }));
    out.push(freeText(`ak-notes-${h.id}-hint`, 20, y + 38, wrap(h.hint, 30), { fontSize: HINT_FONT, color: HINT_COLOR, frameId: 'ak-notes' }));
  });
  out.push(base('ak-notes', 'frame', 0, KIT_TOP, NOTES_W, KIT_H, { name: 'Notes', strokeWidth: 1, roughness: 0 }));
  const ids = (opts.components ?? ARCHITECTURE_COMPONENTS.map((c) => c.id)).filter((id) => ARCHITECTURE_COMPONENTS.some((c) => c.id === id));
  ids.forEach((id, i) => {
    const x = RIGHT_X + (i % PALETTE_COLUMNS) * CELL_W + (CELL_W - ICON_W) / 2;
    const y = KIT_TOP + 24 + Math.floor(i / PALETTE_COLUMNS) * CELL_H;
    out.push(...architectureComponent('ak', id, x, y, 'ak-palette'));
  });
  // The hint inside the palette's frame, under its last row: the gap below holds only the Design frame's name.
  const hintY = KIT_TOP + 24 + Math.max(1, Math.ceil(ids.length / PALETTE_COLUMNS)) * CELL_H;
  out.push(freeText('ak-hint', RIGHT_X + 16, hintY, ARCHITECTURE_HINT, { fontSize: HINT_FONT, color: HINT_COLOR, frameId: 'ak-palette' }));
  const paletteH = hintY + 2 * HINT_FONT * LINE + 16 - KIT_TOP;
  out.push(base('ak-palette', 'frame', RIGHT_X, KIT_TOP, RIGHT_W, paletteH, { name: 'Components', strokeWidth: 1, roughness: 0 }));
  const designY = KIT_TOP + paletteH + 60;
  out.push(base('ak-design', 'frame', RIGHT_X, designY, RIGHT_W, KIT_TOP + KIT_H - designY, { name: 'Design', strokeWidth: 1, roughness: 0 }));
  return { name: 'Architecture kit', elements: indexed(out) };
}
