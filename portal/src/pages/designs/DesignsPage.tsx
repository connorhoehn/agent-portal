// Design → Designs. The register of design reviews: every initiative's ADR
// threads — where the agents' ideation stands, which threads are waiting on a
// human, what has been ratified into the knowledge base.

import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router';
import { StackedCatalogLayout } from '../../components/shell/StackedCatalogLayout';
import DesignThreadPage from './DesignThreadPage';
import {
  Chip, CollectionToolbar, DataTable, EmptyState, Inline, LoadingState, Stack, T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useUrlState } from '../../lib/useUrlState';
import { relativeTime } from '../../lib/relativeTime';
import { DESIGNS_SOURCE, STATUS_LABEL, STATUS_TONE, filterDesigns, reviewStateLine } from './designFormat';
import type { DesignReview, DesignStatus } from './types';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { DESIGN_GRAMMAR, matchesDesign } from './designCommands';

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'awaiting_input', label: 'Needs input' },
  { value: 'proposed', label: 'Awaiting sign-off' },
  { value: 'ideating', label: 'Ideating' },
  { value: 'approved', label: 'Approved' },
];

export default function DesignsPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const initiative = searchParams.get('initiative') ?? '';
  const [filter, setFilter] = useUrlState<string>(
    'status',
    (raw) => (raw && FILTERS.some((f) => f.value === raw) ? raw : 'all'),
    (v) => (v === 'all' ? null : v),
  );

  const { data, isLoading, error, degraded, refresh } = useFetch<{ reviews: DesignReview[] }>(
    `/api/designs${initiative ? `?initiative=${encodeURIComponent(initiative)}` : ''}`, 30_000);
  const designsFailure = error ?? degraded;

  // One search state for the toolbar box and the composer.
  const [query, setQuery] = useState('');
  const reviews = useMemo(
    () => filterDesigns(data?.reviews ?? [], filter).filter((review) => matchesDesign(review, query)),
    [data, filter, query],
  );
  const openDesign = (designId: string) => navigate(`/iq/designs/${encodeURIComponent(designId)}?${searchParams}`);
  const adapter = collectionCommandAdapter(DESIGN_GRAMMAR, {
    setQuery, setFilter: (value) => setFilter(value || 'all'), refresh, id: 'designs-commands',
    scopeNote: 'Commands search the loaded design reviews, pick a Status view and open one design; they never answer, sign off or edit a design.',
    open: (target) => {
      const review = resolveCollectionTarget(target, reviews);
      openDesign(review.id);
      return `Opening ${review.title}.`;
    },
  });

  const columns: DataTableColumn<DesignReview>[] = [
    {
      key: 'title', header: 'Design', sortable: true,
      render: (r) => (
        <Inline gap="sm" wrap={false} className="min-w-0 max-w-[420px]">
          {/* A real Link, not just the row's onClick: DataTable's row-click is
              a bare <tr onClick> with no keyboard access, so this is the one
              focusable, Enter-activatable control in the row. */}
          <Link
            to={`/iq/designs/${r.id}?${searchParams}`}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-semibold text-text-primary no-underline hover:underline truncate"
          >
            {r.title}
          </Link>
          <T size="xs" tone="tertiary" className="truncate">{reviewStateLine(r)}</T>
        </Inline>
      ),
    },
    {
      key: 'orgProjectName', header: 'Initiative', sortable: true,
      render: (r) => <T size="xs" className="text-text-secondary whitespace-nowrap">{r.orgProjectName}</T>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (r) => (
        <Chip tone={STATUS_TONE[r.status as DesignStatus] ?? 'neutral'} size="sm" dot="static">
          {STATUS_LABEL[r.status as DesignStatus] ?? r.status}
        </Chip>
      ),
    },
    {
      key: 'dependsOn', header: 'Gated by', align: 'right',
      render: (r) => r.dependsOn.length > 0
        ? <T size="xs" className="text-text-tertiary whitespace-nowrap">{r.dependsOn.length} design{r.dependsOn.length === 1 ? '' : 's'}</T>
        : <T size="xs" className="text-text-tertiary">—</T>,
    },
    {
      key: 'kbSynced', header: 'KB', align: 'right',
      render: (r) => r.kbSynced
        ? <Chip tone="success" size="xs">logged</Chip>
        : <T size="xs" className="text-text-tertiary">—</T>,
    },
    {
      key: 'updatedAt', header: 'Updated', align: 'right', sortable: true,
      compare: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (r) => <T size="xs" className="text-text-tertiary whitespace-nowrap">{relativeTime(r.updatedAt)}</T>,
    },
  ];

  // The register is the catalog overview: status rail, then the table, with
  // the title in the layout's own header (one h1, aligned with its crumbs).
  // The record-list rail appears only beside an open design — the Library's
  // shape (docs/rail-parity-goal.md). Drawn on the list too, it repeated the
  // table's rows side by side and pushed the title 4px off its breadcrumb.
  return (
    <StackedCatalogLayout
      catalogOverview title="Designs" basePath="/iq/designs" listTitle={filter === 'all' ? 'All designs' : FILTERS.find((f) => f.value === filter)?.label ?? 'Designs'}
      overviewDescription="Agents restate the problem, iterate a plan, and raise questions when intent is unclear; people answer and sign off. An approved design is an ADR — logged to the knowledge base, and a gate for the designs built on it."
      items={FILTERS.map((f) => ({ path: `/iq/designs?${new URLSearchParams({ status: f.value, ...(initiative ? { initiative } : {}) })}`, label: f.label === 'All' ? 'All designs' : f.label, group: 'Status', active: filter === f.value }))}
      rows={reviews.map((review) => ({ id: review.id, title: review.title, subline: STATUS_LABEL[review.status] }))}
      selectedId={id} selectedTitle={data?.reviews.find((review) => review.id === id)?.title}
      onSelect={(next) => navigate(`/iq/designs/${encodeURIComponent(next)}?${searchParams}`)}
      footer={id ? <CollectionCommandHost inPlace adapter={adapter} /> : undefined}
      railNotice={designsFailure ? <UnavailableNotice error={designsFailure} what="designs" source={DESIGNS_SOURCE} onRetry={refresh} /> : isLoading && !data ? <LoadingState label="Loading designs…" /> : reviews.length === 0 ? <EmptyState title="No designs in this view" /> : undefined}
    >
    {id ? <DesignThreadPage key={id} /> : (
      // The overview owns the table's command input; the input docks at the
      // bottom of the content column (CollectionCommandHost → ColumnDock).
      <Stack gap="sm" className="min-w-0">
        <CollectionToolbar label="Design filters"
          search={{ value: query, onChange: setQuery, placeholder: 'Search designs', 'aria-label': 'Search designs' }}
          summary={data ? `${reviews.length} design${reviews.length === 1 ? '' : 's'}` : undefined}
          onRefresh={refresh} refreshing={isLoading} />
        {designsFailure ? (
        <UnavailableNotice
          error={designsFailure}
          what="designs"
          source={DESIGNS_SOURCE}
          onRetry={refresh}
        />
      ) : isLoading && !data ? (
        <LoadingState label="Loading design reviews…" />
      ) : reviews.length === 0 ? (
        <EmptyState
          title="No design reviews"
          description={query.trim()
            ? 'No loaded design matches this search.'
            : filter === 'all'
            ? 'No initiative has opened a design thread yet.'
            : `Nothing ${STATUS_LABEL[filter as DesignStatus]?.toLowerCase() ?? filter} right now.`}
          {...(filter === 'all' && !query.trim() ? {
            action: (
              <Link to="/iq/projects" className="text-xs font-semibold text-primary no-underline hover:underline">
                Open Initiatives →
              </Link>
            ),
          } : {})}
        />
      ) : (
        <DataTable<DesignReview>
          data={reviews}
          columns={columns}
          keyField={(r) => r.id}
          onRowClick={(r) => openDesign(r.id)}
          pageSize={25}
          emptyMessage="No design reviews"
        />
      )}
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    )}
    </StackedCatalogLayout>
  );
}
