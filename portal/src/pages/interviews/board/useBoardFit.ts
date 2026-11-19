// Fit a board to its content when it opens, on both sides of the room and on the record page: the hook around
// lib/interviewsBoard.ts watchBoardFit (the fit is tried a few times while the canvas loads its scene, and once more
// when an empty board first gets some, until the person's first press, wheel or key inside the board).
import { useEffect } from 'react';
import type * as Y from 'yjs';
import { fitBoardView, watchBoardFit } from '../../../lib/interviewsBoard';

/** `selector` finds the board's wrapper on the page (a data attribute, unique per board). */
export function useBoardFit(ydoc: Y.Doc | null | undefined, selector: string): void {
  useEffect(() => {
    if (!ydoc || typeof document === 'undefined') return undefined;
    return watchBoardFit(ydoc, selector, {
      page: document,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      fit: () => { fitBoardView(document.querySelector(selector)); },
    });
  }, [ydoc, selector]);
}
