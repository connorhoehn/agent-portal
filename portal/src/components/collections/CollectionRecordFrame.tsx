// A collection's record, opened as a page (docs/layout-cascade.md rules 2–5
// and 8): the collection becomes the flush list rail beside the shell's rails
// (library `ListRailLayout`), and the content column opens with the trail and
// the view's title, then the record. Records route by URL
// (`/<tenant>/<collection>/:id`), so a row never opens a drawer or modal — the
// rendered-UI audit's `record.popout` rule holds every tenant to it.
//
// The composition of `StackedCatalogLayout` without a section rail of its own:
// a list page's table opens here, and the list rail's rows reopen records.
import { ListRailLayout, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import {
  EmptyState, ErrorState, GroupedList, LoadingState, SearchInput, Stack,
  type GroupedListGroup, type GroupedListRow,
} from '@connorhoehnslalom/ui-components/shared';
import type { ReactNode } from 'react';
import { SectionHeader } from '../shell/SectionContent';
import { useShellBreadcrumbItems } from '../shell/Breadcrumbs';

export interface CollectionRecordFrameProps {
  /** The view's title — the collection's name, so it does not jump between records (rule 3). */
  title: string;
  description?: string;
  /** The rail's caption and accessible label. */
  listTitle: string;
  listLabel: string;
  /** Records held (omit while the first load is in flight). */
  count?: number;
  /** The rail's find box over the same rows. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** Rows grouped as the list page groups them (a status, a kind). */
  groups: GroupedListGroup[];
  rows: GroupedListRow[];
  currentId: string | null;
  onOpen: (id: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** The content column's docked composer — the list page's command host. */
  footer?: ReactNode;
  /** The record (or its loading / not-found state). */
  children: ReactNode;
  /** The record's own conversation, drawn after the record at the content
   *  column's full width (outside the record's reading gutter), so its
   *  composer reaches the column's edges like every other composer. */
  conversation?: ReactNode;
  /**
   * The list rail's type step. `rail` (default): the library rail profile
   * (GroupedList `md`: 13/500 rows, 11px caps group labels, marked
   * `data-ui-text="rail-item"`/`"rail-caption"`) — off the app scale until the
   * library's rail `size="sm"` ships (docs/ui-components-queue.md, "Rail and
   * tile type off the app scale"), so those routes carry type-scale burn-down
   * rows. `app`: the library's own app-scale step (GroupedList `sm`: 14/500
   * rows, 12px sublines, 14/600 group headings with a 12px count chip), for a
   * record route that joins the sweep with no burn-down rows
   * (`/access/policies/:id`). Moves to the default when the rail release lands.
   */
  railType?: 'rail' | 'app';
  'data-testid'?: string;
}

export function CollectionRecordFrame({
  title, description, listTitle, listLabel, count, search, groups, rows, currentId, onOpen,
  loading = false, error = null, onRetry, footer, children, conversation, railType = 'rail', 'data-testid': testId,
}: CollectionRecordFrameProps) {
  const trail = useShellBreadcrumbItems();
  const body = error ? <ErrorState title={`Couldn't load ${listLabel}`} description={error} {...(onRetry ? { actionLabel: 'Retry', onAction: onRetry } : {})} />
    : loading && rows.length === 0 ? <LoadingState label={`Loading ${listLabel}…`} />
    : rows.length === 0 ? <EmptyState title="Nothing matches" description={search?.value ? `Nothing matches “${search.value.trim()}”.` : `No ${listLabel} yet.`} />
    : <GroupedList size={railType === 'app' ? 'sm' : 'md'} currentStyle="bar" groupHeading={railType === 'app' ? 'title' : 'label'} groupCountAlign="end" hideEmptyGroups
        groups={groups} rows={rows} currentId={currentId} onOpenRow={(row) => onOpen(row.id)} />;
  return (
    <ViewportFillRegion bottomGap={0} {...(testId ? { 'data-testid': testId } : {})}>
      <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush>
        <ListRailLayout
          header={<SectionHeader breadcrumbs={trail} title={title} {...(description ? { description } : {})} />}
          list={{
            // The app rail's 14/600 group headings already carry their counts; a 12px
            // caption above them would be a second heading size in one rail.
            ...(railType === 'app' ? {} : { title: listTitle, ...(count !== undefined ? { count } : {}) }),
            label: listLabel,
            ...(search ? { header: <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder} aria-label={search.placeholder} className="min-w-0 w-full" /> } : {}),
            body,
          }}
          {...(footer != null ? { footer } : {})}
        >
          <Stack gap="md" className="w-full min-w-0 px-[var(--ui-page-gutter)] pb-[var(--ui-page-gutter)]">{children}</Stack>
          {conversation}
        </ListRailLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
