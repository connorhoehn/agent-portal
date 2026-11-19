// What a stored board may hold (review WB-1, item 8): the kinds of Excalidraw element a whiteboard round draws, and none
// of the fields that reach outside the board. An embedded page (`embeddable`, `iframe`) would put someone's URL in a
// frame on the record page or in every room the kit's board is inserted into; an image needs a file the board does not
// carry; a `link` on any element opens wherever it points. Used by the kit's starting boards (kit.ts checkBoard, which
// refuses such a board) and the checkpoints (snapshots.ts checkBoardScene, which leaves such elements out: the live
// board is drawn by everyone, and the record keeps what it can show).

/** The element kinds a board keeps. */
export const BOARD_ELEMENT_TYPES: ReadonlySet<string> = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'frame']);

/** Fields no stored element keeps a value in: present, they are set to null (the canvas reads every field). */
const EMPTIED = ['link'] as const;

/**
 * One element as a board stores it: a copy with its link emptied; `kind` when its type is not one a board keeps; null when it
 * is not an element at all (not a plain object with a string `id` and `type`).
 */
export function boardElement(raw: unknown): Record<string, unknown> | 'kind' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id'] || typeof r['type'] !== 'string') return null;
  if (!BOARD_ELEMENT_TYPES.has(r['type'])) return 'kind';
  const out = structuredClone(r);
  for (const f of EMPTIED) if (f in out) out[f] = null;
  return out;
}

/**
 * A board's elements with every id, and every reference to one (frame, container, bound elements, arrow bindings,
 * groups), put under `scope`: two copies of one design (two questions' provided designs from one template) then never
 * share an id on the shared board, where the second would otherwise add nothing. The same scope gives the same ids.
 */
export function scopeBoardIds(elements: ReadonlyArray<Record<string, unknown>>, scope: string): Array<Record<string, unknown>> {
  const own = (id: unknown): unknown => (typeof id === 'string' && id ? `${scope}:${id}` : id);
  const binding = (b: unknown): unknown => (b && typeof b === 'object' && 'elementId' in b ? { ...(b as object), elementId: own((b as { elementId: unknown }).elementId) } : b);
  return elements.map((raw) => {
    const e = structuredClone(raw);
    e['id'] = own(e['id']);
    if ('frameId' in e) e['frameId'] = own(e['frameId']);
    if ('containerId' in e) e['containerId'] = own(e['containerId']);
    if (Array.isArray(e['boundElements'])) e['boundElements'] = (e['boundElements'] as Array<Record<string, unknown>>).map((x) => ({ ...x, id: own(x['id']) }));
    if (Array.isArray(e['groupIds'])) e['groupIds'] = (e['groupIds'] as unknown[]).map(own);
    if ('startBinding' in e) e['startBinding'] = binding(e['startBinding']);
    if ('endBinding' in e) e['endBinding'] = binding(e['endBinding']);
    return e;
  });
}
