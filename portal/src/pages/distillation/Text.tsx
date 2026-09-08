// A styled inline text node with zero raw elements — `Inline` in `as="span"`
// mode, the same pattern DepartmentInsightStrip.tsx and NewItemForm.tsx use
// elsewhere in the portal. Every distillation page needs the occasional
// small styled caption, mono id, or muted label; a bare styled span or div
// is what the validator's component-discipline check forbids, so this is the
// one place that need goes through a real composite instead of a raw tag.
import type { ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

export function T({
  className, title, children, wrap = false,
}: { className?: string; title?: string; children: ReactNode; wrap?: boolean }) {
  return (
    <Inline as="span" gap="none" wrap={wrap} className={className} title={title}>
      {children}
    </Inline>
  );
}
