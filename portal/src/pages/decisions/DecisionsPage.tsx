// Plan → Decisions. The register of the calls the organisation has made or
// still has to make — escalated and open ones first, settled ones after —
// each one a record page (`/iq/decisions/:id`) with its initiative, work item,
// people and history. Same catalog frame as Designs: section rail, flush list
// rail beside an open record, command composer docked under the column.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Chip, CollectionToolbar, DataTable, EmptyState, LoadingState, Stack, T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { StackedCatalogLayout } from '../../components/shell/StackedCatalogLayout';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useUrlState } from '../../lib/useUrlState';
import { relativeTime } from '../../lib/relativeTime';
import { DECISION_GRAMMAR } from './decisionCommands';
import { DECISIONS_SOURCE, asInstant, filterDecisions, matchesDecision, sortDecisions, statusLabel, STATUS_TONE } from './decisionFormat';
import DecisionRecordPage from './DecisionRecordPage';
import { RecordLink } from './RecordLink';
import type { DecisionSummary, InitiativeName } from './types';

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All decisions' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Decided' },
];
const href = (id: string, search: string) => `/iq/decisions/${encodeURIComponent(id)}${search}`;

export default function DecisionsPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [filter, setFilter] = useUrlState<string>(
    'status',
    (raw) => (raw && FILTERS.some((f) => f.value === raw) ? raw : 'all'),
    (v) => (v === 'all' ? null : v),
  );
  const { data, isLoading, error, degraded, refresh } = useFetch<DecisionSummary[]>('/api/graph/decisions?limit=200', 30_000);
  const { data: initiatives } = useFetch<InitiativeName[]>('/api/graph/projects?limit=200&scope=all', 60_000, { share: true });
  const failure = error ?? degraded;
  const nameOf = useMemo(() => {
    const names = new Map((initiatives ?? []).map((p) => [p.id, p.name]));
    return (projectId: string | null) => (projectId ? names.get(projectId) ?? null : null);
  }, [initiatives]);

  const [query, setQuery] = useState('');
  const all = useMemo(() => sortDecisions(data ?? []), [data]);
  const rows = useMemo(
    () => filterDecisions(all, filter).filter((d) => matchesDecision(d, query, nameOf(d.projectId))),
    [all, filter, query, nameOf],
  );
  const search = '';
  const open = (decisionId: string) => navigate(href(decisionId, search));
  const adapter = collectionCommandAdapter(DECISION_GRAMMAR, {
    setQuery, setFilter: (value) => setFilter(value || 'all'), refresh, id: 'decisions-commands',
    scopeNote: 'Commands search the loaded decisions, pick a Status view and open one decision; they never decide, escalate or edit one.',
    open: (target) => {
      const hit = resolveCollectionTarget(target, rows.map((d) => ({ id: d.id, title: d.topic })));
      open(hit.id);
      return `Opening ${hit.title}.`;
    },
  });

  const columns: DataTableColumn<DecisionSummary>[] = [
    {
      key: 'topic', header: 'Decision', sortable: true,
      render: (d) => <RecordLink to={href(d.id, search)} className="block max-w-[220px] truncate" title={d.topic}>{d.topic}</RecordLink>,
    },
    {
      key: 'projectId', header: 'Initiative', sortable: true,
      compare: (a, b) => (nameOf(a.projectId) ?? '').localeCompare(nameOf(b.projectId) ?? ''),
      render: (d) => <T size="xs" tone="secondary" className="block max-w-48 truncate" title={nameOf(d.projectId) ?? 'Organisation-wide'}>{nameOf(d.projectId) ?? 'Organisation-wide'}</T>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (d) => <Chip tone={STATUS_TONE[d.status] ?? 'neutral'} size="sm" dot="static">{statusLabel(d.status)}</Chip>,
    },
    {
      key: 'participantCount', header: 'People', align: 'right', numeric: true,
      render: (d) => <T size="xs" tone="tertiary">{d.participantCount}</T>,
    },
    {
      key: 'decidedAt', header: 'Decided', align: 'right', sortable: true,
      compare: (a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''),
      render: (d) => <T size="xs" tone="tertiary" className="whitespace-nowrap">{d.decidedAt ? relativeTime(asInstant(d.decidedAt)) : '—'}</T>,
    },
  ];

  const current = FILTERS.find((f) => f.value === filter)?.label ?? 'All decisions';
  return (
    <StackedCatalogLayout
      catalogOverview navigation="combined" title="Decisions" group="Plan" basePath="/iq/decisions" listTitle={current}
      overviewDescription="The calls the organisation has made or still has to make — who decides, what it holds up, and how it was settled."
      items={FILTERS.map((f) => ({ path: `/iq/decisions?status=${f.value}`, label: f.label, group: 'Status', active: filter === f.value }))}
      rows={rows.map((d) => ({ id: d.id, title: d.topic, subline: statusLabel(d.status) }))}
      selectedId={id} selectedTitle={data?.find((d) => d.id === id)?.topic}
      onSelect={open}
      footer={id ? <CollectionCommandHost inPlace adapter={adapter} /> : undefined}
      railNotice={failure ? <UnavailableNotice error={failure} what="decisions" source={DECISIONS_SOURCE} onRetry={refresh} />
        : isLoading && !data ? <LoadingState label="Loading decisions…" />
        : rows.length === 0 ? <EmptyState align="start" title="No decisions in this view" /> : undefined}
    >
      {id ? <DecisionRecordPage key={id} /> : (
        <Stack gap="sm" className="min-w-0">
          <CollectionToolbar label="Decision filters"
            search={{ value: query, onChange: setQuery, placeholder: 'Search decisions', 'aria-label': 'Search decisions' }}
            summary={data ? `${rows.length} decision${rows.length === 1 ? '' : 's'}` : undefined}
            onRefresh={refresh} refreshing={isLoading} />
          {failure ? <UnavailableNotice error={failure} what="decisions" source={DECISIONS_SOURCE} onRetry={refresh} />
            : isLoading && !data ? <LoadingState label="Loading decisions…" />
            : rows.length === 0 ? (
              <EmptyState title="No decisions" description={query.trim() ? 'No loaded decision matches this search.' : 'Nothing is recorded in this view yet.'} />
            ) : (
              <DataTable<DecisionSummary> data={rows} columns={columns} keyField={(d) => d.id}
                onRowClick={(d) => open(d.id)} pageSize={25} emptyMessage="No decisions" />
            )}
          <CollectionCommandHost adapter={adapter} />
        </Stack>
      )}
    </StackedCatalogLayout>
  );
}
