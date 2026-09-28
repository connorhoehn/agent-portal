// Design → Designs. The register of design reviews: every initiative's ADR
// threads — where the agents' ideation stands, which threads are waiting on a
// human, what has been ratified into the knowledge base.

import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router';
import { StackedCatalogLayout } from '../../components/shell/StackedCatalogLayout';
import DesignThreadPage from './DesignThreadPage';
import {
  Chip,
  DataTable,
  EmptyState,
  LoadingState,
  PageSection,
  Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useUrlState } from '../../lib/useUrlState';
import { relativeTime } from '../../lib/relativeTime';
import { STATUS_LABEL, STATUS_TONE, filterDesigns, reviewStateLine } from './designFormat';
import { T } from './Text';
import type { DesignReview, DesignStatus } from './types';

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
  const [filter] = useUrlState<string>(
    'status',
    (raw) => (raw && FILTERS.some((f) => f.value === raw) ? raw : 'all'),
    (v) => (v === 'all' ? null : v),
  );

  const { data, isLoading, error, degraded, refresh } = useFetch<{ reviews: DesignReview[] }>(
    `/api/designs${initiative ? `?initiative=${encodeURIComponent(initiative)}` : ''}`, 30_000);
  const designsFailure = error ?? degraded;

  const reviews = useMemo(() => filterDesigns(data?.reviews ?? [], filter), [data, filter]);

  const columns: DataTableColumn<DesignReview>[] = [
    {
      key: 'title', header: 'Design', sortable: true,
      render: (r) => (
        <Stack gap="none" className="min-w-0">
          {/* A real Link, not just the row's onClick: DataTable's row-click is
              a bare <tr onClick> with no keyboard access, so this is the one
              focusable, Enter-activatable control in the row. */}
          <Link
            to={`/iq/designs/${r.id}?${searchParams}`}
            onClick={(e) => e.stopPropagation()}
            className="block text-[13px] font-semibold text-text-primary no-underline hover:underline truncate"
          >
            {r.title}
          </Link>
          <T className="block text-[11px] text-text-tertiary truncate">{reviewStateLine(r)}</T>
        </Stack>
      ),
    },
    {
      key: 'orgProjectName', header: 'Initiative', sortable: true,
      render: (r) => <T className="text-[12px] text-text-secondary whitespace-nowrap">{r.orgProjectName}</T>,
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
        ? <T className="text-[11px] text-text-tertiary whitespace-nowrap">{r.dependsOn.length} design{r.dependsOn.length === 1 ? '' : 's'}</T>
        : <T className="text-[11px] text-text-tertiary">—</T>,
    },
    {
      key: 'kbSynced', header: 'KB', align: 'right',
      render: (r) => r.kbSynced
        ? <Chip tone="success" size="xs">logged</Chip>
        : <T className="text-[11px] text-text-tertiary">—</T>,
    },
    {
      key: 'updatedAt', header: 'Updated', align: 'right', sortable: true,
      compare: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (r) => <T className="text-[11px] text-text-tertiary whitespace-nowrap">{relativeTime(r.updatedAt)}</T>,
    },
  ];

  return (
    <StackedCatalogLayout
      title="Designs" basePath="/iq/designs" listTitle={filter === 'all' ? 'All designs' : FILTERS.find((f) => f.value === filter)?.label ?? 'Designs'}
      items={FILTERS.map((f) => ({ path: `/iq/designs?${new URLSearchParams({ status: f.value, ...(initiative ? { initiative } : {}) })}`, label: f.label === 'All' ? 'All designs' : f.label, group: 'Status', active: filter === f.value }))}
      rows={reviews.map((review) => ({ id: review.id, title: review.title, subline: STATUS_LABEL[review.status] }))}
      selectedId={id} selectedTitle={data?.reviews.find((review) => review.id === id)?.title}
      onSelect={(next) => navigate(`/iq/designs/${encodeURIComponent(next)}?${searchParams}`)}
      railNotice={designsFailure ? <UnavailableNotice error={designsFailure} what="designs" source="Design reviews" onRetry={refresh} /> : isLoading && !data ? <LoadingState label="Loading designs…" /> : reviews.length === 0 ? <EmptyState size="sm" title="No designs in this view" /> : undefined}
    >
    {id ? <DesignThreadPage key={id} /> :
    <PageSection
      title="Designs"
      description="Agents restate the problem, iterate a plan, and raise questions when intent is unclear; people answer and sign off. An approved design is an ADR — logged to the knowledge base, and a gate for the designs built on it."
    >

      {designsFailure ? (
        <UnavailableNotice
          error={designsFailure}
          what="designs"
          source="Design reviews are read from Aurora"
          onRetry={refresh}
        />
      ) : isLoading && !data ? (
        <LoadingState label="Loading design reviews…" />
      ) : reviews.length === 0 ? (
        <EmptyState
          title="No design reviews"
          description={filter === 'all'
            ? 'No initiative has opened a design thread yet.'
            : `Nothing ${STATUS_LABEL[filter as DesignStatus]?.toLowerCase() ?? filter} right now.`}
          {...(filter === 'all' ? {
            action: (
              <Link to="/iq/projects" className="text-[12px] font-semibold text-primary no-underline hover:underline">
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
          onRowClick={(r) => navigate(`/iq/designs/${r.id}?${searchParams}`)}
          pageSize={25}
          emptyMessage="No design reviews"
        />
      )}
    </PageSection>}
    </StackedCatalogLayout>
  );
}
