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
  SearchInput,
  Stack,
  type DataTableColumn, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { AssetDrawer } from './AssetDrawer';
import {
  KIND_HINT, KIND_LABEL, KIND_ORDER,
  TIER_HINT, TIER_LABEL, TIER_ORDER,
  LIBRARY_SOURCE, facetOptions, libraryEmptyKind,
} from './libraryFormat';
import type { AssetKind, AssetTier, LibraryAsset, LibraryResponse } from './types';
import { knowledgeHref } from '../distillation/distillationRoutes';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { LIBRARY_GRAMMAR, libraryTargets } from './libraryCommands';

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
  // The composer drives the same URL state as the filter row: search is `q`,
  // the one filter is Kind, `open` is the row click. `reset` (kind '') clears
  // search and Kind in ONE navigation so the two writes cannot race.
  const commandKind = (value: string) => {
    if (value) { setFilter('kind', value); return; }
    cancelPending();
    const next = new URLSearchParams(params);
    next.delete('nav'); next.delete('kind'); next.delete('q');
    navigate(`/iq/library?${next}`);
  };
  const adapter = collectionCommandAdapter(LIBRARY_GRAMMAR, {
    setQuery: (value) => { cancelPending(); setQuery(value); }, setFilter: commandKind, refresh,
    label: 'Agent library', id: 'agent-library-commands',
    scopeNote: 'Commands search the library, pick a Kind and open one asset; Tier and Status stay in the filter row, and nothing edits, promotes or retires an asset.',
    open: (target) => {
      const asset = resolveCollectionTarget(target, libraryTargets(assets));
      setOpenId(asset.id);
      return `Opening ${asset.title}.`;
    },
  });
  const kindOptions = useMemo(() => facetOptions(data?.facets.kind ?? {}, KIND_ORDER), [data]);

  const columns: DataTableColumn<LibraryAsset>[] = [
    {
      key: 'name', header: 'Asset', width: '44%', sortable: true,
      // One line (docs/layout-cascade.md "Tables"): the mark, the name and a
      // draft chip. The description is the cell's title and the asset detail;
      // the row itself is the control — DataTable rows with onRowClick are
      // focusable and open on Enter/Space, so no text Button sits in the cell.
      render: (a) => (
        <Inline gap="sm" wrap={false} align="center" className="min-w-0" title={a.description ? `${a.name} — ${a.description}` : a.name}>
          <FileKindMark kind={a.kind === 'skill' || a.kind === 'evaluator' ? 'workflow' : 'page'} size="md" variant="glyph" />
          <T as="div" size="sm" tone="primary" className="block min-w-0 truncate">{a.name}</T>
          {a.lifecycleStatus === 'draft' && <Chip tone="neutral" size="xs">draft</Chip>}
        </Inline>
      ),
    },
    {
      key: 'kind', header: 'Kind', width: '12%', sortable: true,
      // Narrow columns at 900px: one line, cut with an ellipsis (the hint is the title).
      render: (a) => <T as="div" size="sm" tone="secondary" className="block truncate" title={`${KIND_LABEL[a.kind]} — ${KIND_HINT[a.kind]}`}>{KIND_LABEL[a.kind]}</T>,
    },
    {
      key: 'tier', header: 'Tier', width: '12%', sortable: true,
      render: (a) => <T as="div" size="sm" tone="secondary" className="block truncate" title={`${TIER_LABEL[a.tier]} — ${TIER_HINT[a.tier]}`}>{TIER_LABEL[a.tier]}</T>,
    },
    {
      key: 'contract', header: 'Inputs', width: '12%',
      render: (a) => {
        const inputs = a.contract.variables.length ? `${a.contract.variables.length} variable${a.contract.variables.length === 1 ? '' : 's'}` : 'None';
        return <T as="div" size="sm" tone="secondary" className="block truncate" title={inputs}>{inputs}</T>;
      },
    },
    {
      key: 'usedBy', header: 'Used by', width: '17%',
      render: (a) => (
        <T as="div" title={a.usedBy.join(', ')} size="sm" tone={a.usedBy.length === 0 ? 'tertiary' : 'secondary'} className="block truncate">
          {a.usedBy.length ? `${a.usedBy[0].replace(/^bot:/, '').replace('portal:studio', 'Studio').replace('portal:designs', 'Designs')}${a.usedBy.length > 1 ? ` +${a.usedBy.length - 1}` : ''}` : 'Not used yet'}
        </T>
      ),
    },
    { key: 'open', header: '', width: '3%', align: 'right', render: () => <T aria-hidden className="inline-flex text-text-tertiary">›</T> },
  ];

  return (
    <StackedCatalogLayout
      catalogOverview title="Agent library" group="Build" basePath="/iq/library" listTitle={kind === 'all' ? 'All assets' : KIND_LABEL[kind]}
      overviewDescription="Reusable instructions and tools for your agents."
      overviewActions={canAuthor ? <Button variant="primary" size="sm" onClick={() => navigate('/iq/prompts?mode=create')}>New asset</Button> : undefined}
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
      footer={openId ? <CollectionCommandHost adapter={adapter} /> : undefined}
      railHeader={<SearchInput value={searchText} onChange={onSearchChange} placeholder="Search assets…" aria-label="Search Agent library" className="w-full" />}
      railNotice={libraryFailure ? <UnavailableNotice error={libraryFailure} what="library assets" source={LIBRARY_SOURCE} onRetry={refresh} /> : isLoading && !data ? <EmptyState title="Loading assets…" /> : assets.length === 0 ? <EmptyState title="No assets in this view" /> : undefined}
    >
    {openId ? <AssetDrawer key={openId} id={openId} onOpenAsset={setOpenId} onBack={() => setOpenId(null)} /> :
    // The overview owns the table's command input; the input docks at the
    // bottom of the content column (CollectionCommandHost → ColumnDock).
    <Stack gap="none" className="min-w-0">

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
          source={LIBRARY_SOURCE}
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

      <CollectionCommandHost adapter={adapter} />
    </Stack>}
    </StackedCatalogLayout>
  );
}
