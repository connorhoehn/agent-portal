import type { ComponentProps } from 'react';
import { CollectionPage, Stack } from '@connorhoehnslalom/ui-components/shared';
import { FlushTrail } from '../shell/FlushPage';

/** The shell provides a full content column; only the title and the table
 * retain reading gutters. The command surface reaches the column/footer. */
export function CollectionCommandPage(props: ComponentProps<typeof CollectionPage>) {
  // Inside a section layout the trail is already the column's first row; a second one
  // here would push the title past 64px under the trail (docs/layout-cascade.md).
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
    <FlushTrail />
    <CollectionPage {...props}
      className="min-h-0 flex-1 [&>[data-testid=page-header]]:px-[var(--ui-page-gutter)]" />
  </Stack>;
}
