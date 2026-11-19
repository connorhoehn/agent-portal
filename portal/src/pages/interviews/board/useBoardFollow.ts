// Following the candidate on the interview's whiteboard (lib/interviewsBoardFollow.ts has the rules): who the candidate
// is on the board's awareness, the follow state and its control, the person's own press, wheel or key inside the
// canvas pausing it, and this canvas's size published beside its camera. The canvas itself follows through the
// library's `followUserId`.
import { useCallback, useEffect, useState } from 'react';
import type { AwarenessLike } from '@connorhoehn/realtime-modules/adapters/excalidraw';
import {
  BOARD_CANVAS_KEY, BOARD_CANVAS_PUBLISH_MS, OWN_INPUTS, boardPeers, candidatePeer, canvasSizeTicker, followLabel, followStep, followTarget,
  initialFollow, isOwnBoardInput, type BoardPeer, type FollowMode,
} from '../../../lib/interviewsBoardFollow';

export interface BoardFollow {
  mode: FollowMode;
  /** The library canvas's `followUserId`. */
  target: string | null;
  /** The candidate is on the board (the control shows only then). */
  present: boolean;
  label: string;
  toggle: () => void;
}

const sameCandidate = (a: BoardPeer | null, b: BoardPeer | null) => a?.clientId === b?.clientId && a?.userId === b?.userId;

/** `selector` finds the canvas's wrapper (the one useBoardFit fits). */
export function useBoardFollow(awareness: AwarenessLike | null | undefined, seat: 'lead' | 'panel' | 'candidate', selector: string, candidateName: string): BoardFollow {
  const [mode, setMode] = useState<FollowMode>(() => initialFollow(seat));
  const [candidate, setCandidate] = useState<BoardPeer | null>(null);

  // Who the candidate is, re-read on every awareness change; the state moves only when the person does.
  useEffect(() => {
    if (!awareness || seat === 'candidate') return undefined;
    const read = () => {
      const next = candidatePeer(boardPeers(awareness.getStates(), awareness.clientID));
      setCandidate((prev) => (sameCandidate(prev, next) ? prev : next));
    };
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [awareness, seat]);

  // The person's own press, wheel or key inside the canvas pauses following; a pointer move does not.
  useEffect(() => {
    if (mode !== 'following' || typeof document === 'undefined') return undefined;
    const onInput = (e: Event) => { if (isOwnBoardInput(e, selector)) setMode((m) => followStep(m, 'own-input')); };
    for (const type of OWN_INPUTS) document.addEventListener(type, onInput, { capture: true, passive: true });
    return () => { for (const type of OWN_INPUTS) document.removeEventListener(type, onInput, { capture: true }); };
  }, [mode, selector]);

  // This canvas's size beside its camera, at most 10 a second, so a follower can fit the area this person sees.
  useEffect(() => {
    if (!awareness || typeof ResizeObserver === 'undefined' || typeof document === 'undefined') return undefined;
    const el = document.querySelector(selector);
    if (!el) return undefined;
    const tick = canvasSizeTicker((size) => awareness.setLocalStateField(BOARD_CANVAS_KEY, size), BOARD_CANVAS_PUBLISH_MS, {
      now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    const observer = new ResizeObserver(([entry]) => { if (entry) tick({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(el);
    return () => { observer.disconnect(); tick.cancel(); };
  }, [awareness, selector]);

  const toggle = useCallback(() => setMode((m) => followStep(m, 'toggle')), []);
  return { mode, target: seat === 'candidate' ? null : followTarget(mode, candidate), present: candidate !== null, label: followLabel(mode, candidateName), toggle };
}
