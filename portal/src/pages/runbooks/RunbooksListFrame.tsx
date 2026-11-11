// The frame all three destinations share (docs/layout-cascade.md): the destination's list is a flush
// list rail beside the section rail (ListRailLayout), the content column opens with the trail and the
// title, then the record, and the collection command composer docks at the bottom of the column.
// A record is a page at its own URL — never a drawer.
import type { ComponentProps, ReactNode } from 'react';
import { ListRailLayout, ScopeHeader, useRailFold, useViewportWidth } from '@connorhoehn/ui-components';
import {
  EmptyState, GroupedList, Inline, LoadingState, SearchInput, Stack, T, type GroupedListRow,
} from '@connorhoehn/ui-components/shared';
import { CollectionCommandHost, type CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost';
import { SectionHeader } from '../../components/shell/SectionContent';
import { UnavailableNotice } from '../../components/UnavailableNotice';

export interface ListFrameProps {
  breadcrumbs: ComponentBreadcrumbs;
  title: string;
  description?: string;
  /** Rail caption, count and accessible label. */
  listTitle: string;
  count?: number;
  listLabel: string;
  query: string;
  onQuery: (value: string) => void;
  searchLabel: string;
  /** Controls beside the search (a filter popover). */
  filter?: ReactNode;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  errorWhat: string;
  errorSource: string;
  groups: Array<{ id: string; title: string; count: number }>;
  rows: GroupedListRow[];
  currentId: string | null;
  onOpen: (id: string) => void;
  emptyTitle: string;
  emptyDescription: string;
  onClear?: () => void;
  /** A button in the section header, and the same action in the empty list. */
  headerActions?: ReactNode;
  emptyAction?: { label: string; onAction: () => void };
  storageKey: string;
  footerNote: ReactNode;
  commands: CollectionCommandAdapter;
  children: ReactNode;
  'data-testid': string;
}
type ComponentBreadcrumbs = ComponentProps<typeof SectionHeader>['breadcrumbs'];

/** Below this width the list rail starts folded to its strip, so the content column keeps its share beside the section rail. */
const FOLD_LIST_BELOW = 1100;

export function RunbooksListFrame(p: ListFrameProps) {
  const fold = useRailFold({ storageKey: 'runbooks.list-rail', defaultFolded: useViewportWidth() < FOLD_LIST_BELOW });
  const body = p.error ? (
    <Stack className="p-3">
      <UnavailableNotice error={p.error} what={p.errorWhat} source={p.errorSource} onRetry={p.onRetry} />
    </Stack>
  ) : p.loading ? (
    <LoadingState label={`Loading ${p.listLabel}…`} />
  ) : p.rows.length === 0 ? (
    <EmptyState align="start"
      title={p.query ? 'No matches' : p.emptyTitle}
      description={p.query ? 'Nothing in this list matches the search.' : p.emptyDescription}
      {...(p.query && p.onClear ? { actionLabel: 'Clear search', onAction: p.onClear } : !p.query && p.emptyAction ? { actionLabel: p.emptyAction.label, onAction: p.emptyAction.onAction } : {})}
    />
  ) : (
    <GroupedList
      size="md"
      groupHeading="label"
      currentStyle="bar"
      groups={p.groups}
      rows={p.rows}
      currentId={p.currentId}
      onOpenRow={(row) => p.onOpen(row.id)}
      storageKey={p.storageKey}
      data-testid={`${p['data-testid']}-list`}
    />
  );
  return (
    <ListRailLayout
      header={p.currentId ? <ScopeHeader variant="crumbs" breadcrumbs={p.breadcrumbs} data-testid="section-crumbs" /> : <SectionHeader breadcrumbs={p.breadcrumbs} title={p.title} {...(p.description ? { description: p.description } : {})} {...(p.headerActions ? { actions: p.headerActions } : {})} />}
      list={{
        title: p.listTitle,
        ...(p.count != null ? { count: p.count } : {}),
        header: (
          <Inline gap="xs" align="center" wrap={false}>
            <SearchInput
              value={p.query}
              onChange={p.onQuery}
              placeholder={p.searchLabel}
              aria-label={p.searchLabel}
              className="min-w-0 flex-1"
              data-testid={`${p['data-testid']}-search`}
            />
            {p.filter}
          </Inline>
        ),
        body,
        footer: <T size="sm" className="text-text-secondary">{p.footerNote}</T>,
        label: p.listLabel,
      }}
      fold={{ folded: fold.folded, onToggle: fold.toggle }}
      footer={<CollectionCommandHost inPlace adapter={p.commands} />}
      data-testid={p['data-testid']}
    >
      {p.children}
    </ListRailLayout>
  );
}
