// Composed locally: no library composite renders a non-modal, non-trapping
// popover. PersonHoverCard opens its panel on focus, and the InlinePopover
// underneath it always moves focus into the panel and traps Tab there the
// instant it opens (`docs/orgiq-journeys/sme/DEFECTS.md` #2) — exactly
// backwards for a hover card, which is informational, not a task surface,
// and must never take focus or interrupt Tab. Queued in
// docs/ui-components-queue.md.
//
// Positioned with a ref rather than a JSX `style=` prop, same
// not-`forwardRef` gap `work/ActivityFrame.tsx` hit with Stack/Card: the
// panel portals to `document.body` (so it escapes a table cell's
// `overflow-hidden`/truncation) and needs the anchor's live
// `getBoundingClientRect()`, which only a real DOM ref can give it.
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@connorhoehnslalom/ui-components/shared';

export function PersonCardFrame({
  anchorRef,
  open,
  id,
  ariaLabel,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  id: string;
  ariaLabel: string;
  /** Cancels a pending close while the pointer is over the card itself. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Runs before paint, so the panel never flashes at (0,0) — unlike
  // FloatingPanel's drag surface, a bottom-left anchor doesn't depend on
  // the panel's own measured size, only the trigger's.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.zIndex = '9500';
  }, [open, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={ariaLabel}
      // No tabIndex, no focus-management effect: this panel is never the
      // focus target, on open or ever, so Tab always continues past
      // whatever last had focus on the page — see PersonRef.tsx.
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <Card padding="sm" className="w-72 shadow-lg">
        {children}
      </Card>
    </div>,
    document.body,
  );
}
