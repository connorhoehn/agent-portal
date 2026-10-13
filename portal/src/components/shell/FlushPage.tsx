import type { ReactNode } from 'react';
import { Breadcrumbs, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { useSectionTrailDrawn } from './sectionTrail';

/** The trail row a flush page prints as its first row — unless a section layout
 * already drew it (docs/layout-cascade.md rules 1–2). Shared by every flush frame. */
export function FlushTrail() {
  const breadcrumbs = useShellBreadcrumbItems();
  const trailDrawn = useSectionTrailDrawn();
  if (trailDrawn) return null;
  return <Stack gap="none" className="shrink-0 px-[var(--ui-page-gutter)] pt-[var(--ui-page-gutter)]">
    <Breadcrumbs items={breadcrumbs} separator="›" minItems={2}
      className="mb-4 pb-1.5 border-b border-border overflow-x-auto whitespace-nowrap" />
  </Stack>;
}

/** A non-collection page (a form, a configuration surface) on the collection
 * pages' frame: the shell's padding ring dropped (`data-shell-flush`), the
 * trail as the first row, the content at the page gutter — so its title sits
 * where every list page's title sits. */
export function FlushPage({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }) {
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush data-testid={testId}>
    <FlushTrail />
    <Stack gap="md" className="min-h-0 min-w-0 flex-1 overflow-auto px-[var(--ui-page-gutter)] pb-[var(--ui-page-gutter)]">
      {children}
    </Stack>
  </Stack>;
}
