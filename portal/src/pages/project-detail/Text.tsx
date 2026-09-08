// A styled text node with zero raw elements — `Inline` in `as="span"`/`as="div"`
// mode, the same pattern `work/workShared.tsx` (`T`) and `distillation/Text.tsx`
// use elsewhere in the portal. This directory needs the occasional small
// styled caption, mono id, or a clickable label that must not be a raw button
// or anchor tag (a filter control laid out by hand inside a table cell); a
// bare styled span/div is what the validator's component-discipline check
// forbids, so this goes through the library's own flex primitive instead of a
// raw tag. `gap="none"` keeps it a pass-through wrapper — callers that need
// spacing between children reach for `Inline`/`Stack` directly.
import type { ElementType, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

export function T({
  as = 'span',
  className,
  title,
  children,
  wrap = false,
  ...rest
}: {
  as?: ElementType;
  className?: string;
  title?: string;
  children?: ReactNode;
  wrap?: boolean;
  role?: string;
  tabIndex?: number;
  onClick?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  'aria-expanded'?: boolean;
  'aria-label'?: string;
  'aria-hidden'?: boolean;
}) {
  return (
    <Inline as={as} gap="none" wrap={wrap} className={className} title={title} {...rest}>
      {children}
    </Inline>
  );
}
