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
import type { KitBoard } from '../types.js';
import { ARCHITECTURE_COMPONENTS, HINT_COLOR, ICON_W, architectureComponent, base, freeText, indexed, wrap } from './templates.js';

type El = Record<string, unknown>;

const TITLE = 56;
const HEADING = 32;
const BODY = 24;
const HINT = 20;
const LINE = 1.25;
const CHAR = 0.55;
const NOTE_COLOR = '#c92a2a';
const ACTOR_COLOR = '#1971c2';
const A_W = 620;
const B_X = A_W + 120;
const B_W = 1400;
const PAD = 24;
const CELL_GAP = 60;
const HALF_W = (B_W - CELL_GAP) / 2;

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

const PALETTE_COLUMNS = 6;
const CELL_W = 150;
const CELL_H = 140;
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
  const hld = sectionFrame('mt-b', hldS.id, hldS.name, hldS.hints, B_X, hldY, B_W, 0);
  out.push(...hld.els);
  let hldH = 720;
  if (opts.palette) {
    const ids = ARCHITECTURE_COMPONENTS.map((c) => c.id);
    ids.forEach((id, i) => {
      const x = B_X + PAD + (i % PALETTE_COLUMNS) * CELL_W + (CELL_W - ICON_W) / 2;
      out.push(...architectureComponent('mt', id, x, hld.top + Math.floor(i / PALETTE_COLUMNS) * CELL_H, 'mt-b-hld'));
    });
    const paletteW = PALETTE_COLUMNS * CELL_W;
    out.push(freeText('mt-b-hld-palette-hint', B_X + PAD + paletteW + 30, hld.top + 10, wrap(PALETTE_HINT, 26), { fontSize: HINT, color: HINT_COLOR, frameId: 'mt-b-hld' }));
    hldH += Math.ceil(ids.length / PALETTE_COLUMNS) * CELL_H;
  }
  hld.frame['height'] = hldH;
  out.push(hld.frame);

  // The four written sections, two by two under the diagram, each tall enough for its hints and room to write.
  const qText = numbered(spec.questions.map((q) => (q.enhancement ? `Enhancement: ${q.text}` : q.text)), charsFor(HALF_W - 2 * PAD, BODY));
  const row1Y = hldY + hldH + CELL_GAP;
  const cells = [
    { s: purposesS, x: B_X, y: row1Y }, { s: apiS, x: B_X + HALF_W + CELL_GAP, y: row1Y },
  ];
  const row1 = cells.map((c) => sectionFrame('mt-b', c.s.id, c.s.name, c.s.hints, c.x, c.y, HALF_W, 0));
  const row1H = Math.max(...row1.map((f) => f.top - row1Y)) + 260;
  for (const f of row1) { f.frame['height'] = row1H; out.push(...f.els, f.frame); }
  const row2Y = row1Y + row1H + CELL_GAP;
  const data = sectionFrame('mt-b', dataS.id, dataS.name, dataS.hints, B_X, row2Y, HALF_W, 0);
  const questions = sectionFrame('mt-b', questionsS.id, questionsS.name, questionsS.hints, B_X + HALF_W + CELL_GAP, row2Y, HALF_W, 0);
  const list = freeText('mt-b-questions-list', B_X + HALF_W + CELL_GAP + PAD, questions.top, qText, { fontSize: BODY, frameId: 'mt-b-questions' });
  const row2H = Math.max(data.top - row2Y + 300, questions.top - row2Y + heightOf(qText, BODY) + 200);
  data.frame['height'] = row2H;
  questions.frame['height'] = row2H;
  out.push(...data.els, data.frame, list, ...questions.els, questions.frame);
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
  const out: El[] = [...headed('pd', 0, 'Provided design', B_W)];
  const hldY = 130;
  const hld = sectionFrame('pd', 'hld', 'High-level design', [], 0, hldY, B_W, 0);
  const cols = Math.max(1, ...spec.nodes.map((n) => n.col + 1));
  const rows = Math.max(1, ...spec.nodes.map((n) => n.row + 1));
  const step = Math.min(COL_STEP, (B_W - 2 * PAD - NODE_W) / Math.max(1, cols - 1));
  const at = new Map(spec.nodes.map((n) => [n.id, { x: PAD + 16 + n.col * step, y: hld.top + 20 + n.row * ROW_STEP }]));
  for (const n of spec.nodes) out.push(...node(n, at.get(n.id)!.x, at.get(n.id)!.y, 'pd-hld'));
  spec.links.forEach((l, i) => {
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (a && b) out.push(...link(i, a, b, l.label, 'pd-hld'));
  });
  hld.frame['height'] = hld.top - hldY + 20 + rows * ROW_STEP;
  out.push(hld.frame);

  const chars = charsFor(HALF_W - 2 * PAD, HINT);
  const mono = charsFor(HALF_W - 2 * PAD, HINT * 1.1);
  const sections: Array<{ id: string; name: string; text: string; fontFamily: number }> = [
    { id: 'purposes', name: 'Purpose(s) of each service', text: bullets(spec.purposes, chars), fontFamily: 2 },
    { id: 'api', name: 'API signatures', text: spec.apis.map((a) => wrap(a, mono)).join('\n'), fontFamily: 3 },
    { id: 'data', name: 'Data model', text: [spec.dataModel.kind, '', ...spec.dataModel.tables.map((t) => wrap(t, mono))].join('\n'), fontFamily: 3 },
    { id: 'answers', name: 'Answers', text: numbered(spec.answers, chars), fontFamily: 2 },
  ];
  let y = hldY + Number(hld.frame['height']) + CELL_GAP;
  for (let r = 0; r < sections.length; r += 2) {
    const pair = sections.slice(r, r + 2);
    const h = Math.max(...pair.map((s) => heightOf(s.text, HINT))) + 2 * PAD + 10;
    pair.forEach((s, c) => {
      const x = c * (HALF_W + CELL_GAP);
      out.push(freeText(`pd-${s.id}-text`, x + PAD, y + PAD, s.text, { fontSize: HINT, frameId: `pd-${s.id}`, fontFamily: s.fontFamily }));
      out.push(base(`pd-${s.id}`, 'frame', x, y, HALF_W, h, { name: s.name, strokeWidth: 1, roughness: 0 }));
    });
    y += h + CELL_GAP;
  }
  return { name: 'Provided design', elements: indexed(out) };
}
