// Starting boards for system design rounds (WHITEBOARD-PLAN step 2): Excalidraw elements built in code, so the seed,
// the tests and a later importer share one shape. Four boards (and the answer key's own board) are built here:
//
//   Blueprint         seven labelled frames (Clarifying questions first, then Requirements, Non-functional requirements,
//                     API, High-level design, Data model, Trade-offs), each with a few starter stickies to talk through.
//   Prompt only       one prompt card above the same seven frames, empty; or above another list of frames, such as
//                     INTERVIEW_SECTIONS' five (Clarifying questions, Functional, Non-functional, High-level design, Deep dive).
//   Architecture kit  the prompt card, a Notes column, a palette of ready-made components (one group each) and an
//                     empty Design frame to build the diagram in (architectureBoard, below).
//   Master template   the owner's format: the prompt with user stories, then "Your design" in five hinted sections
//                     (masterBoard, at the end), and the answer key's "Provided design" board (providedDesignBoard).
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

// ── "Master template" ─────────────────────────────────────────────────────────────
//
// "Master template": the owner's format for a system design round (docs/interviews-tenant-plan.md, "System design
// master template"). One round, three parts, left to right:
//
//   A  the prompt        the title, two or three short paragraphs, a note scoping something out, and
//                        "Requirements / User stories": "<Actor> can:" lists, then a "Maybe:" list of stretch stories.
//   B  Your design       under a "Your design" heading with a rule: High-level design (room for the diagram, the
//                        Architecture kit's palette as an optional strip), Purpose(s) of each service, API signatures,
//                        Data model and "Please answer the following questions", each with its small hint line.
//   C  Provided design   the interviewer's answer key: the reference diagram (services as boxes, stores as circles,
//                        labelled arrows), the services' purposes, the API signatures, the data model and the answers.
//
// A and B are the question's starting board (`masterBoard`). C is its own board (`providedDesignBoard`), stored in the
// kit question's `providedDesign` and never sent to the candidate until the lead reveals it (answer-key.ts); its ids all
// start `pd-`, so a reveal onto a board holding A and B adds every element. Plain text in Excalidraw's normal font (2,
// not the handwritten one), at four sizes, built from the same primitives as the other templates.

const TITLE = 56;
const HEADING = 32;
const BODY = 24;
const HINT = 20;
const CHAR = 0.55;
const NOTE_COLOR = '#c92a2a';
const ACTOR_COLOR = '#1971c2';
const A_W = 620;
const B_X = A_W + 80;
/** Part B: the diagram's frame on the left, the written sections in a column on its right (wider than tall, as a room pane is). */
const HLD_W = 1000;
const COL_W = 640;
const B_W = HLD_W + 60 + COL_W;
/** Part C's diagram frame. */
const C_W = 1400;
const PAD = 24;
const CELL_GAP = 60;
const HALF_W = (C_W - CELL_GAP) / 2;

const lineH = (size: number) => size * LINE;
const heightOf = (text: string, size: number) => text.split('\n').length * lineH(size);
const charsFor = (width: number, size: number) => Math.max(12, Math.floor(width / (size * CHAR)));

/** A bulleted list: each item wrapped to `chars`, its continuation lines indented under the text. */
function bullets(items: readonly string[], chars: number, mark = '•'): string {
  return items.map((t) => wrap(t, chars - 2).split('\n').map((l, i) => (i ? `  ${l}` : `${mark} ${l}`)).join('\n')).join('\n');
}

/** A numbered list, one blank line between items, each wrapped with its continuation lines indented. */
function numbered(items: readonly string[], chars: number): string {
  return items.map((t, i) => wrap(t, chars - 3).split('\n').map((l, j) => (j ? `   ${l}` : `${i + 1}. ${l}`)).join('\n')).join('\n\n');
}

/** A heading in the scene and a rule under it, `width` long. */
function headed(prefix: string, x: number, title: string, width: number): El[] {
  return [
    freeText(`${prefix}-heading`, x, 0, title, { fontSize: TITLE }),
    base(`${prefix}-rule`, 'line', x, 84, width, 0, { points: [[0, 0], [width, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: null, roundness: null, strokeColor: '#495057', roughness: 0 }),
  ];
}

/** A section's frame at (x, y) with its grey hint lines at the top; the elements and the y below the hints. */
function sectionFrame(prefix: string, id: string, name: string, hints: readonly string[], x: number, y: number, w: number, h: number): { els: El[]; frame: El; top: number } {
  const frameId = `${prefix}-${id}`;
  const els: El[] = [];
  let top = y + PAD;
  hints.forEach((hint, j) => {
    const t = wrap(hint, charsFor(w - 2 * PAD, HINT));
    els.push(freeText(`${frameId}-hint${j + 1}`, x + PAD, top, t, { fontSize: HINT, color: HINT_COLOR, frameId }));
    top += heightOf(t, HINT) + 6;
  });
  return { els, frame: base(frameId, 'frame', x, y, w, h, { name, strokeWidth: 1, roughness: 0 }), top: top + 10 };
}

// ── A and B: the starting board ──────────────────────────────────────────────

export interface MasterPromptSpec {
  /** "Design <X>". */
  title: string;
  /** Two or three short paragraphs: what the product is, who uses it, what the round is about. */
  intro: readonly string[];
  /** One line scoping something out, shown as "Note: ...". */
  note?: string;
  /** The must-have stories, by actor: "<actor> can:" and the list. */
  stories: ReadonlyArray<{ actor: string; can: readonly string[] }>;
  /** Stretch stories, under "Maybe:". */
  maybe?: readonly string[];
  /** The numbered questions under "Your design"; the last may be the enhancement that changes the diagram. */
  questions: ReadonlyArray<{ text: string; enhancement?: boolean }>;
}

/** Part B's sections in order, with the hint lines each opens with. */
export const MASTER_SECTIONS: ReadonlyArray<{ id: string; name: string; hints: readonly string[] }> = [
  { id: 'hld', name: 'High-level design', hints: ['Functional only: no need to scale it. Services as boxes, stores as circles, a label on every arrow.'] },
  { id: 'purposes', name: 'Purpose(s) of each service', hints: ['A line or two for each service: what it owns and what it does.', 'For example: FooService: creates, reads, updates and deletes Foos.'] },
  { id: 'api', name: 'API signatures', hints: ['Each call with its inputs and what it returns. Writing them on the diagram is optional.'] },
  { id: 'data', name: 'Data model', hints: ['Which kind of database would you use, and what would each one hold?', 'List the tables and their columns.'] },
  { id: 'questions', name: 'Please answer the following questions', hints: [] },
];

const PALETTE_HINT = 'Click selects a whole component; Alt-drag or Cmd/Ctrl+D copies it.';

/** "Master template": part A on the left, part B ("Your design") to its right; `palette` puts the Architecture kit's components inside High-level design. */
export function masterBoard(spec: MasterPromptSpec, opts: { palette?: boolean } = {}): KitBoard {
  const out: El[] = [];
  // A: the prompt, top to bottom.
  const chars = charsFor(A_W, BODY);
  let y = 0;
  const put = (id: string, text: string, size: number, gap: number, color?: string) => {
    out.push(freeText(`mt-a-${id}`, 0, y, text, { fontSize: size, ...(color ? { color } : {}) }));
    y += heightOf(text, size) + gap;
  };
  put('title', wrap(spec.title, charsFor(A_W, TITLE)), TITLE, 28);
  spec.intro.forEach((p, i) => put(`intro${i + 1}`, wrap(p, chars), BODY, 18));
  if (spec.note) put('note', wrap(`Note: ${spec.note}`, chars), BODY, 30, NOTE_COLOR);
  put('stories', 'Requirements / User stories', HEADING, 16);
  spec.stories.forEach((s, i) => {
    put(`actor${i + 1}`, `${s.actor} can:`, BODY, 6, ACTOR_COLOR);
    put(`actor${i + 1}-can`, bullets(s.can, chars), BODY, 18);
  });
  if (spec.maybe?.length) {
    put('maybe', 'Maybe:', BODY, 6, ACTOR_COLOR);
    put('maybe-list', bullets(spec.maybe, chars), BODY, 0);
  }

  // B: "Your design", a rule, then the sections.
  out.push(...headed('mt-b', B_X, 'Your design', B_W));
  const [hldS, purposesS, apiS, dataS, questionsS] = MASTER_SECTIONS as [typeof MASTER_SECTIONS[number], typeof MASTER_SECTIONS[number], typeof MASTER_SECTIONS[number], typeof MASTER_SECTIONS[number], typeof MASTER_SECTIONS[number]];
  const hldY = 130;
  const hld = sectionFrame('mt-b', hldS.id, hldS.name, hldS.hints, B_X, hldY, HLD_W, 0);
  out.push(...hld.els);
  if (opts.palette) {
    const ids = ARCHITECTURE_COMPONENTS.map((c) => c.id);
    ids.forEach((id, i) => {
      const x = B_X + PAD + (i % PALETTE_COLUMNS) * CELL_W + (CELL_W - ICON_W) / 2;
      out.push(...architectureComponent('mt', id, x, hld.top + Math.floor(i / PALETTE_COLUMNS) * CELL_H, 'mt-b-hld'));
    });
    const below = hld.top + Math.ceil(ids.length / PALETTE_COLUMNS) * CELL_H;
    out.push(freeText('mt-b-hld-palette-hint', B_X + PAD, below, PALETTE_HINT, { fontSize: HINT, color: HINT_COLOR, frameId: 'mt-b-hld' }));
  }
  out.push(hld.frame); // its height is set below, once the column beside it is laid out

  // The written sections in a column right of the diagram, each tall enough for its hints and room to write.
  const colX = B_X + HLD_W + 60;
  const qText = numbered(spec.questions.map((q) => (q.enhancement ? `Enhancement: ${q.text}` : q.text)), charsFor(COL_W - 2 * PAD, BODY));
  const room: Record<string, number> = { purposes: 180, api: 150, data: 170 };
  let cy = hldY;
  for (const s of [purposesS, apiS, dataS]) {
    const f = sectionFrame('mt-b', s.id, s.name, s.hints, colX, cy, COL_W, 0);
    f.frame['height'] = f.top - cy + (room[s.id] ?? 160);
    out.push(...f.els, f.frame);
    cy += Number(f.frame['height']) + 40;
  }
  const questions = sectionFrame('mt-b', questionsS.id, questionsS.name, questionsS.hints, colX, cy, COL_W, 0);
  questions.frame['height'] = questions.top - cy + heightOf(qText, BODY) + 60;
  out.push(freeText('mt-b-questions-list', colX + PAD, questions.top, qText, { fontSize: BODY, frameId: 'mt-b-questions' }), ...questions.els, questions.frame);
  // The diagram's frame runs as deep as the column.
  hld.frame['height'] = cy + Number(questions.frame['height']) - hldY;
  return { name: 'Master template', elements: indexed(out) };
}

// ── C: the provided design (the answer key) ──────────────────────────────────

export type ProvidedNodeKind = 'client' | 'service' | 'worker' | 'store' | 'queue';

export interface ProvidedDesignSpec {
  /** The reference diagram's parts on a small grid (col from the left, row from the top). */
  nodes: ReadonlyArray<{ id: string; name: string; kind: ProvidedNodeKind; col: number; row: number }>;
  links: ReadonlyArray<{ from: string; to: string; label: string }>;
  /** "<Service>: what it does", one line each. */
  purposes: readonly string[];
  apis: readonly string[];
  dataModel: { kind: string; tables: readonly string[] };
  /** The short answers to the design questions, in their order. */
  answers: readonly string[];
}

const NODE_W = 220;
const NODE_H = 96;
const COL_STEP = 300;
const ROW_STEP = 170;
const SERVICE_FILL = '#a5d8ff';
const STORE_FILL = '#ffd43b';

/** One node: a box (client, service, worker) or a circle (store, queue), its name bound inside. */
function node(n: ProvidedDesignSpec['nodes'][number], x: number, y: number, frameId: string): El[] {
  const id = `pd-node-${n.id}`;
  const textId = `${id}-text`;
  const round = n.kind === 'store' || n.kind === 'queue';
  const label = wrap(n.name, 16);
  const lines = label.split('\n');
  const tw = Math.max(...lines.map((l) => l.length)) * HINT * CHAR;
  const th = lines.length * lineH(HINT);
  return [
    base(id, round ? 'ellipse' : 'rectangle', x, y, NODE_W, NODE_H, {
      frameId, backgroundColor: n.kind === 'client' ? 'transparent' : round ? STORE_FILL : SERVICE_FILL, strokeStyle: n.kind === 'worker' || n.kind === 'queue' ? 'dashed' : 'solid',
      roundness: round ? { type: 2 } : { type: 3 }, boundElements: [{ type: 'text', id: textId }],
    }),
    base(textId, 'text', x + (NODE_W - tw) / 2, y + (NODE_H - th) / 2, tw, th, {
      frameId, text: label, originalText: n.name, fontSize: HINT, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: id, autoResize: true, lineHeight: LINE,
    }),
  ];
}

/** A labelled arrow from one node's facing edge to the other's. */
function link(i: number, from: { x: number; y: number }, to: { x: number; y: number }, label: string, frameId: string): El[] {
  const id = `pd-link-${i + 1}`;
  const [fcx, fcy, tcx, tcy] = [from.x + NODE_W / 2, from.y + NODE_H / 2, to.x + NODE_W / 2, to.y + NODE_H / 2];
  const across = Math.abs(tcx - fcx) >= Math.abs(tcy - fcy);
  const sx = across ? (tcx > fcx ? from.x + NODE_W : from.x) : fcx;
  const sy = across ? fcy : (tcy > fcy ? from.y + NODE_H : from.y);
  const ex = across ? (tcx > fcx ? to.x : to.x + NODE_W) : tcx;
  const ey = across ? tcy : (tcy > fcy ? to.y : to.y + NODE_H);
  const dx = ex - sx;
  const dy = ey - sy;
  const textId = `${id}-label`;
  const w = label.length * HINT * CHAR;
  return [
    base(id, 'arrow', sx, sy, Math.abs(dx), Math.abs(dy), {
      frameId, points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow',
      roundness: { type: 2 }, elbowed: false, boundElements: [{ type: 'text', id: textId }],
    }),
    base(textId, 'text', sx + dx / 2 - w / 2, sy + dy / 2 - lineH(HINT) / 2, w, lineH(HINT), {
      frameId, text: label, originalText: label, fontSize: HINT, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: id, autoResize: true, lineHeight: LINE,
    }),
  ];
}

/** "Provided design": the heading and rule, the reference diagram, then the purposes, API, data model and answers two by two. */
export function providedDesignBoard(spec: ProvidedDesignSpec): KitBoard {
  const out: El[] = [...headed('pd', 0, 'Provided design', C_W + 60 + COL_W)];
  const hldY = 130;
  const hld = sectionFrame('pd', 'hld', 'High-level design', [], 0, hldY, C_W, 0);
  const cols = Math.max(1, ...spec.nodes.map((n) => n.col + 1));
  const rows = Math.max(1, ...spec.nodes.map((n) => n.row + 1));
  const step = Math.min(COL_STEP, (C_W - 2 * PAD - NODE_W) / Math.max(1, cols - 1));
  const at = new Map(spec.nodes.map((n) => [n.id, { x: PAD + 16 + n.col * step, y: hld.top + 20 + n.row * ROW_STEP }]));
  for (const n of spec.nodes) out.push(...node(n, at.get(n.id)!.x, at.get(n.id)!.y, 'pd-hld'));
  spec.links.forEach((l, i) => {
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (a && b) out.push(...link(i, a, b, l.label, 'pd-hld'));
  });
  hld.frame['height'] = hld.top - hldY + 20 + rows * ROW_STEP;
  out.push(hld.frame);

  // Under the diagram the purposes and the API side by side; the data model and the answers in a column on the right.
  const written = (id: string, name: string, text: string, fontFamily: number, x: number, y: number, w: number): number => {
    const h = heightOf(text, HINT) + 2 * PAD + 10;
    out.push(freeText(`pd-${id}-text`, x + PAD, y + PAD, text, { fontSize: HINT, frameId: `pd-${id}`, fontFamily }));
    out.push(base(`pd-${id}`, 'frame', x, y, w, h, { name, strokeWidth: 1, roughness: 0 }));
    return h;
  };
  const chars = (w: number) => charsFor(w - 2 * PAD, HINT);
  const mono = (w: number) => charsFor(w - 2 * PAD, HINT * 1.1);
  const rowY = hldY + Number(hld.frame['height']) + CELL_GAP;
  const purposes = bullets(spec.purposes, chars(HALF_W));
  const apis = spec.apis.map((a) => wrap(a, mono(HALF_W))).join('\n');
  written('purposes', 'Purpose(s) of each service', purposes, 2, 0, rowY, HALF_W);
  written('api', 'API signatures', apis, 3, HALF_W + CELL_GAP, rowY, HALF_W);
  const colX = C_W + 60;
  const dataH = written('data', 'Data model', [wrap(spec.dataModel.kind, chars(COL_W)), '', ...spec.dataModel.tables.map((t) => wrap(t, mono(COL_W)))].join('\n'), 3, colX, hldY, COL_W);
  written('answers', 'Answers', numbered(spec.answers, chars(COL_W)), 2, colX, hldY + dataH + 40, COL_W);
  return { name: 'Provided design', elements: indexed(out) };
}

/** The Master template as the kit editor starts it, around a question's title: placeholder lines to write over, and the palette. */
export function masterTemplateFor(title: string): KitBoard {
  return masterBoard({
    title,
    intro: ['What the product is and who uses it, in a sentence or two.', 'Say that the aim is to explain how to build the system and its central technical problems, not to list features.'],
    note: 'What is out of scope for this round.',
    stories: [{ actor: 'Users', can: ['the first must-have story', 'the second must-have story'] }],
    maybe: ['a stretch story'],
    questions: [
      { text: 'Who are the actors, and how does each one interface with the system?' },
      { text: 'Where is the core data stored, and why there?' },
      { text: 'How does the main read path work?' },
      { text: 'A change that makes them update the diagram.', enhancement: true },
    ],
  }, { palette: true });
}
