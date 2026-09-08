// Shared list for one level's items — `GET /api/distillation/items?level=`,
// paged with a cursor ("Load more") rather than DataTable's client-side
// pageSize, since the contract is a server cursor, not a fixed page. Each
// row is a full, level-discriminated `Item` (Observation/Cluster/Artifact —
// there is no separate summary shape), so the row renderer switches on
// `level` rather than reading one flat set of fields. Used by the Tiers page
// (one instance per selected level) and reusable wherever a filtered item
// feed is needed later.
//
// `repo`/`initiativeId`/`q` are server params (GET /items has no other
// facets); `kind` has no server param at all, so it filters whatever page is
// already loaded, client-side, via `filterByObservationKind` — see
// distillationFormat.ts. That means "Load more" can still surface further
// matches even while the currently-loaded page shows none, so the button
// stays keyed off the server cursor, not the filtered count.
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, EmptyState, Inline, LoadingState, Stack } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { T } from './Text';
import {
  ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, OBSERVATION_KIND_TONE,
  filterByObservationKind, filtersSummaryLabel, hasActiveFilters, itemsQueryParams,
} from './distillationFormat';
import type { Item, ItemsResponse, Level, ObservationKind } from './types';

export interface ItemsListProps {
  level: Level;
  repo?: string;
  initiativeId?: string;
  /** L0/L1 only — client-side filter, see module comment. */
  kind?: ObservationKind | '';
  q?: string;
  /** Reports how many rows are actually rendered (post kind-filter), so the
   *  Tiers page can show "N of M shown" on the level card once a filter is
   *  active. */
  onVisibleCountChange?: (count: number) => void;
  /** Present only when at least one filter is active — the empty state's
   *  "Clear filters" action. */
  onClearFilters?: () => void;
}

function buildSearchParams(props: ItemsListProps, cursor?: string): URLSearchParams {
  return new URLSearchParams(itemsQueryParams({
    level: props.level, repo: props.repo, initiativeId: props.initiativeId, q: props.q, cursor,
  }));
}

export function ItemsList(props: ItemsListProps) {
  const { level, repo, initiativeId, kind, q, onVisibleCountChange, onClearFilters } = props;
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setItems([]); setCursor(null);
    void (async () => {
      try {
        const res = await fetch(`/api/distillation/items?${buildSearchParams({ level, repo, initiativeId, q }).toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = await res.json() as ItemsResponse;
        if (cancelled) return;
        setItems(body.items ?? []);
        setCursor(body.next_cursor ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Fetch failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [level, repo, initiativeId, q]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/distillation/items?${buildSearchParams({ level, repo, initiativeId, q }, cursor).toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json() as ItemsResponse;
      setItems((prev) => [...prev, ...(body.items ?? [])]);
      setCursor(body.next_cursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setLoadingMore(false);
    }
  }

  const filteredItems = useMemo(() => filterByObservationKind(items, kind), [items, kind]);

  useEffect(() => {
    onVisibleCountChange?.(filteredItems.length);
  }, [filteredItems.length, onVisibleCountChange]);

  if (error) return <EmptyState title="Could not load items" description={error} />;
  if (loading) return <LoadingState label={`Loading ${level} items…`} />;

  const filters = { repo, initiativeId, kind, q };
  const filtersActive = hasActiveFilters(filters);

  if (filteredItems.length === 0) {
    return (
      <Stack gap="sm">
        <EmptyState
          title="No items"
          description={filtersActive
            ? `No ${level} items match ${filtersSummaryLabel(filters)}.`
            : `No ${level} items yet.`}
          actionLabel={filtersActive && onClearFilters ? 'Clear filters' : undefined}
          onAction={filtersActive && onClearFilters ? onClearFilters : undefined}
        />
        {cursor && (
          <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      {filteredItems.map((it) => <ItemRow key={it.id} item={it} />)}
      {cursor && (
        <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </Stack>
  );
}

function ItemRow({ item }: { item: Item }) {
  if (item.level === 'L0') {
    return (
      <Card padding="sm">
        <Inline gap="sm" wrap={false} align="center">
          <Chip tone={OBSERVATION_KIND_TONE[item.kind]} size="xs">{item.kind}</Chip>
          <T className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary" title={item.title}>{item.title}</T>
          <T className="shrink-0 font-mono text-[10px] text-text-tertiary">{item.repo}</T>
          <T className="shrink-0 whitespace-nowrap text-[11px] text-text-tertiary">{relativeTime(item.created_at)}</T>
        </Inline>
      </Card>
    );
  }
  if (item.level === 'L1') {
    return (
      <Card padding="sm">
        <Inline gap="sm" wrap={false} align="center">
          <Chip tone={OBSERVATION_KIND_TONE[item.kind]} size="xs">{item.kind}</Chip>
          <T className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary" title={item.title}>{item.title}</T>
          <T className="shrink-0 text-[11px] text-text-tertiary">{item.member_observation_ids.length} obs</T>
          <T className="shrink-0 whitespace-nowrap text-[11px] text-text-tertiary">{relativeTime(item.updated_at)}</T>
        </Inline>
      </Card>
    );
  }
  return (
    <Card padding="sm">
      <Inline gap="sm" wrap={false} align="center">
        <Chip tone={ARTIFACT_TYPE_TONE[item.type]} size="xs">{ARTIFACT_TYPE_LABEL[item.type]}</Chip>
        <Chip tone={ARTIFACT_STATUS_TONE[item.status]} size="xs" dot="static">{item.status}</Chip>
        <T className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary" title={item.title}>{item.title}</T>
        <T className="shrink-0 whitespace-nowrap text-[11px] text-text-tertiary">{relativeTime(item.updated_at)}</T>
      </Inline>
    </Card>
  );
}
