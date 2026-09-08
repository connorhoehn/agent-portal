// Distillation → Tiers. The three level cards, but as doors rather than a
// static summary: pick L0/L1/L2 and the same page shows that level's items
// underneath, via `?level=` so a chosen tier is a shareable link like the
// Library's facets are. Filters (repo/initiative/kind/q) live in the same
// URL — `?level=&repo=&initiative=&kind=&q=` — so a card click, a filter
// pick, and a reload all keep state (defect #2).
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Chip, DetailSection, EmptyState, Inline, LoadingState, PageSection, SegmentedControl,
  SearchInput, Select, Stack, Toolbar, ToolbarGroup, ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { ItemsList } from './ItemsList';
import { T } from './Text';
import {
  LEVEL_HEALTH_TONE, LEVEL_MEANING, bytesLabel, hasActiveFilters, itemsShownLabel, lagLabel,
} from './distillationFormat';
import type { Level, LevelsResponse, ObservationKind } from './types';

const DOOR_LABEL: Record<Level, string> = { L0: 'Observations', L1: 'Clusters', L2: 'Artifacts' };

// GET /api/distillation/items has no distinct-values facet endpoint, so
// these are hardcoded from the mock corpus itself
// (middleware/src/mock/distillation.ts `REPO`/`INITIATIVE`) — the same four
// repos/initiatives every observation, cluster, and artifact in the mock
// carries.
const REPO_OPTIONS = [
  { value: '', label: 'All repos' },
  { value: 'connorhoehnslalom/orgiq-observability', label: 'orgiq-observability' },
  { value: 'connorhoehnslalom/orgiq-auth-service', label: 'orgiq-auth-service' },
  { value: 'connorhoehnslalom/orgiq-llm-platform', label: 'orgiq-llm-platform' },
  { value: 'connorhoehnslalom/orgiq-finops', label: 'orgiq-finops' },
];

const INITIATIVE_OPTIONS = [
  { value: '', label: 'All initiatives' },
  { value: 'p-observability', label: 'p-observability' },
  { value: 'p-auth-migration', label: 'p-auth-migration' },
  { value: 'p-llm-platform', label: 'p-llm-platform' },
  { value: 'p-cost-opt', label: 'p-cost-opt' },
];

const KIND_OPTIONS: Array<{ value: ObservationKind | ''; label: string }> = [
  { value: '', label: 'All kinds' },
  { value: 'worked', label: 'Worked' },
  { value: 'failed', label: 'Failed' },
  { value: 'gotcha', label: 'Gotcha' },
  { value: 'decision', label: 'Decision' },
  { value: 'convention', label: 'Convention' },
];

const SEARCH_DEBOUNCE_MS = 250;

export default function DistillationTiersPage() {
  const [params, setParams] = useSearchParams();
  const level = ((['L0', 'L1', 'L2'] as const).includes(params.get('level') as Level) ? params.get('level') : 'L0') as Level;
  const repo = params.get('repo') ?? '';
  const initiativeId = params.get('initiative') ?? '';
  // Kind is an L0-only control (Cluster also carries `kind`, but the spec
  // scopes this filter to observations) — dropped from the read whenever
  // another level is active so a stale `?kind=` from an earlier L0 visit
  // can't silently keep filtering L1/L2 lists it was never shown against.
  const kind = (level === 'L0' ? (params.get('kind') ?? '') : '') as ObservationKind | '';
  const q = params.get('q') ?? '';

  const [searchText, setSearchText] = useState(q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visibleCount, setVisibleCount] = useState(0);

  // Keep the box in sync when `q` changes from outside typing (Clear
  // filters, back/forward navigation) without fighting the debounce timer.
  useEffect(() => { setSearchText(q); }, [q]);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  const { data, isLoading, error } = useFetch<LevelsResponse>('/api/distillation/levels', 20_000);
  const levels = data?.levels ?? [];
  const health = data?.health ?? [];

  function setFilter(key: 'level' | 'repo' | 'initiative' | 'kind' | 'q', value: string) {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key); else next.set(key, value);
    if (key === 'level' && value !== 'L0') next.delete('kind');
    setParams(next, { replace: true });
  }

  function handleSearchChange(value: string) {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setFilter('q', value), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearchText('');
    const next = new URLSearchParams();
    next.set('level', level);
    setParams(next, { replace: true });
  }

  const filters = { repo, initiativeId, kind, q };
  const filtersActive = hasActiveFilters(filters);

  return (
    <PageSection
      title="Tiers"
      description="L0 raw observations → L1 deduped clusters → L2 stable artifacts. Pick a level to see what is in it."
    >
      {error ? (
        <EmptyState title="Could not load level state" description={error} />
      ) : isLoading && !data ? (
        <LoadingState label="Loading levels…" />
      ) : (
        // One compact row, not three stacked cards: the list is the page, and
        // it has to start above the fold. The segmented control is the door
        // (level + count), the chips are each level's health, and the active
        // level's meaning is a single line beside them.
        <Inline gap="md" align="center" wrap>
          <SegmentedControl
            size="sm"
            value={level}
            onChange={(v) => setFilter('level', v)}
            options={(['L0', 'L1', 'L2'] as const).map((lvl) => {
              const lvlState = levels.find((l) => l.level === lvl);
              return { value: lvl, label: lvlState ? `${lvl} · ${lvlState.items}` : lvl };
            })}
          />
          <Inline gap="xs" align="center">
            {(['L0', 'L1', 'L2'] as const).map((lvl) => {
              const h = health.find((x) => x.level === lvl);
              return h ? <Chip key={lvl} tone={LEVEL_HEALTH_TONE[h.status]} size="xs" dot="static">{lvl} {h.status}</Chip> : null;
            })}
          </Inline>
          <T className="text-[12px] text-text-tertiary">
            {DOOR_LABEL[level]} — {LEVEL_MEANING[level]}
            {(() => {
              const lvlState = levels.find((l) => l.level === level);
              if (!lvlState) return null;
              return ` · ${filtersActive ? itemsShownLabel(visibleCount, lvlState.items) : `${lvlState.items} items · ${bytesLabel(lvlState.sizeBytes)} · lag ${lagLabel(lvlState.lagSeconds)}`}`;
            })()}
          </T>
        </Inline>
      )}

      <DetailSection title={`${level} — ${DOOR_LABEL[level]}`} hint="Load more to page through the rest">
        <Stack gap="sm">
          <Toolbar size="md" aria-label="Item filters">
            <ToolbarGroup aria-label="Repo">
              <ToolbarLabel>Repo</ToolbarLabel>
              <Select
                size="sm"
                aria-label="Repo"
                value={repo}
                onChange={(e) => setFilter('repo', e.target.value)}
                options={REPO_OPTIONS}
              />
            </ToolbarGroup>
            <ToolbarGroup divided aria-label="Initiative">
              <ToolbarLabel>Initiative</ToolbarLabel>
              <Select
                size="sm"
                aria-label="Initiative"
                value={initiativeId}
                onChange={(e) => setFilter('initiative', e.target.value)}
                options={INITIATIVE_OPTIONS}
              />
            </ToolbarGroup>
            {level === 'L0' && (
              <ToolbarGroup divided aria-label="Kind">
                <ToolbarLabel>Kind</ToolbarLabel>
                <Select
                  size="sm"
                  aria-label="Kind"
                  value={kind}
                  onChange={(e) => setFilter('kind', e.target.value)}
                  options={KIND_OPTIONS}
                />
              </ToolbarGroup>
            )}
            <ToolbarGroup divided aria-label="Search">
              <SearchInput
                value={searchText}
                onChange={handleSearchChange}
                onClear={() => setFilter('q', '')}
                placeholder="Search title or body…"
                aria-label="Search items"
                className="w-[220px]"
              />
            </ToolbarGroup>
          </Toolbar>

          <ItemsList
            level={level}
            repo={repo || undefined}
            initiativeId={initiativeId || undefined}
            kind={kind || undefined}
            q={q || undefined}
            onVisibleCountChange={setVisibleCount}
            onClearFilters={filtersActive ? clearFilters : undefined}
          />
        </Stack>
      </DetailSection>
    </PageSection>
  );
}
