// /access/catalog — what can be requested (docs/access-tenant-design.md §4.1):
// workspace roles and initiative memberships, read from GET /api/access/catalog
// with `heldByActor` and the separation-of-duties conflicts the server computed
// from the actor's current grants. "Request" opens the wizard on that item; the
// catalog itself changes nothing.

import {
  Chip,
  CollectionToolbar,
  DataTable,
  IconButton,
  PlusIcon,
  Stack,
  T,
  Tooltip,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import {
  ACCESS_API,
  DURATION_LABELS,
  KIND_LABELS,
  TENANT_LABELS,
  filterCatalog,
  type CatalogItem,
  type ItemsResponse,
} from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

const TENANT_OPTIONS = [
  { value: '', label: 'Every workspace' },
  ...Object.entries(TENANT_LABELS).map(([value, label]) => ({ value, label })),
];

function policyChip(item: CatalogItem) {
  if (!item.sodConflicts.length) return <T size="xs" tone="tertiary">—</T>;
  const block = item.sodConflicts.some((c) => c.severity === 'block');
  return (
    <Chip tone={block ? 'danger' : 'warning'} size="xs" title={item.sodConflicts.map((c) => c.reason).join(' · ')}>
      {block ? 'blocked' : 'warning'}
    </Chip>
  );
}

const COLUMNS: DataTableColumn<CatalogItem>[] = [
  {
    key: 'title', header: 'Item', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
    render: (i) => <T size="sm" title={`${i.title} — ${i.description}`} className="block max-w-[26rem] truncate">{i.title}</T>,
  },
  { key: 'kind', header: 'Kind', render: (i) => KIND_LABELS[i.kind] ?? i.kind },
  { key: 'tenant', header: 'Workspace', width: '120px', render: (i) => <Chip tone="neutral" size="xs">{TENANT_LABELS[i.tenant] ?? i.tenant}</Chip> },
  { key: 'defaultDuration', header: 'Default', render: (i) => DURATION_LABELS[i.defaultDuration] ?? i.defaultDuration },
  { key: 'sensitive', header: 'Sensitive', width: '96px', render: (i) => (i.sensitive ? <Chip tone="caution" size="xs" title="Adds an access-admin approval step">sensitive</Chip> : <T size="xs" tone="tertiary">—</T>) },
  { key: 'held', header: 'You hold', width: '96px', render: (i) => (i.heldByActor ? <Chip tone="success" size="xs">held</Chip> : <T size="xs" tone="tertiary">—</T>) },
  { key: 'policy', header: 'Policy', width: '96px', render: policyChip },
];

export default function CatalogPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const [tenant, setTenant] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<CatalogItem>>(`${ACCESS_API}/catalog`, 60_000);
  const all = data?.items ?? [];
  const rows = filterCatalog(all, query, tenant);
  const mayRequest = ready && can('RequestAccess');
  const startRequest = (item: CatalogItem) => navigate(`/access/requests/new?item=${encodeURIComponent(item.id)}`);

  const adapter = accessCollectionAdapter('catalog', {
    setQuery, setFilter: setTenant, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for the catalog to load before opening an item.');
      const item = resolveAccessTarget(target, rows);
      if (!mayRequest) throw new Error('Your role cannot request access. No changes were made.');
      startRequest(item);
      return `Opened a new request for ${item.title}. Nothing is submitted until you press Submit.`;
    },
  });

  const page = ACCESS_SURFACES.catalog;
  return (
    <CollectionCommandPage data-testid="access-catalog" title={page.title} description={page.description}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Catalog filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search the catalog', 'aria-label': 'Search the catalog' },
            filters: [{ id: 'tenant', label: 'Workspace', value: tenant, onChange: setTenant, options: TENANT_OPTIONS }],
            summary: data ? `${rows.length} of ${all.length} items` : undefined,
            notices: mayRequest ? ['A sensitive item adds an access-admin step to its approval chain.'] : ['Your role can browse the catalog but not request from it.'],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="the access catalog" source="The catalog is read from access_catalog_items" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-catalog-table"
              data={rows}
              columns={COLUMNS}
              keyField={(i) => i.id}
              loading={isLoading && !data}
              pageSize={25}
              {...(mayRequest ? {
                rowActions: (i: CatalogItem) => (
                  <Tooltip content={i.heldByActor ? 'You already hold this' : `Request ${i.title}`}>
                    <IconButton size="sm" aria-label={`Request ${i.title}`} icon={<PlusIcon />} disabled={i.heldByActor}
                      data-testid={`access-catalog-request-${i.id}`} onClick={() => startRequest(i)} />
                  </Tooltip>
                ),
              } : {})}
              emptyMessage={query.trim() || tenant ? 'No catalog item matches this search and workspace.' : 'Nothing is requestable yet — the catalog is empty.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
