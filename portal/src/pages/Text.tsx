// A styled inline text node with zero raw elements — `Inline` in `as="span"`
// mode. Same pattern as `capabilities/Text.tsx`, `iq/Text.tsx` and
// `distillation/Text.tsx`: every root page needs the occasional small styled
// caption, mono id, or muted label, and a bare styled span/div is what the
// validator's component-discipline check forbids — this is the one place
// that need goes through a real composite instead of a raw tag.
import type { ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

export function T({
  className, title, children, wrap = false, as = 'span', 'aria-hidden': ariaHidden,
}: {
  className?: string; title?: string; children?: ReactNode; wrap?: boolean;
  /** Render as something other than a `<span>` — e.g. `"p"` for a text passage. */
  as?: 'span' | 'p';
  'aria-hidden'?: boolean;
}) {
  return (
    <Inline as={as} gap="none" wrap={wrap} className={className} title={title} aria-hidden={ariaHidden}>
      {children}
    </Inline>
  );
}
