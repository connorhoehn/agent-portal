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
