// The "Master template" (board/templates.ts): the owner's format for a system design round. Part A (the prompt) and part B
// ("Your design") on the starting board, part C (the provided design) on its own board for the answer key.
jest.mock('../../../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { KIT_LIMITS, checkBoard } from '../../kit.js';
import { checkBoardScene } from '../snapshots.js';
import { MASTER_SECTIONS, masterBoard, providedDesignBoard, type MasterPromptSpec, type ProvidedDesignSpec } from '../templates.js';
import { TWITTER_DESIGN } from '../../../../mock/interviews-design-twitter.js';

const spec: MasterPromptSpec = {
  title: 'Design a parcel locker network',
  intro: ['People pick up parcels from lockers in shops and stations.', 'Explain how you would build the system and its hardest parts.'],
  note: 'The locker hardware and its firmware are out of scope.',
  stories: [{ actor: 'Senders', can: ['drop a parcel into a locker', 'see where it is'] }, { actor: 'Recipients', can: ['open the locker with a code'] }],
  maybe: ['Returns', 'Lockers that are full'],
  questions: [{ text: 'Who are the actors?' }, { text: 'Where is the code stored?' }, { text: 'Add a temperature-controlled locker; update the diagram.', enhancement: true }],
};
const design: ProvidedDesignSpec = {
  nodes: [
    { id: 'client', name: 'Mobile app', kind: 'client', col: 0, row: 1 },
    { id: 'api', name: 'API gateway', kind: 'service', col: 1, row: 1 },
    { id: 'lockers', name: 'Locker service', kind: 'service', col: 2, row: 1 },
    { id: 'db', name: 'Locker store', kind: 'store', col: 3, row: 1 },
  ],
  links: [{ from: 'client', to: 'api', label: 'HTTPS' }, { from: 'api', to: 'lockers', label: 'routes' }, { from: 'lockers', to: 'db', label: 'reads, writes' }],
  purposes: ['Locker service: assigns a locker and issues the code.'],
  apis: ['reserveLocker(parcelId: string): Locker'],
  dataModel: { kind: 'Relational (Postgres)', tables: ['lockers(id uuid PK, site_id uuid, size text)'] },
  answers: ['Senders, recipients and the courier.'],
};

const ids = (els: ReadonlyArray<Record<string, unknown>>) => els.map((e) => String(e['id']));
const flat = (s: unknown) => String(s).replace(/\n\s*/g, ' ');
const texts = (els: ReadonlyArray<Record<string, unknown>>) => els.filter((e) => e['type'] === 'text').map((e) => String(e['originalText']));

describe('Master template: the prompt (A) and "Your design" (B)', () => {
  const board = masterBoard(spec);
  const els = board.elements;

  it('passes the kit check and the checkpoint check unchanged, under the caps, ids unique and in order', () => {
    expect(board.name).toBe('Master template');
    const checked = checkBoard(board);
    expect(checked.ok && checked.board).toEqual(board);
    expect(checkBoardScene(els)!.elements).toBe(els.length);
    expect(els.length).toBeLessThan(KIT_LIMITS.boardElements / 2);
    expect(Buffer.byteLength(JSON.stringify(els), 'utf8')).toBeLessThan(KIT_LIMITS.boardBytes / 2);
    expect(new Set(ids(els)).size).toBe(els.length);
    const idx = els.map((e) => String(e['index']));
    expect([...idx].sort()).toEqual(idx);
  });

  it('part A reads top to bottom: title, intro, note, the user stories by actor, then Maybe', () => {
    const t = texts(els);
    const order = ['Design a parcel locker network', spec.intro[0]!, spec.intro[1]!, `Note: ${spec.note}`, 'Requirements / User stories', 'Senders can:', 'Recipients can:', 'Maybe:'];
    const at = order.map((s) => els.findIndex((e) => e['type'] === 'text' && flat(e['originalText']) === s));
    expect(at.every((n) => n >= 0)).toBe(true);
    const ys = at.map((n) => Number(els[n]!['y']));
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(t).toContain('• drop a parcel into a locker\n• see where it is');
    expect(t).toContain('• Returns\n• Lockers that are full');
  });

  it('part B sits right of A: "Your design" with a rule, then the five headed sections, each with its hint', () => {
    const aRight = Math.max(...els.filter((e) => String(e['id']).startsWith('mt-a-')).map((e) => Number(e['x']) + Number(e['width'])));
    const heading = els.find((e) => e['id'] === 'mt-b-heading')!;
    expect(heading['originalText']).toBe('Your design');
    expect(Number(heading['x'])).toBeGreaterThan(aRight);
    expect(els.find((e) => e['id'] === 'mt-b-rule')!['type']).toBe('line');
    const frames = els.filter((e) => e['type'] === 'frame');
    expect(frames.map((f) => f['name'])).toEqual(MASTER_SECTIONS.map((s) => s.name));
    expect(frames.every((f) => Number(f['x']) > aRight)).toBe(true);
    for (const s of MASTER_SECTIONS) {
      s.hints.forEach((hint, j) => {
        const el = els.find((e) => e['id'] === `mt-b-${s.id}-hint${j + 1}`)!;
        expect([el['frameId'], flat(el['text'])]).toEqual([`mt-b-${s.id}`, hint]);
      });
    }
    const q = String(els.find((e) => e['id'] === 'mt-b-questions-list')!['originalText']);
    expect(q.split('\n\n').map(flat)).toEqual(['1. Who are the actors?', '2. Where is the code stored?', '3. Enhancement: Add a temperature-controlled locker; update the diagram.']);
  });

  it('every text is a plain (non-handwritten) font, at a few consistent sizes', () => {
    const t = els.filter((e) => e['type'] === 'text');
    expect(new Set(t.map((e) => e['fontFamily']))).toEqual(new Set([2]));
    expect(new Set(t.map((e) => e['fontSize'])).size).toBeLessThanOrEqual(5);
  });

  it('the palette is an optional strip inside High-level design', () => {
    expect(els.some((e) => (e['groupIds'] as string[]).length > 0)).toBe(false);
    const withPalette = masterBoard(spec, { palette: true }).elements;
    const grouped = withPalette.filter((e) => (e['groupIds'] as string[]).length > 0);
    expect(grouped.length).toBeGreaterThan(40);
    expect(grouped.every((e) => e['frameId'] === 'mt-b-hld')).toBe(true);
    expect(checkBoard({ name: 'x', elements: withPalette }).ok).toBe(true);
  });
});

describe('Master template: the provided design (C), the answer key\'s own board', () => {
  const board = providedDesignBoard(design);
  const els = board.elements;

  it('passes the kit check under its own cap; no id is shared with the starting board, so a reveal adds all of it', () => {
    expect(board.name).toBe('Provided design');
    const checked = checkBoard(board, KIT_LIMITS.providedDesignBytes);
    expect(checked.ok && checked.board).toEqual(board);
    const starting = new Set(ids(masterBoard(spec, { palette: true }).elements));
    expect(ids(els).filter((id) => starting.has(id))).toEqual([]);
    expect(ids(els).every((id) => id.startsWith('pd-'))).toBe(true);
  });

  it('draws services as boxes and stores as circles, each arrow carries its label, then the written sections', () => {
    expect(texts(els)).toContain('Provided design');
    expect(els.find((e) => e['id'] === 'pd-node-api')!['type']).toBe('rectangle');
    expect(els.find((e) => e['id'] === 'pd-node-db')!['type']).toBe('ellipse');
    const arrows = els.filter((e) => e['type'] === 'arrow');
    expect(arrows).toHaveLength(3);
    for (const a of arrows) {
      const label = els.find((e) => e['containerId'] === a['id'])!;
      expect((a['boundElements'] as Array<{ id: string }>)[0]!.id).toBe(label['id']);
    }
    expect(els.filter((e) => e['type'] === 'frame').map((f) => f['name'])).toEqual(['High-level design', 'Purpose(s) of each service', 'API signatures', 'Data model', 'Answers']);
    expect(texts(els).join('\n')).toContain('reserveLocker(parcelId: string): Locker');
    expect(texts(els).map(flat).join('\n')).toContain('1. Senders, recipients and the courier.');
  });
});

describe('the seeded "Design Twitter" provided design reads cleanly', () => {
  const els = providedDesignBoard(TWITTER_DESIGN).elements;
  type Box = { x1: number; y1: number; x2: number; y2: number };
  const box = (e: Record<string, unknown>): Box => ({ x1: Number(e['x']), y1: Number(e['y']), x2: Number(e['x']) + Number(e['width']), y2: Number(e['y']) + Number(e['height']) });
  const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  const grow = (b: Box, by: number): Box => ({ x1: b.x1 - by, y1: b.y1 - by, x2: b.x2 + by, y2: b.y2 + by });
  const nodes = els.filter((e) => String(e['id']).startsWith('pd-node-') && e['type'] !== 'text');
  const arrows = els.filter((e) => e['type'] === 'arrow');
  const ends = (a: Record<string, unknown>) => { const [[, ], [dx, dy]] = a['points'] as number[][]; const x = Number(a['x']); const y = Number(a['y']); return { x, y, ex: x + dx!, ey: y + dy! }; };
  // Excalidraw centres an arrow's bound label on the arrow's midpoint; a generous width per character (wider than the template's own estimate).
  const labelBox = (a: Record<string, unknown>): Box => {
    const t = els.find((e) => e['containerId'] === a['id'])!;
    const { x, y, ex, ey } = ends(a);
    const w = String(t['text']).length * Number(t['fontSize']) * 0.6;
    const h = Number(t['fontSize']) * 1.25;
    return { x1: (x + ex) / 2 - w / 2, y1: (y + ey) / 2 - h / 2, x2: (x + ex) / 2 + w / 2, y2: (y + ey) / 2 + h / 2 };
  };

  it('no arrow label sits on a box or a circle', () => {
    const hits = arrows.flatMap((a) => nodes.filter((n) => overlaps(labelBox(a), grow(box(n), 6))).map((n) => `${String(els.find((e) => e['containerId'] === a['id'])!['text'])} on ${String(n['id'])}`));
    expect(hits).toEqual([]);
  });

  it('no arrow runs through a part it does not join', () => {
    const through = arrows.flatMap((a) => {
      const { x, y, ex, ey } = ends(a);
      return nodes.filter((n) => {
        const b = grow(box(n), -2);
        if ((x >= b.x1 - 4 && x <= b.x2 + 4 && y >= b.y1 - 4 && y <= b.y2 + 4) || (ex >= b.x1 - 4 && ex <= b.x2 + 4 && ey >= b.y1 - 4 && ey <= b.y2 + 4)) return false;
        return Array.from({ length: 41 }, (_, k) => k / 40).some((t) => { const px = x + (ex - x) * t; const py = y + (ey - y) * t; return px > b.x1 && px < b.x2 && py > b.y1 && py < b.y2; });
      }).map((n) => `${String(a['id'])} through ${String(n['id'])}`);
    });
    expect(through).toEqual([]);
  });

  it('the diagram fits its frame: every part, arrow and label inside the High-level design frame', () => {
    const frame = box(els.find((e) => e['id'] === 'pd-hld')!);
    const parts = [...nodes.map(box), ...arrows.map(labelBox), ...arrows.map((a) => { const { x, y, ex, ey } = ends(a); return { x1: Math.min(x, ex), y1: Math.min(y, ey), x2: Math.max(x, ex), y2: Math.max(y, ey) }; })];
    expect(parts.filter((b) => b.x1 < frame.x1 || b.y1 < frame.y1 || b.x2 > frame.x2 || b.y2 > frame.y2)).toEqual([]);
  });
});
