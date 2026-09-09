// A scroll container that can receive a DOM ref.
//
// Composed locally in `portal/src/components/ScrollRegion.tsx` because
// `Stack`/`Card`/`Inline` are plain functions, not `forwardRef` components —
// see their exported `.d.ts` signatures, none of which is a
// `ForwardRefExoticComponent`. Any tail that follows its own output needs a
// real node to read and set `scrollTop` on, and no library primitive can take
// one.
//
// This was `pages/work/ActivityFrame.tsx`, used by the job detail page alone.
// It moved here when the run timeline needed the same thing: a component under
// `components/` importing from `pages/` inverts the dependency, and two copies
// of a nine-line ref forwarder is worse than one. Queued in
// ui-components-queue.md so a `ref` prop on `Stack`/`Card` — or a dedicated
// `ScrollRegion` in the library — can delete this file outright.

import { forwardRef, type ReactNode } from 'react';

export const ScrollRegion = forwardRef<HTMLDivElement, { className?: string; children: ReactNode }>(
  function ScrollRegion({ className, children }, ref) {
    return <div ref={ref} className={className}>{children}</div>;
  },
);
