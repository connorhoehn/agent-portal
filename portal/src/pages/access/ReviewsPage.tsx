// /access/reviews — access review campaigns (docs/access-tenant-design.md A10,
// §4.4). Phase A2 brings them; until then GET /api/access/reviews answers
// `{ items: [] }` and this page says so honestly: the collection frame, its
// toolbar and command composer are already here (decision A9), the table's own
// empty row names the lane that fills it.

import { Chip, CollectionToolbar, DataTable, Stack, T, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { ACCESS_API, TENANT_LABELS, type AccessTenant, type ItemsResponse } from '../../lib/accessRequests';
import { accessCollectionAdapter } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

/** A campaign as A2 will serve it; A0 renders none. */
interface ReviewCampaign { id: string; title: string; tenant: AccessTenant; status: string; dueAt?: string | null }

const COLUMNS: DataTableColumn<ReviewCampaign>[] = [
  { key: 'title', header: 'Campaign', render: (c) => <T size="sm" title={c.title} className="block max-w-[24rem] truncate">{c.title}</T> },
  { key: 'tenant', header: 'Workspace', width: '120px', render: (c) => <Chip tone="neutral" size="xs">{TENANT_LABELS[c.tenant] ?? c.tenant}</Chip> },
  { key: 'status', header: 'Status', width: '112px', render: (c) => <Chip tone="info" size="xs">{c.status}</Chip> },
  { key: 'dueAt', header: 'Due', numeric: true, render: (c) => (c.dueAt ? relativeTime(c.dueAt) : '—') },
];

export default function ReviewsPage() {
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<ReviewCampaign>>(`${ACCESS_API}/reviews`, 120_000);
  const all = data?.items ?? [];
  const q = query.trim().toLowerCase();
  const rows = all.filter((c) => !q || `${c.id} ${c.title}`.toLowerCase().includes(q));
  const adapter = accessCollectionAdapter('reviews', { setQuery, refresh });
  const page = ACCESS_SURFACES.reviews;
  return (
    <CollectionCommandPage data-testid="access-reviews" title={page.title} description={page.description}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Review filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search reviews', 'aria-label': 'Search reviews' },
            summary: data ? `${rows.length} campaigns` : undefined,
            notices: [page.next ?? ''],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="access reviews" source="Review campaigns are read from access_reviews" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-reviews-table"
              data={rows}
              columns={COLUMNS}
              keyField={(c) => c.id}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() ? 'No campaign matches this search.' : `${page.emptyTitle}. ${page.emptyBody} A2 brings campaigns.`}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
