import type { ReactNode } from 'react';
import { Breadcrumbs, Stack } from '@connorhoehn/ui-components/shared';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { useSectionTrailDrawn } from './sectionTrail';

/** The trail row a flush page prints as its first row — unless a section layout
 * already drew it (docs/layout-cascade.md rules 1–2). Shared by every flush frame. */
export function FlushTrail({ compact = false }: { compact?: boolean } = {}) {
  const breadcrumbs = useShellBreadcrumbItems();
  const trailDrawn = useSectionTrailDrawn();
  if (trailDrawn) return null;
  return <Stack gap="none" className={`shrink-0 px-[var(--ui-page-gutter)] ${compact ? 'pt-3' : 'pt-[var(--ui-page-gutter)]'}`}>
    <Breadcrumbs items={breadcrumbs} separator="›" minItems={2}
      className={`${compact ? 'mb-2' : 'mb-4'} pb-1.5 border-b border-border overflow-x-auto whitespace-nowrap`} />
  </Stack>;
}

/** The trail a page passes to the library `PageFrame` (`breadcrumbs`): the
 * shell's items, or none when a section layout already drew the trail as the
 * column's first row (docs/layout-cascade.md rules 1–2). A non-collection page
 * (a form, a configuration surface) is a `PageFrame`: flush, the trail and the
 * one h1 at the page gutter, where every list page's title sits. */
export function useFlushTrailItems() {
  const breadcrumbs = useShellBreadcrumbItems();
  const trailDrawn = useSectionTrailDrawn();
  return trailDrawn ? undefined : breadcrumbs;
}

/** A page built on the library `DetailPage`, which is not flush by itself: it marks its root
 * `data-shell-flush`, so the shell hides its own trail row and the page's header draws the one
 * trail (the shell's items, from `useFlushTrailItems`) at the page gutter. Without it the shell's
 * row and the header's stand one above the other. */
export function FlushDetailFrame({ children }: { children: ReactNode }) {
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>{children}</Stack>;
}
