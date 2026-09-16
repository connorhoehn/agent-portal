// Distillation → Artifacts. The L2 catalog — the only place a person can
// actually see a runbook or insight the fleet distilled, check it against
// its evidence, and follow it into the Library item it became. Everything
// downstream of "L2 artifacts — 40" being a bare number on the old page
// starts here.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button, Chip, DataTable, Drawer, EmptyState, FilterChip, MetaLine, PageSection, SearchInput, Stack,
  Toolbar, ToolbarGroup, ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { useUrlState } from '../../lib/useUrlState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { relativeTime } from '../../lib/relativeTime';
import { ArtifactDrawerBody } from './ArtifactDrawer';
import { T } from './Text';
import {
  ARTIFACT_STATUS_LABEL, ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE,
  artifactFactCount, evidenceLabel,
} from './distillationFormat';
import type { Artifact, ArtifactsResponse, ArtifactStatus, ArtifactType } from './types';

const TYPE_FILTERS: Array<{ value: ArtifactType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'runbook', label: 'Runbook' },
  { value: 'insight', label: 'Insight' },
  { value: 'convention', label: 'Convention' },
  { value: 'decision', label: 'Decision' },
  { value: 'procedure', label: 'Procedure' },
];

const STATUS_FILTERS: Array<{ value: ArtifactStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'retired', label: 'Retired' },
];

// Same cadence TiersPage.tsx set for this exact pattern.
const SEARCH_DEBOUNCE_MS = 250;

export default function DistillationArtifactsPage() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') ?? 'all') as ArtifactType | 'all';
  const status = (params.get('status') ?? 'all') as ArtifactStatus | 'all';
  // `query` drives the client-side title/summary filter below; the box
  // shows `searchText` and only commits to `query` (so only re-runs the
  // filter, and re-renders the list) `SEARCH_DEBOUNCE_MS` after typing stops.
  const [query, setQuery] = useState('');
  const { searchText, onSearchChange, cancelPending } = useDebouncedSearch(query, setQuery, SEARCH_DEBOUNCE_MS);
  // `?open=<id>` is the single source of truth for the drawer — the
  // Overview's repertoire rows land here with it already set, a row click
  // now WRITES it (it used to only be read on mount, so a click opened the
  // drawer without ever touching the URL — a reload or a copied link
  // silently lost it), and closing deletes it so a reload does not reopen a
  // drawer the reader already dismissed.
  const [openId, setOpenId] = useUrlState<string | null>(
    'open',
    (raw) => raw,
    (v) => v,
  );
  const closeDrawer = () => setOpenId(null);

  const setFacet = (key: 'type' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key); else next.set(key, value);
    // A facet change is a new list; the drawer that a deep link opened does
    // not survive it, and neither does the `open` param — otherwise the
    // drawer vanished when the filter dropped its artifact and popped back
    // unasked when the filter brought it back.
    next.delete('open');
    setParams(next, { replace: true });
  };

  // The route validates `type`/`status` against the enums and 400s on
  // anything else — "all" is the page's filter state, not a wire value, so
  // it is omitted rather than sent.
  const qs = new URLSearchParams();
  if (type !== 'all') qs.set('type', type);
  if (status !== 'all') qs.set('status', status);
  const url = `/api/distillation/artifacts${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const { data, isLoading, error, refresh } = useFetch<ArtifactsResponse>(url, 60_000);

  const artifacts = useMemo(() => {
    const all = data?.artifacts ?? [];
    if (!query.trim()) return all;
    const q = query.trim().toLowerCase();
    return all.filter((a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q));
  }, [data, query]);

  const open = artifacts.find((a) => a.id === openId) ?? data?.artifacts.find((a) => a.id === openId) ?? null;

  // Five columns, not seven: at 1440px the prior "Facts"/"Last compaction"
  // columns pushed the wrapper's scrollWidth (1467) past its clientWidth
  // (924), forcing the table's own horizontal scroll on every laptop-width
  // view (defect #5). Both move into a MetaLine under the title/summary
  // instead — evidence count and last-compaction time are still visible on
  // every row, just not as their own columns — and the type/status chips,
  // the Library link, and the clusters count (the columns worth sorting or
  // scanning as a column) stay.
  //
  // Reopened defect #5: `DataTableColumn.width` only styles the `<th>` — the
  // table has no `table-fixed`/`colgroup`, so with auto layout the browser
  // still sizes each column to its widest CELL content, and an untruncated
  // title/summary is that widest content. `truncate` alone doesn't help
  // without a width to truncate AGAINST, so the title column itself must
  // cap the pixel width of its rendered content, not just declare a `<th>`
  // hint. Budget at the audited 924px wrapper (1440px viewport): Type 92 +
  // Status 112 + Library 108 + Clusters 76 = 388px fixed, leaving the title
  // column capped at 460px (848px total, 76px of margin for table borders
  // and layout rounding).
  const TITLE_MAX = 'max-w-[460px]';
  const columns: DataTableColumn<Artifact>[] = [
    {
      key: 'title', header: 'Artifact', sortable: true,
      getFilterText: (a) => `${a.title} ${a.summary}`,
      render: (a) => (
        <Stack gap="none" className={`min-w-0 ${TITLE_MAX}`}>
          {/* A real Button, not just the row's onClick: DataTable's row-click
              is a bare <tr onClick> with no tabIndex/keydown/role, so a
              keyboard user tabbing through the filter bar skipped straight
              past every row with no way to open one (defect #13,
              org-leader/DEFECTS.md #13). This is the row's one focusable,
              Enter/Space-activatable control; the row click stays as a
              mouse convenience alongside it — same pattern as
              `library/LibraryPage.tsx` and `promotions/PromotionsPage.tsx`. */}
          <Button
            variant="ghost"
            size="sm"
            className={`block truncate ${TITLE_MAX} justify-start border-none bg-transparent p-0 text-left text-[13px] font-semibold text-text-primary hover:bg-transparent hover:underline`}
            title={a.title}
            onClick={(e) => { e.stopPropagation(); setOpenId(a.id); }}
          >
            {a.title}
          </Button>
          <T className={`block truncate ${TITLE_MAX} text-[11px] text-text-tertiary`} title={a.summary}>{a.summary}</T>
          <MetaLine
            size="xs"
            className={TITLE_MAX}
            items={[evidenceLabel(artifactFactCount(a)), `updated ${relativeTime(a.updated_at)}`]}
          />
        </Stack>
      ),
    },
    {
      key: 'type', header: 'Type', sortable: true, width: '92px',
      render: (a) => <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>,
    },
    {
      key: 'status', header: 'Status', sortable: true, width: '112px',
      render: (a) => <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs" dot="static">{ARTIFACT_STATUS_LABEL[a.status]}</Chip>,
    },
    {
      key: 'library', header: 'Library', width: '108px',
      render: (a) => a.library_item_id
        ? <Link to={`/iq/library/${encodeURIComponent(a.library_item_id)}`} className="text-primary no-underline hover:underline">Open →</Link>
        : <T className="text-[11px] text-text-tertiary">not published</T>,
    },
    {
      key: 'clusters', header: 'Clusters', align: 'right', width: '76px',
      compare: (a, b) => a.cluster_ids.length - b.cluster_ids.length,
      render: (a) => <T className="tabular-nums text-[12px] text-text-secondary">{a.cluster_ids.length}</T>,
    },
  ];

  return (
    <PageSection
      title="Artifacts"
      description="L2 artifacts with their clusters, evidence and the Library item each became."
    >
      <Toolbar size="md" wrap aria-label="Artifact filters">
        <ToolbarGroup aria-label="Type">
          <ToolbarLabel>Type</ToolbarLabel>
          {TYPE_FILTERS.map((f) => (
            <FilterChip key={f.value} active={type === f.value} onClick={() => setFacet('type', f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Status">
          <ToolbarLabel>Status</ToolbarLabel>
          {STATUS_FILTERS.map((f) => (
            <FilterChip key={f.value} active={status === f.value} onClick={() => setFacet('status', f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Search">
          <SearchInput
            value={searchText}
            onChange={onSearchChange}
            placeholder="Title or summary…"
            aria-label="Search artifacts"
            className="w-[220px]"
          />
        </ToolbarGroup>
      </Toolbar>

      {/* See the shared list-page loading pattern comment in QueuePage.tsx. */}
      {error ? (
        <UnavailableNotice error={error} what="artifacts" source="Artifacts are read from Aurora" onRetry={refresh} className="mb-4" />
      ) : !(isLoading && !data) && artifacts.length === 0 ? (
        (() => {
          const filtersActive = type !== 'all' || status !== 'all' || query.trim().length > 0;
          return (
            <EmptyState
              title={filtersActive ? 'No matches' : 'No artifacts yet'}
              description={filtersActive
                ? 'No artifact matches these filters.'
                : 'An artifact is an L2 runbook, insight or convention the fleet distilled and published to the Library. Compact L1 clusters to produce the first one.'}
              actionLabel={filtersActive ? 'Clear filters' : undefined}
              onAction={filtersActive
                ? () => { cancelPending(); setParams(new URLSearchParams(), { replace: true }); setQuery(''); }
                : undefined}
            />
          );
        })()
      ) : (
        <DataTable<Artifact>
          data={artifacts}
          columns={columns}
          keyField={(a) => a.id}
          onRowClick={(a) => setOpenId(a.id)}
          pageSize={25}
          emptyMessage="No artifacts"
          loading={isLoading && !data}
        />
      )}

      <Drawer open={open != null} onClose={closeDrawer} aria-label="Artifact detail" width={720}>
        {open && <ArtifactDrawerBody artifact={open} />}
      </Drawer>
    </PageSection>
  );
}
