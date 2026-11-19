// The "Master template" (board/templates.ts): the owner's format for a system design round. Part A (the prompt) and part B
// ("Your design") on the starting board, part C (the provided design) on its own board for the answer key.
jest.mock('../../../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { KIT_LIMITS, checkBoard } from '../../kit.js';
import { checkBoardScene } from '../snapshots.js';
import { MASTER_SECTIONS, masterBoard, providedDesignBoard, type MasterPromptSpec, type ProvidedDesignSpec } from '../templates.js';

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
