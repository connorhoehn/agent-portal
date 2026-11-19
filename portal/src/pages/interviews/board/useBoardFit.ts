// Fit a board to its content when it opens (lib/interviewsBoard.ts fitBoardView), on both sides of the room and on the
// record page. The canvas loads its scene over the first seconds, so the fit is tried a few times (BOARD_FIT_DELAYS_MS)
// while the board has content, and once more when an empty board first gets some (the lead's starting board reaching
// the candidate). The first touch of the canvas (a press or a wheel) hands the view to the person: no fit after it.
import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { BOARD_FIT_DELAYS_MS, fitBoardView, readBoardElements } from '../../../lib/interviewsBoard';

/** `selector` finds the board's wrapper on the page (a data attribute, unique per board). */
export function useBoardFit(ydoc: Y.Doc | null | undefined, selector: string): void {
  const touched = useRef(false);
  useEffect(() => {
    if (!ydoc || typeof document === 'undefined') return undefined;
    touched.current = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fit = () => {
      if (touched.current || readBoardElements(ydoc).length === 0) return;
      fitBoardView(document.querySelector(selector));
    };
    const schedule = (delays: readonly number[]) => { for (const ms of delays) timers.push(setTimeout(fit, ms)); };
    schedule(BOARD_FIT_DELAYS_MS);
    let empty = readBoardElements(ydoc).length === 0;
    const onUpdate = () => {
      if (!empty) return;
      if (readBoardElements(ydoc).length > 0) { empty = false; schedule([300, 1200]); }
    };
    ydoc.on('update', onUpdate);
    // Only a person's own press or wheel hands the view over.
    const hand = (e: Event) => { if (e.isTrusted) touched.current = true; };
    const root = document.querySelector(selector);
    root?.addEventListener('pointerdown', hand, { capture: true });
    root?.addEventListener('wheel', hand, { capture: true, passive: true });
    return () => {
      timers.forEach(clearTimeout);
      ydoc.off('update', onUpdate);
      root?.removeEventListener('pointerdown', hand, { capture: true });
      root?.removeEventListener('wheel', hand, { capture: true });
    };
  }, [ydoc, selector]);
}
