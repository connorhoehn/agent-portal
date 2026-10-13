import type { ComponentProps } from 'react';
import { Breadcrumbs, CollectionPage, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../shell/Breadcrumbs';
import { useSectionTrailDrawn } from '../shell/sectionTrail';

/** The shell provides a full content column; only the title and the table
 * retain reading gutters. The command surface reaches the column/footer. */
export function CollectionCommandPage(props: ComponentProps<typeof CollectionPage>) {
  const breadcrumbs = useShellBreadcrumbItems();
  // Inside a section layout the trail is already the column's first row; a second one
  // here would push the title past 64px under the trail (docs/layout-cascade.md).
  const trailDrawn = useSectionTrailDrawn();
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
    {!trailDrawn && <Stack gap="none" className="shrink-0 px-[var(--ui-page-gutter)] pt-[var(--ui-page-gutter)]">
      <Breadcrumbs items={breadcrumbs} separator="›" minItems={2}
        className="mb-4 pb-1.5 border-b border-border overflow-x-auto whitespace-nowrap" />
    </Stack>}
    <CollectionPage {...props}
      className="min-h-0 flex-1 [&>[data-testid=page-header]]:px-[var(--ui-page-gutter)]" />
  </Stack>;
}
