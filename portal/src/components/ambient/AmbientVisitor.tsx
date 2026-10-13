import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './ambientVisitor.css';
import { useAmbientMotion } from './useAmbientMotion';
import { pickVisit, VISIT_INTERVAL_MS } from './pickVisit';

export interface AmbientVisitorProps {
  /** The surface supplies the travel bounds; no styles or children are changed. */
  target: HTMLElement | null;
  active?: boolean;
  edge?: 'top' | 'bottom';
  size?: number;
  delayMs?: number;
  /** Length of the one visit (in, pause, out). */
  cycleMs?: number;
  /** Where along the surface the visitor stops to look around, 0–1. */
  stopAt?: number;
  /** Walk right-to-left instead of left-to-right. */
  reverse?: boolean;
}

/** A decorative, clipped visitor. Reuse for a footer, header, card or navigation rail.
 * No focus, pointer events, layout changes or meaning is attached to the animation.
 */
export function AmbientVisitor({ target, active = true, edge = 'bottom', size = 24, delayMs = 0, cycleMs = 6_000, stopAt = 0.5, reverse = false }: AmbientVisitorProps) {
  const motion = useAmbientMotion();
  const enabled = active && motion;
  const [bounds, setBounds] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!target || !enabled) { setBounds(null); return; }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!target.isConnected || !target.getClientRects().length) { setBounds(null); return; }
        const box = target.getBoundingClientRect(), height = size * 1.25 + 4;
        const top = edge === 'bottom' ? box.bottom - height : box.top;
        let clipLeft = Math.max(0, -box.left), clipRight = Math.max(0, box.right - innerWidth);
        let clipTop = Math.max(0, -top), clipBottom = Math.max(0, top + height - innerHeight);
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { clipLeft = Math.max(clipLeft, rect.left - box.left); clipRight = Math.max(clipRight, box.right - rect.right); }
          if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { clipTop = Math.max(clipTop, rect.top - top); clipBottom = Math.max(clipBottom, top + height - rect.bottom); }
        }
        // A reversed visit mirrors the boundary, so its clip mirrors with it.
        const [l, r] = reverse ? [clipRight, clipLeft] : [clipLeft, clipRight];
        setBounds({ left: box.left, top, width: box.width, height, clipPath: `inset(${clipTop}px ${r}px ${clipBottom}px ${l}px)` });
      });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(target);
    for (let parent = target.parentElement; parent; parent = parent.parentElement) resize.observe(parent);
    window.addEventListener('scroll', measure, true); window.addEventListener('resize', measure);
    measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [target, enabled, edge, size, reverse]);
  if (!enabled || !target || !bounds) return null;
  const style = { ...bounds, '--visitor-size': `${size}px`, '--visitor-cycle': `${Math.max(cycleMs, 3000)}ms`, '--visitor-delay': `${Math.max(delayMs, 0)}ms`, '--visitor-stop': `${Math.round(Math.min(Math.max(stopAt, 0.1), 0.9) * 100)}%` } as CSSProperties;
  return createPortal(<div aria-hidden="true" className="ambient-visitor-boundary" style={style} data-ambient-visitor="mouse" data-direction={reverse ? 'rtl' : 'ltr'}>
    <span className="ambient-visitor-pose ambient-visitor-side" /><span className="ambient-visitor-pose ambient-visitor-front" />
  </div>, document.body);
}

/** One visit a minute, at a random place: a random surface among the matching
 * ones (expanded rail sections, plus the shell header and footer bar), a random
 * stopping point and a random direction. Decorative only; motion preferences
 * and prefers-reduced-motion still turn it off.
 */
const SHELL_SURFACES = '.shell-header, [data-testid="shell-footer-row"]';

export function AmbientVisitorTargets({ scope, selector, intervalMs = VISIT_INTERVAL_MS }: { scope: RefObject<HTMLElement | null>; selector: string; intervalMs?: number }) {
  const motion = useAmbientMotion();
  const [visit, setVisit] = useState<{ n: number; target: HTMLElement; edge: 'top' | 'bottom'; stopAt: number; reverse: boolean } | null>(null);
  useEffect(() => {
    const root = scope.current;
    if (!root || !motion) { setVisit(null); return; }
    let n = 0;
    const go = () => {
      const surfaces = [...Array.from(root.querySelectorAll<HTMLElement>(selector)), ...Array.from(document.querySelectorAll<HTMLElement>(SHELL_SURFACES))]
        .filter(el => el.isConnected && el.getClientRects().length > 0);
      if (!surfaces.length) return;
      const pick = pickVisit(surfaces.length);
      const target = surfaces[pick.index]!;
      n += 1;
      // The header's visitor walks along its bottom edge; the footer's along its top.
      setVisit({ n, target, edge: target.matches('[data-testid="shell-footer-row"]') ? 'top' : 'bottom', stopAt: pick.stopAt, reverse: pick.reverse });
    };
    const first = window.setTimeout(go, 5_000 + Math.random() * 15_000);
    const every = window.setInterval(go, intervalMs);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [scope, selector, motion, intervalMs]);
  return motion && visit ? <AmbientVisitor key={visit.n} target={visit.target} edge={visit.edge} stopAt={visit.stopAt} reverse={visit.reverse} /> : null;
}
