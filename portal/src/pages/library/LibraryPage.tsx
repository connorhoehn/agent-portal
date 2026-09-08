// Design → Library. One catalog for everything the fleet is instructed by.
//
// This replaces "Overview" as the front door, and it is deliberately ONE page
// rather than a prompt browser plus a skill browser: a skill and a prompt
// differ in who invokes them, which is a facet, not a separate product. Filter
// to kind=skill and this IS the skill browser — same search, same detail, same
// provenance panel.
//
// Selecting an asset opens a drawer rather than a route, because the question
// "what does this take and where did it come from" is asked while scanning the
// list, not instead of it.

import { useMemo, useState, useEffect } from 'react';
import { useSearchParams, useParams } from 'react-router';
import {
  Button,
  Chip,
  DataTable,
  Drawer,
  EmptyState,
  FilterChip,
  Inline,
  LoadingState,
  PageSection,
  SearchInput,
  Stack,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { AssetDrawer } from './AssetDrawer';
import { T } from './Text';
import {
  KIND_HINT, KIND_LABEL, KIND_ORDER, KIND_TONE,
  TIER_HINT, TIER_LABEL, TIER_ORDER, TIER_TONE,
  contractLine, evalLabel, facetOptions, usageLine,
} from './libraryFormat';
import type { AssetKind, AssetTier, LibraryAsset, LibraryResponse } from './types';

export default function LibraryPage() {
  // Facets live in the URL so a filtered library is a shareable link — "the
  // security evaluators" is a thing people send each other.
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') ?? 'all') as AssetKind | 'all';
  const tier = (params.get('tier') ?? 'all') as AssetTier | 'all';
  const [query, setQuery] = useState('');
  // /iq/library/:assetId opens that asset's drawer on load and follows the
  // URL when it changes (a link from Distillation → Artifacts lands here).
  const { assetId: routeAssetId } = useParams<{ assetId?: string }>();
  const [openId, setOpenId] = useState<string | null>(routeAssetId ?? null);
  useEffect(() => { if (routeAssetId) setOpenId(routeAssetId); }, [routeAssetId]);

  const setFacet = (key: 'kind' | 'tier', value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  const url = `/api/library?kind=${kind}&tier=${tier}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const { data, isLoading, error } = useFetch<LibraryResponse>(url, 60_000);

  const assets = useMemo(() => data?.assets ?? [], [data]);
  const kindOptions = useMemo(() => facetOptions(data?.facets.kind ?? {}, KIND_ORDER), [data]);
  const tierOptions = useMemo(() => facetOptions(data?.facets.tier ?? {}, TIER_ORDER), [data]);

  const columns: DataTableColumn<LibraryAsset>[] = [
    {
      key: 'name', header: 'Asset', sortable: true,
      render: (a) => (
        <Stack gap="none" className="min-w-0">
          <Inline gap="xs" wrap={false} className="items-center gap-2 min-w-0">
            {/* A real Button, not just the row's onClick: DataTable's row-click
                is a bare <tr onClick> with no tabIndex/keydown handling, so a
                keyboard user tabbing through the filter bar would otherwise
                skip straight past every row with no way to open one. This is
                the row's one focusable, Enter/Space-activatable control; the
                row click stays as a mouse convenience alongside it. */}
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
          {/* The description is the load-bearing field for a skill — it is all
              the model sees until the skill activates — so it is shown, not
              truncated away. */}
          <T as="div" className="text-[11px] text-text-tertiary truncate" title={a.description}>{a.description}</T>
        </Stack>
      ),
    },
    {
      key: 'kind', header: 'Kind', sortable: true,
      render: (a) => <Chip tone={KIND_TONE[a.kind]} size="xs" title={KIND_HINT[a.kind]}>{KIND_LABEL[a.kind]}</Chip>,
    },
    {
      key: 'tier', header: 'Tier', sortable: true,
      render: (a) => <Chip tone={TIER_TONE[a.tier]} size="xs" title={TIER_HINT[a.tier]}>{TIER_LABEL[a.tier]}</Chip>,
    },
    {
      key: 'contract', header: 'Takes',
      render: (a) => {
        const line = contractLine(a);
        return line
          ? <T className="text-[11px] text-text-secondary whitespace-nowrap">{line}</T>
          : <T className="text-[11px] text-text-tertiary">no inputs</T>;
      },
    },
    {
      key: 'usedBy', header: 'Used by',
      render: (a) => (
        <T className={`text-[11px] whitespace-nowrap ${a.usedBy.length === 0 ? 'text-text-tertiary' : 'text-text-secondary'}`}>
          {usageLine(a)}
        </T>
      ),
    },
    {
      key: 'evalPassRate', header: 'Eval', align: 'right', sortable: true,
      compare: (a, b) => (a.evalPassRate ?? -1) - (b.evalPassRate ?? -1),
      render: (a) => (
        <T className={`w-full justify-end text-[11px] whitespace-nowrap tabular-nums ${
          a.evalPassRate == null ? 'text-text-tertiary'
            : a.evalPassRate < 0.8 ? 'text-danger' : 'text-text-secondary'}`}>
          {evalLabel(a.evalPassRate)}
        </T>
      ),
    },
    {
      key: 'updatedAt', header: 'Updated', align: 'right', sortable: true,
      compare: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (a) => <T className="w-full justify-end text-[11px] text-text-tertiary whitespace-nowrap">{relativeTime(a.updatedAt)}</T>,
    },
  ];

  return (
    <PageSection
      title="Library"
      description="Everything the fleet is instructed by, in one catalog: agent system prompts, prompts a person runs, evaluators a pipeline calls with no human in it, skills the model discovers for itself, and insights injected as fact."
    >
      <Toolbar size="md" aria-label="Library filters">
        <ToolbarGroup aria-label="Kind">
          <ToolbarLabel>Kind</ToolbarLabel>
          <FilterChip active={kind === 'all'} onClick={() => setFacet('kind', 'all')} size="sm">All</FilterChip>
          {kindOptions.map((o) => (
            <FilterChip
              key={o.value}
              active={kind === o.value}
              onClick={() => setFacet('kind', o.value)}
              size="sm"
            >
              {KIND_LABEL[o.value]} {o.count}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Tier">
          <ToolbarLabel>Tier</ToolbarLabel>
          <FilterChip active={tier === 'all'} onClick={() => setFacet('tier', 'all')} size="sm">All</FilterChip>
          {tierOptions.map((o) => (
            <FilterChip
              key={o.value}
              active={tier === o.value}
              onClick={() => setFacet('tier', o.value)}
              size="sm"
            >
              {TIER_LABEL[o.value]} {o.count}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Name, description, tag, owner…"
            aria-label="Search the library"
            className="w-[220px]"
            inputClassName="h-7 text-[12px]"
          />
        </ToolbarGroup>
      </Toolbar>

      {/* The hint that teaches the taxonomy: when a kind is selected, say what
          that kind MEANS rather than assuming the word carries it. */}
      {kind !== 'all' && (
        <T as="div" wrap className="mb-2 text-[11px] text-text-tertiary">
          <T className="font-semibold text-text-secondary">{KIND_LABEL[kind]}</T> — {KIND_HINT[kind]}
        </T>
      )}

      {error ? (
        <EmptyState title="Could not load the library" description={error} />
      ) : isLoading && !data ? (
        <LoadingState label="Loading the library…" />
      ) : assets.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="No asset matches these facets. Clear a filter or widen the search."
          actionLabel="Clear filters"
          onAction={() => { setParams(new URLSearchParams(), { replace: true }); setQuery(''); }}
        />
      ) : (
        <DataTable<LibraryAsset>
          data={assets}
          columns={columns}
          keyField={(a) => a.id}
          onRowClick={(a) => setOpenId(a.id)}
          pageSize={25}
          emptyMessage="No assets"
        />
      )}

      <Drawer
        open={openId != null}
        onClose={() => setOpenId(null)}
        aria-label="Asset detail"
        width={720}
      >
        {openId && <AssetDrawer id={openId} onOpenAsset={setOpenId} />}
      </Drawer>
    </PageSection>
  );
}
