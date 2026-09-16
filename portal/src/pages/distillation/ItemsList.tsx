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
import {
  Button, Card, Chip, DotMeter, EmptyState, Inline, LoadingState, Stack, StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { T } from './Text';
import {
  ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, OBSERVATION_KIND_TONE,
  filterByObservationKind, filtersSummaryLabel, hasActiveFilters, isRecentlyLanded, itemsQueryParams,
} from './distillationFormat';
import type { Item, ItemsResponse, Level, ObservationKind } from './types';

// Matches the mock's own per-minute ingest tick
// (docs/distillation-concept-audit-2026-09-16.md §2) — inside this window,
// an L0 row's "Landed" cell is the ingest simulator's own heartbeat, not a
// proxy for it.
const LANDED_WINDOW_MS = 60_000;
/** How often the "Landed" dot's age is re-checked. No network — this only
 *  decays a pulse back to a relative-time label once a row ages out of the
 *  window; the underlying data still refreshes on its own poll/filter cadence. */
const LANDED_TICK_MS = 5_000;

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
  // Ticks so a "Landed" pulse decays to its relative-time label once an L0
  // row ages out of the window, without a network refetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), LANDED_TICK_MS);
    return () => clearInterval(id);
  }, []);

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
      {filteredItems.map((it) => <ItemRow key={it.id} item={it} nowMs={nowMs} />)}
      {cursor && (
        <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </Stack>
  );
}

function ItemRow({ item, nowMs }: { item: Item; nowMs: number }) {
  if (item.level === 'L0') {
    // "Landed" — the ingest simulator's own per-minute heartbeat, shown
    // live rather than as a static timestamp once it's fresh.
    const landed = isRecentlyLanded(item.created_at, nowMs, LANDED_WINDOW_MS);
    return (
      <Card padding="sm">
        <Inline gap="sm" wrap={false} align="center">
          <Chip tone={OBSERVATION_KIND_TONE[item.kind]} size="xs">{item.kind}</Chip>
          <T className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary" title={item.title}>{item.title}</T>
          <T className="shrink-0 font-mono text-[10px] text-text-tertiary">{item.repo}</T>
          {landed ? (
            <StatusDot
              size="xs"
              pulse
              color="var(--color-success)"
              label={<T className="whitespace-nowrap text-[11px] text-text-tertiary">just landed</T>}
              title="Written by the ingest simulator within the last minute"
            />
          ) : (
            <T className="shrink-0 whitespace-nowrap text-[11px] text-text-tertiary">{relativeTime(item.created_at)}</T>
          )}
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
          {/* warnAbove disabled: DotMeter's warn tone means "spent" for a
              quota, which is backwards for confidence — higher is better
              here, so no fraction of this meter should ever read as a
              warning. */}
          <DotMeter label="confidence" value={item.confidence} segments={5} warnAbove={1.01} className="shrink-0" />
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
