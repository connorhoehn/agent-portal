// Open a board when it opens (a master template on its prompt at a readable zoom, any other fitted to its content), on both sides of the room and on the record page: the hook around
// lib/interviewsBoard.ts watchBoardFit (the fit is tried a few times while the canvas loads its scene, and once more
// when an empty board first gets some, until the person's first press, wheel or key inside the board).
import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { openBoardView, readBoardElements, watchBoardFit } from '../../../lib/interviewsBoard';

/** `selector` finds the board's wrapper on the page (a data attribute, unique per board). `held`: the canvas follows someone, so no fit. */
export function useBoardFit(ydoc: Y.Doc | null | undefined, selector: string, held = false): void {
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (!ydoc || typeof document === 'undefined') return undefined;
    return watchBoardFit(ydoc, selector, {
      page: document,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      fit: () => { void openBoardView(document.querySelector(selector), readBoardElements(ydoc) as unknown as Array<Record<string, unknown>>); },
      held: () => heldRef.current,
    });
  }, [ydoc, selector]);
}
