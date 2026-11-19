// The interview's shared whiteboard on the portal side (WHITEBOARD-PLAN steps 1 and 2): the board's names on the
// wire, inserting a question's starting board, reading the board for a checkpoint, and the checkpoint routes. The
// component is pages/interviews/board/InterviewBoard.tsx.
//
// The names mirror middleware/src/lib/interviews/board/channel.ts and a unit test pins them by value: document
// `ivboard:<interviewId>` on channel `doc:ivboard:<interviewId>`; inside, the scene is the library binding's root map.
import { ExcalidrawYjsBinding, type DiagramElement } from '@connorhoehn/realtime-modules/adapters/excalidraw';
import type * as Y from 'yjs';
import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export const BOARD_DOCUMENT_PREFIX = 'ivboard:';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,37}$/;

/** What a technical round works on; null for a behavioural round. Mirrors the server's kit.ts roundSurface. */
export type RoundSurface = 'pad' | 'board';

/** A question's starting board as the kit carries it. */
export interface KitBoard { name: string; elements: Array<Record<string, unknown>> }

export function boardDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${BOARD_DOCUMENT_PREFIX}${interviewId}` : null;
}
export function boardChannel(interviewId: string): string | null {
  const id = boardDocumentId(interviewId);
  return id ? `doc:${id}` : null;
}

/** The round's surface from the room's read; an older server without it reads as the pad. */
export const surfaceOf = (round: { type: string; surface?: RoundSurface | null }): RoundSurface | null =>
  round.type !== 'technical' ? null : round.surface === 'board' ? 'board' : 'pad';

/** The board's live elements now, as the canvas's binding holds them. */
export function readBoardElements(ydoc: Y.Doc): DiagramElement[] {
  const binding = new ExcalidrawYjsBinding({ ydoc });
  try { return binding.readAll().filter((e) => !e.isDeleted); } finally { binding.destroy(); }
}

/**
 * Put a starting board on the room's board as one write. Nothing on the board is cleared: an element already there
 * keeps its place, and an element of the template drawn before (the same id) comes back at a higher version so the
 * canvas takes it. How many elements went in.
 */
export function insertBoard(ydoc: Y.Doc, board: KitBoard): number {
  const binding = new ExcalidrawYjsBinding({ ydoc });
  try {
    const have = new Map(binding.readAll().map((e) => [e.id, e]));
    const next = board.elements.flatMap((raw): DiagramElement[] => {
      if (typeof raw['id'] !== 'string' || typeof raw['type'] !== 'string') return [];
      const prior = have.get(raw['id']);
      if (prior && !prior.isDeleted) return [];
      const version = Math.max(Number(raw['version']) || 1, (prior?.version ?? 0) + 1);
      return [{ ...raw, id: raw['id'], version, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, updated: Date.now() } as DiagramElement];
    });
    if (next.length) binding.commitLocal([...binding.readAll(), ...next]);
    return next.length;
  } finally { binding.destroy(); }
}

// ── checkpoints (the server's routes/interviews/board.ts) ─────────────────────

/** How often the lead's room posts a changed board, and the check for "changed". */
export const BOARD_SNAPSHOT_MS = 60_000;
export const boardSnapshotsPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/board/snapshots`;

/** A stable fingerprint of a scene: the elements' ids and versions. */
export const sceneKey = (elements: readonly DiagramElement[]): string => elements.map((e) => `${e.id}:${e.version}`).sort().join('|');

export async function postBoardSnapshot(interviewId: string, elements: readonly DiagramElement[]): Promise<boolean> {
  const res = await writeJson<{ stored: boolean }>(boardSnapshotsPath(interviewId), 'POST', { elements });
  return res.ok;
}

export interface BoardSnapshot { seq: number; at: string; who: { id: string; name: string }; elements: Array<Record<string, unknown>> }

export async function readBoardSnapshots(interviewId: string, fetcher: typeof fetch = fetch): Promise<BoardSnapshot[] | null> {
  try {
    const res = await fetcher(boardSnapshotsPath(interviewId), { credentials: 'include' });
    if (!res.ok) return null;
    const body = (await res.json()) as { snapshots?: BoardSnapshot[] };
    return Array.isArray(body.snapshots) ? body.snapshots : null;
  } catch { return null; }
}

// ── fit to the content ────────────────────────────────────────────────────────

/**
 * Zoom a mounted board so its content fills the pane: Excalidraw's own "Zoom to fit" (its Shift+1 shortcut, which it
 * allows in view mode too), sent to the canvas's container. The library's canvas takes no fit option yet
 * (docs/ui-components-queue.md); once it does, this goes. Whether a canvas was there to fit.
 */
export function fitBoardView(root: ParentNode | null | undefined): boolean {
  const canvas = root?.querySelector('.excalidraw');
  if (!canvas) return false;
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true, bubbles: true, cancelable: true }));
  return true;
}

/** When the board fits itself after it opens, in ms: the canvas loads the scene over its first seconds. */
export const BOARD_FIT_DELAYS_MS: readonly number[] = [400, 1200, 2500, 4500];
