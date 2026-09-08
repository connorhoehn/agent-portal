// A styled inline text node with zero raw elements — `Inline` in `as="span"`
// mode. Same pattern as `work/workShared.tsx`, `iq/Text.tsx` and
// `budgets/Text.tsx`: every designs page needs the occasional small styled
// caption or muted label, and a bare styled span/div is what the validator's
// component-discipline check forbids — this is the one place that need goes
// through a real composite instead of a raw tag. Forwards ARIA/role passthrough
// (`role`, `aria-label`) a decorative or labelled inline fragment needs.
import type { ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

export function T({
  as = 'span', className, title, children, wrap = false, ...rest
}: {
  as?: 'span' | 'div';
  className?: string;
  title?: string;
  children?: ReactNode;
  wrap?: boolean;
  role?: string;
  'aria-label'?: string;
}) {
  return (
    <Inline as={as} gap="none" wrap={wrap} className={className} title={title} {...rest}>
      {children}
    </Inline>
  );
}
