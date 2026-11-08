import type { ReactNode } from 'react';
import { Stack } from '@connorhoehn/ui-components/shared';
import { CollectionCommandHost, type CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost';

/** The observability detail pages render inside BuildSectionLayout, which
 *  already owns the trail and the content column, so they keep their
 *  `PageSection` and mount the command host with the table it drives; the host
 *  docks at the bottom of the content column (ColumnDock, docs/layout-cascade.md). */
export function ObservabilityCommandSection({ adapter, disabled, children }: {
  adapter: CollectionCommandAdapter;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Stack gap="lg" className="min-w-0">
      {children}
      <CollectionCommandHost adapter={adapter} {...(disabled ? { disabled } : {})} />
    </Stack>
  );
}
