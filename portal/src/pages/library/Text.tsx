// A styled text node with zero raw elements — `Inline` in `as="span"` (or
// `as="div"`/`as="p"`/`as="li"`/…) mode, the same pattern every other page
// group in this portal reaches for when a bare styled span/div/p is what the
// validator's component-discipline check forbids (see `work/workShared.tsx`,
// `iq/Text.tsx`, `distillation/Text.tsx` — this is the library's copy of the
// same shim, not a new primitive, so it isn't queued).
import type { ElementType, ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

export function T({
  as = 'span', className, title, children, wrap = false, ...rest
}: {
  as?: ElementType;
  className?: string;
  title?: string;
  children?: ReactNode;
  wrap?: boolean;
  'aria-hidden'?: boolean;
}) {
  return (
    <Inline as={as} gap="none" wrap={wrap} className={className} title={title} {...rest}>
      {children}
    </Inline>
  );
}
