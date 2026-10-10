import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './ambientVisitor.css';
import { useAmbientMotion } from './useAmbientMotion';

export interface AmbientVisitorProps {
  /** The surface supplies the travel bounds; no styles or children are changed. */
  target: HTMLElement | null;
  active?: boolean;
  edge?: 'top' | 'bottom';
  size?: number;
  delayMs?: number;
  cycleMs?: number;
}

/** A decorative, clipped visitor. Reuse for a footer, header, card or navigation rail.
 * No focus, pointer events, layout changes or meaning is attached to the animation.
 */
export function AmbientVisitor({ target, active = true, edge = 'bottom', size = 24, delayMs = 0, cycleMs = 48_000 }: AmbientVisitorProps) {
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
        setBounds({ left: box.left, top, width: box.width, height, clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)` });
      });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(target);
    for (let parent = target.parentElement; parent; parent = parent.parentElement) resize.observe(parent);
    window.addEventListener('scroll', measure, true); window.addEventListener('resize', measure);
    measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [target, enabled, edge, size]);
  if (!enabled || !target || !bounds) return null;
  const style = { ...bounds, '--visitor-size': `${size}px`, '--visitor-cycle': `${Math.max(cycleMs, 6000)}ms`, '--visitor-delay': `${Math.max(delayMs, 0)}ms` } as CSSProperties;
  return createPortal(<div aria-hidden="true" className="ambient-visitor-boundary" style={style} data-ambient-visitor="mouse">
    <span className="ambient-visitor-pose ambient-visitor-side" /><span className="ambient-visitor-pose ambient-visitor-front" />
  </div>, document.body);
}

/** Mount visitors on matching surfaces without coupling the animation to their markup.
 * Example: selector='[data-visitor-surface]' can include header/footer and either rail.
 * The shell currently opts in only expanded primary navigation sections.
 */
export function AmbientVisitorTargets({ scope, selector }: { scope: RefObject<HTMLElement | null>; selector: string }) {
  const motion = useAmbientMotion();
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  useEffect(() => {
    const root = scope.current;
    if (!root || !motion) { setTargets([]); return; }
    const scan = () => {
      const next = Array.from(root.querySelectorAll<HTMLElement>(selector));
      setTargets(old => old.length === next.length && old.every((node, i) => node === next[i]) ? old : next);
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'data-visitor-surface'] });
    return () => observer.disconnect();
  }, [scope, selector, motion]);
  return <>{motion && targets.map((target, index) => <AmbientVisitor key={index} target={target} delayMs={index * 6000} cycleMs={Math.max(48_000, targets.length * 6000)} />)}</>;
}
