// The "Architecture kit" starting board (templates.ts architectureBoard): it passes the kit's board check and the
// checkpoints' scene check unchanged, every palette component is one group with its label, and it stays small.
jest.mock('../../../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { KIT_LIMITS, checkBoard } from '../../kit.js';
import { checkBoardScene } from '../snapshots.js';
import { ARCHITECTURE_COMPONENTS, COMPONENT_FILL, architectureBoard, architectureComponent } from '../templates.js';

const board = architectureBoard('Design Twitter');
const els = board.elements;

describe('Architecture kit', () => {
  it('passes the kit check and the checkpoint check unchanged, well under the caps', () => {
    const checked = checkBoard(board);
    expect(checked.ok && checked.board).toEqual(board);
    expect(checkBoardScene(els)!.elements).toBe(els.length);
    expect(els.length).toBe(83);
    expect(els.length).toBeLessThan(KIT_LIMITS.boardElements / 4);
    expect(Buffer.byteLength(JSON.stringify(els), 'utf8')).toBeLessThan(KIT_LIMITS.boardBytes / 4);
    expect(new Set(els.map((e) => e['id'])).size).toBe(els.length);
    const idx = els.map((e) => String(e['index']));
    expect([...idx].sort()).toEqual(idx);
  });

  it('has the prompt card, the Notes headings, the palette, the hint and an empty Design frame', () => {
    expect(board.name).toBe('Architecture kit');
    expect(els.filter((e) => e['type'] === 'frame').map((e) => e['name'])).toEqual(['Notes', 'Components', 'Design']);
    const notes = els.filter((e) => e['frameId'] === 'ak-notes' && !String(e['id']).endsWith('-hint')).map((e) => e['text']);
    expect(notes).toEqual(['Clarifying questions', 'Functional', 'Non-functional', 'Components', 'Deep dive']);
    expect(els.find((e) => e['id'] === 'ak-prompt-text')!['originalText']).toBe('Design Twitter');
    expect(els.filter((e) => e['frameId'] === 'ak-design')).toEqual([]);
    expect(String(els.find((e) => e['id'] === 'ak-hint')!['text'])).toMatch(/Alt-drag or Cmd\/Ctrl\+D/);
  });

  it('every palette component is exactly one group, in the palette frame, with its label', () => {
    const palette = els.filter((e) => e['frameId'] === 'ak-palette');
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const e of palette) {
      const g = e['groupIds'] as string[];
      expect(g).toHaveLength(1);
      groups.set(g[0]!, [...(groups.get(g[0]!) ?? []), e]);
    }
    expect([...groups.keys()]).toEqual(ARCHITECTURE_COMPONENTS.map((c) => `ak-g-${c.id}`));
    expect(ARCHITECTURE_COMPONENTS.map((c) => c.label)).toEqual([
      'Web client', 'Mobile client', 'CDN', 'Load balancer', 'App servers', 'Auth',
      'Cache', 'Message queue', 'Workers', 'Database (primary)', 'Database (replica)', 'Labelled arrow',
    ]);
    for (const c of ARCHITECTURE_COMPONENTS) {
      const members = groups.get(`ak-g-${c.id}`)!;
      const labels = members.filter((e) => e['type'] === 'text' && e['containerId'] === null).map((e) => e['text']);
      expect(labels).toEqual([c.label]);
      // One fill and one stroke weight across the kit; the hand-drawn look Excalidraw gives roughness 1.
      for (const e of members.filter((m) => m['backgroundColor'] !== 'transparent')) expect(e['backgroundColor']).toBe(COMPONENT_FILL);
      for (const e of members.filter((m) => m['type'] !== 'text')) expect([e['strokeWidth'], e['roughness']]).toEqual([2, 1]);
    }
    // No palette element is outside a component's group.
    expect(palette.every((e) => (e['groupIds'] as string[])[0]!.startsWith('ak-g-'))).toBe(true);
  });

  it('the labelled arrow carries Excalidraw\'s own arrow label, bound both ways', () => {
    const arrow = els.find((e) => e['id'] === 'ak-arrow-1')!;
    const label = els.find((e) => e['id'] === 'ak-arrow-1-label')!;
    expect(arrow['type']).toBe('arrow');
    expect(arrow['boundElements']).toEqual([{ type: 'text', id: 'ak-arrow-1-label' }]);
    expect(label).toMatchObject({ type: 'text', containerId: 'ak-arrow-1', text: 'reads' });
  });

  it('another question can pick its own components, and an unknown one is skipped', () => {
    const small = architectureBoard('Design a chat app', { components: ['web', 'mobile', 'queue', 'nope'] });
    const groups = new Set(small.elements.flatMap((e) => e['groupIds'] as string[]));
    expect([...groups]).toEqual(['ak-g-web', 'ak-g-mobile', 'ak-g-queue']);
    expect(checkBoard(small).ok).toBe(true);
    expect(architectureComponent('x', 'nope', 0, 0)).toEqual([]);
  });
});
