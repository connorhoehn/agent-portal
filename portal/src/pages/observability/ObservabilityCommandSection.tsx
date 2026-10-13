import type { ReactNode } from 'react';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost, type CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost';

/** The observability detail pages render inside BuildSectionLayout, which
 *  already owns the trail and the padded content column, so they keep their
 *  `PageSection` and mount the command host as the section's last row. The
 *  marker makes that section the composer's boundary
 *  (docs/layout-cascade.md; the audit's `composerBoundary`). Must be a direct
 *  child of the `PageSection`. */
export function ObservabilityCommandSection({ adapter, disabled, children }: {
  adapter: CollectionCommandAdapter;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Stack gap="lg" className="min-w-0" data-collection-command-boundary="embedded">
      {children}
      <CollectionCommandHost adapter={adapter} {...(disabled ? { disabled } : {})} />
    </Stack>
  );
}
