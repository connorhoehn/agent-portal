// Open a board when it opens (a master template on its prompt at a readable zoom, the record page's on what was drawn,
// any other fitted to its content), on both sides of the room and on the record page: the hook around
// lib/interviewsBoard.ts watchBoardFit (the opening is tried while the canvas loads its scene, once per scene and canvas
// size, and once more when an empty board first gets some, until the person's first press, wheel or key inside the board).
import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { openBoardView, readBoardElements, watchBoardFit, type BoardOpening } from '../../../lib/interviewsBoard';

/**
 * `selector` finds the board's wrapper on the page (a data attribute, unique per board). `held`: the canvas follows
 * someone, so no fit. `on`: what the board opens on (its prompt, or the drawing).
 */
export function useBoardFit(ydoc: Y.Doc | null | undefined, selector: string, held = false, on: BoardOpening = 'prompt'): void {
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (!ydoc || typeof document === 'undefined') return undefined;
    const canvas = () => document.querySelector(selector)?.querySelector('.excalidraw') ?? null;
    return watchBoardFit(ydoc, selector, {
      page: document,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      fit: () => { void openBoardView(document.querySelector(selector), readBoardElements(ydoc) as unknown as Array<Record<string, unknown>>, on); },
      held: () => heldRef.current,
      view: () => { const c = canvas(); return c ? `${c.clientWidth}x${c.clientHeight}` : null; },
    });
  }, [ydoc, selector, on]);
}
