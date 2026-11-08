import type { ComponentProps } from 'react';
import { useLocation } from 'react-router';
import { CollectionPage, Stack } from '@connorhoehn/ui-components/shared';
import { usePublishPageContext, type PublishedPage } from '../../lib/voice/pageContext';
import { FlushTrail } from '../shell/FlushPage';

export interface CollectionCommandPageProps extends ComponentProps<typeof CollectionPage> {
  /**
   * The rows this page shows, for the voice's page context (G21,
   * lib/voice/pageContext.ts): what the page already read and rendered, in
   * its order. Omitted or null: the page publishes nothing.
   */
  voicePage?: Omit<PublishedPage, 'path'> | null;
}

/** The shell provides a full content column; only the title and the table
 * retain reading gutters. The command surface reaches the column/footer. */
export function CollectionCommandPage({ voicePage, ...props }: CollectionCommandPageProps) {
  const { pathname } = useLocation();
  usePublishPageContext(voicePage ? { ...voicePage, path: pathname } : null);
  // Inside a section layout the trail is already the column's first row; a second one
  // here would push the title past 64px under the trail (docs/layout-cascade.md).
  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
    <FlushTrail compact />
    <CollectionPage {...props}
      className="min-h-0 flex-1 [&>[data-testid=page-header]]:px-[var(--ui-page-gutter)]" />
  </Stack>;
}
