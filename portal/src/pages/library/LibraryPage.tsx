// Design → Library. One catalog for everything the fleet is instructed by.
//
// This replaces "Overview" as the front door, and it is deliberately ONE page
// rather than a prompt browser plus a skill browser: a skill and a prompt
// differ in who invokes them, which is a facet, not a separate product. Filter
// to kind=skill and this IS the skill browser — same search, same detail, same
// provenance panel.
//
// Selecting an asset opens the next pane beside the catalog rails. URL state
// restores both the selection and its filters through breadcrumbs and Back.

import { useMemo } from 'react';
import { StackedCatalogLayout } from '../../components/shell/StackedCatalogLayout';
import { Link, useSearchParams, useParams, useNavigate } from 'react-router';
import {
  Button,
  FileKindMark,
  Select,
  Chip,
  DataTable,
  EmptyState,
  Inline,
  PageHeader,
  SearchInput,
  Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { AssetDrawer } from './AssetDrawer';
import { T } from './Text';
import {
  KIND_HINT, KIND_LABEL, KIND_ORDER,
  TIER_HINT, TIER_LABEL, TIER_ORDER,
  facetOptions, libraryEmptyKind,
} from './libraryFormat';
import type { AssetKind, AssetTier, LibraryAsset, LibraryResponse } from './types';
import { knowledgeHref } from '../distillation/distillationRoutes';

// Same cadence TiersPage.tsx set for this exact pattern.
const SEARCH_DEBOUNCE_MS = 250;

export default function LibraryPage() {
  // Facets live in the URL so a filtered library is a shareable link — "the
  // security evaluators" is a thing people send each other.
  const [params, setParams] = useSearchParams();
  const kind = KIND_ORDER.includes(params.get('kind') as AssetKind) ? params.get('kind') as AssetKind : 'all';
  const tier = TIER_ORDER.includes(params.get('tier') as AssetTier) ? params.get('tier') as AssetTier : 'all';
  const status = params.get('status') ?? 'all';
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  const canAuthor = ready && can('ManageCanary') && ['org-leader', 'hr-admin'].includes(session?.role ?? '');
  const setFilter = (key: string, value: string) => {
    cancelPending();
    const next = new URLSearchParams(params);
    next.delete('nav');
    if (value === 'all') next.delete(key); else next.set(key, value);
    navigate(`/iq/library?${next}`);
  };
  // `query` is what actually drives the fetch URL below; the box shows
  // `searchText` and only commits to `query` (and so only fires a new
  // request) `SEARCH_DEBOUNCE_MS` after typing stops — this used to put
  // every keystroke straight into the URL and re-fetch on each one.
  const query = params.get('q') ?? '';
  const setQuery = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('q', value); else next.delete('q');
    setParams(next, { replace: true });
  };
  const { searchText, onSearchChange, cancelPending } = useDebouncedSearch(query, setQuery, SEARCH_DEBOUNCE_MS);
  // Opening a record pushes history; its parent breadcrumb closes it.
  const { assetId: routeAssetId } = useParams<{ assetId?: string }>();
  const navigate = useNavigate();
  const openId = routeAssetId ?? null;
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params);
    next.delete('nav');
    navigate(`/iq/library${id ? `/${encodeURIComponent(id)}` : ''}?${next}`);
  };


  const url = `/api/library?limit=200&kind=${kind}&tier=${tier}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const { data, isLoading, error, degraded, refresh } = useFetch<LibraryResponse>(url, 60_000);
  const libraryFailure = error ?? degraded;

  const assets = useMemo(() => (data?.assets ?? []).filter((a) => status === 'all' || a.lifecycleStatus === status), [data, status]);
  const filtersApplied = status !== 'all' || kind !== 'all' || tier !== 'all' || query.trim().length > 0;
  const emptyKind = libraryEmptyKind(filtersApplied, assets.length);
  // /iq/library/:assetId — the trail reads the asset's name once the catalog
  // has it, not the shortened id.
  useCrumbLabel(routeAssetId, assets.find((a) => a.id === routeAssetId)?.name);
  const kindOptions = useMemo(() => facetOptions(data?.facets.kind ?? {}, KIND_ORDER), [data]);

  const columns: DataTableColumn<LibraryAsset>[] = [
    {
      key: 'name', header: 'Asset', width: '44%', sortable: true,
      render: (a) => (
        <Stack gap="none" className="min-w-0">
          <Inline gap="xs" wrap={false} className="items-center gap-2 min-w-0">
            {/* A real Button, not just the row's onClick: DataTable's row-click
                is a bare <tr onClick> with no tabIndex/keydown handling, so a
                keyboard user tabbing through the filter bar would otherwise
                skip straight past every row with no way to open one. This is
                the row's one focusable, Enter/Space-activatable control; the
                row click stays as a mouse convenience alongside it. */}
            <FileKindMark kind={a.kind === 'skill' || a.kind === 'evaluator' ? 'workflow' : 'page'} size="md" variant="glyph" />
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 truncate border-none bg-transparent p-0 text-[13px] text-text-primary hover:bg-transparent hover:underline"
              title={a.name}
              onClick={(e) => { e.stopPropagation(); setOpenId(a.id); }}
            >
              {a.name}
            </Button>
            {a.lifecycleStatus === 'draft' && <Chip tone="neutral" size="xs">draft</Chip>}
          </Inline>
          {/* Keep a compact preview; the asset detail retains the full description. */}
          <T as="div" className="text-[12px] text-text-tertiary truncate" title={a.description}>{a.description}</T>
        </Stack>
      ),
    },
    {
      key: 'kind', header: 'Kind', width: '12%', sortable: true,
      render: (a) => <T className="text-[13px] text-text-secondary" title={KIND_HINT[a.kind]}>{KIND_LABEL[a.kind]}</T>,
    },
    {
      key: 'tier', header: 'Tier', width: '12%', sortable: true,
      render: (a) => <T className="text-[13px] text-text-secondary" title={TIER_HINT[a.tier]}>{TIER_LABEL[a.tier]}</T>,
    },
    {
      key: 'contract', header: 'Inputs', width: '12%',
      render: (a) => <T className="text-[13px] text-text-secondary whitespace-nowrap">{a.contract.variables.length ? `${a.contract.variables.length} variable${a.contract.variables.length === 1 ? '' : 's'}` : 'None'}</T>,
    },
    {
      key: 'usedBy', header: 'Used by', width: '17%',
      render: (a) => (
        <T as="div" title={a.usedBy.join(', ')} className={`text-[13px] truncate ${a.usedBy.length === 0 ? 'text-text-tertiary' : 'text-text-secondary'}`}>
          {a.usedBy.length ? `${a.usedBy[0].replace(/^bot:/, '').replace('portal:studio', 'Studio').replace('portal:designs', 'Designs')}${a.usedBy.length > 1 ? ` +${a.usedBy.length - 1}` : ''}` : 'Not used yet'}
        </T>
      ),
    },
    { key: 'open', header: '', width: '3%', align: 'right', render: () => <span aria-hidden className="text-text-tertiary">›</span> },
  ];

  return (
    <StackedCatalogLayout
      catalogOverview title="Agent library" group="Build" basePath="/iq/library" listTitle={kind === 'all' ? 'All assets' : KIND_LABEL[kind]}
      items={[
        ...[{ value: 'all', count: undefined }, ...kindOptions].map((option) => ({
          path: `/iq/library?${new URLSearchParams({ kind: option.value, tier, status, ...(query ? { q: query } : {}) })}`,
          label: option.value === 'all' ? 'All assets' : KIND_LABEL[option.value as AssetKind],
          count: option.count, group: 'Kind', active: kind === option.value,
        })),
      ]}
      rows={assets.map((asset) => ({ id: asset.id, title: asset.name, subline: KIND_LABEL[asset.kind] }))}
      selectedId={openId} selectedTitle={assets.find((asset) => asset.id === openId)?.name}
      onSelect={setOpenId}
      railHeader={<SearchInput value={searchText} onChange={onSearchChange} placeholder="Search assets…" aria-label="Search Agent library" className="w-full" />}
      railNotice={libraryFailure ? <UnavailableNotice error={libraryFailure} what="library assets" source="Library catalog" onRetry={refresh} /> : isLoading && !data ? <EmptyState size="sm" title="Loading assets…" /> : assets.length === 0 ? <EmptyState size="sm" title="No assets in this view" /> : undefined}
    >
    {openId ? <AssetDrawer key={openId} id={openId} onOpenAsset={setOpenId} /> :
    <Stack gap="none">
    <PageHeader size="lg"
      title="Agent library"
      description="Reusable instructions and tools for your agents."
      actions={canAuthor ? <Button variant="primary" onClick={() => navigate('/iq/prompts?mode=create')}>New asset</Button> : undefined}
    />

      <Inline gap="sm" wrap align="center" className="border-t border-border py-4 mb-2" data-testid="library-filters">
        <SearchInput size="sm" value={searchText} onChange={onSearchChange} placeholder="Search assets…" aria-label="Search assets" className="w-64 max-w-full" />
        <Select size="sm" className="w-auto min-w-28" aria-label="Asset kind" value={kind} onChange={(e) => setFilter('kind', e.target.value)} options={[{ value: 'all', label: 'Kind: All' }, ...KIND_ORDER.map((value) => ({ value, label: KIND_LABEL[value] }))]} />
        <Select size="sm" className="w-auto min-w-28" aria-label="Asset tier" value={tier} onChange={(e) => setFilter('tier', e.target.value)} options={[{ value: 'all', label: 'Tier: All' }, ...TIER_ORDER.map((value) => ({ value, label: TIER_LABEL[value] }))]} />
        <Select size="sm" className="w-auto min-w-28" aria-label="Asset status" value={status} onChange={(e) => setFilter('status', e.target.value)} options={[{ value: 'all', label: 'Status: All' }, ...[...new Set(['draft', 'published', 'retired', ...(data?.assets.map((a) => a.lifecycleStatus) ?? []), ...(status === 'all' ? [] : [status])])].map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]} />
        <T className="ml-auto text-[12px] text-text-tertiary">{data ? `${assets.length} assets` : 'Loading…'}</T>
        <Link to="/iq/distillation/review?view=promotions" className="text-[13px] text-primary hover:underline">Review promotions ↗</Link>
      </Inline>

      {/* See the shared list-page loading pattern comment in QueuePage.tsx:
          the toolbar above stays mounted through every state, and the body
          fills with DataTable's own skeleton rows on first load rather than
          swapping out for a bare LoadingState (which used to drop the table
          header and shove the toolbar's own filter counts around). */}
      {libraryFailure ? (
        <UnavailableNotice
          error={libraryFailure}
          what="the library"
          source="Assets are read from the library catalog"
          onRetry={refresh}
        />
      ) : !(isLoading && !data) && emptyKind === 'filtered' ? (
        <EmptyState
          title="Nothing matches"
          description="No asset matches these facets. Clear a filter or widen the search."
          actionLabel="Clear filters"
          onAction={() => { cancelPending(); setParams(new URLSearchParams(), { replace: true }); }}
        />
      ) : !(isLoading && !data) && emptyKind === 'catalog-empty' ? (
        <EmptyState
          title="Agent library has no assets yet"
          description="Reusable assets include manually authored prompts, system prompts, evaluators and skills, plus assets reviewed in Distillation."
          action={(
            <Link to={knowledgeHref({ view: 'guides' })} className="text-[12px] font-semibold text-primary no-underline hover:underline">
              Open Distillation → Knowledge →
            </Link>
          )}
        />
      ) : (
        <DataTable<LibraryAsset>
          data={assets}
          columns={columns}
          keyField={(a) => a.id}
          onRowClick={(a) => setOpenId(a.id)}
          frameless
          pageSize={8}
          data-testid="agent-library-table"
          emptyMessage="No assets"
          loading={isLoading && !data}
        />
      )}

    </Stack>}
    </StackedCatalogLayout>
  );
}
