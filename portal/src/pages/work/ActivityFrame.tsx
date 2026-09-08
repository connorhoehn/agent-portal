// Composed locally in `portal/src/pages/work/ActivityFrame.tsx` — the job
// detail page's live activity tail auto-scrolls to the bottom as new SSE
// entries stream in, which needs a real DOM ref on the scroll container.
// `Stack`/`Card`/`Inline` are plain functions, not `forwardRef` components
// (see their exported `.d.ts` signatures — no `ForwardRefExoticComponent`),
// so none of them can receive that ref. This is the smallest fix: one
// ref-forwarding scroll region, queued in ui-components-queue.md so a future
// `Stack`/`Card` `ref` prop (or a dedicated `ScrollRegion` composite) can
// replace it.

import { forwardRef, type ReactNode } from 'react';

export const ActivityScroll = forwardRef<HTMLDivElement, { className?: string; children: ReactNode }>(
  function ActivityScroll({ className, children }, ref) {
    return <div ref={ref} className={className}>{children}</div>;
  },
);
