import { useEffect, useState } from 'react';
// Where a shell conversation panel opens: upward from the bottom bar, at its
// left edge, the way the huddle design anchors every footer menu
// (docs/design/initiative-huddle-shell-plan.md, "open footer menus upward").
// The user, 2026-10-06: "i never wanted the social stuff floating on the top".
//
// `--shell-collaboration-floor` is the measured height of the call dock plus
// the Social row (ShellCallHost.tsx); the panel's height class caps it at
// `min(maxRem, 100dvh - floor - 2rem)`, so the same arithmetic puts its bottom
// edge just above the bar. FloatingPanel reads this point when it opens and
// clamps it to the viewport; dragging still works.

const GAP = 16, MARGIN = 16;

export function aboveFooter(maxRem: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: MARGIN, y: MARGIN };
  const floor = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--shell-collaboration-floor')) || 0;
  const height = Math.min(maxRem * 16, window.innerHeight - floor - 2 * MARGIN);
  return { x: MARGIN, y: Math.max(MARGIN, Math.round(window.innerHeight - floor - height - GAP)) };
}

/** The same point at the bar's RIGHT edge, for a panel `widthRem` wide — the huddle's own menus sit there. */
export function aboveFooterEnd(maxRem: number, widthRem: number): { x: number; y: number } {
  const start = aboveFooter(maxRem);
  if (typeof window === 'undefined') return start;
  const width = Math.min(widthRem * 16, window.innerWidth - 2 * MARGIN);
  return { x: Math.max(MARGIN, window.innerWidth - width - MARGIN), y: start.y };
}

/**
 * A key that changes when the viewport does. FloatingPanel only clamps a panel
 * to the viewport, not to the footer, so after a resize (1440×900 → 1280×720)
 * a panel opened above the bar ends up under it; remounting on the new size
 * re-reads `aboveFooter`. Dragging is forgotten across a resize, nothing else.
 */
export function useFooterAnchorKey(): string {
  const read = () => typeof window === 'undefined' ? '0x0' : `${window.innerWidth}x${window.innerHeight}`;
  const [key, setKey] = useState(read);
  useEffect(() => {
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setKey(read())); };
    window.addEventListener('resize', update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); };
  }, []);
  return key;
}
