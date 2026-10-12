import type { ComponentProps } from 'react';
import { Breadcrumbs, CollectionPage, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../shell/Breadcrumbs';

/** The shell provides a full content column; only the title and the table
 * retain reading gutters. The command surface reaches the column/footer. */
export function RunCollectionPage(props: ComponentProps<typeof CollectionPage>) {
  const breadcrumbs = useShellBreadcrumbItems();
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
    <div className="shrink-0 px-[var(--ui-page-gutter)] pt-[var(--ui-page-gutter)]">
      <Breadcrumbs items={breadcrumbs} separator="›" minItems={2}
        className="mb-4 pb-1.5 border-b border-border overflow-x-auto whitespace-nowrap" />
    </div>
    <CollectionPage {...props}
      className="min-h-0 flex-1 [&>[data-testid=page-header]]:px-[var(--ui-page-gutter)]" />
  </Stack>;
}
