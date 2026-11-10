// Plan → Decisions. The register of the calls the organisation has made or
// still has to make — escalated and open ones first, settled ones after —
// each one a record page (`/iq/decisions/:id`) with its initiative, work item,
// people and history. Same catalog frame as Designs: section rail, flush list
// rail beside an open record, command composer docked under the column. On a
// waiting decision's record that composer is the decision dialogue (G57): the
// record page hands it the prompt, and Esc returns it to the table commands.

import { useMemo, useState } from 'react';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useNavigate, useParams } from 'react-router';
import {
  ActionRowPerson, Chip, CollectionToolbar, DataTable, EmptyState, LoadingState, Stack, T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { StackedCatalogLayout } from '../../components/shell/StackedCatalogLayout';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useUrlState } from '../../lib/useUrlState';
import { DECISION_GRAMMAR } from './decisionCommands';
import { DECISIONS_SOURCE, decidedShort, deciderCell, filterDecisions, matchesDecision, outcomeFirstLine, sortDecisions, statusLabel, STATUS_TONE } from './decisionFormat';
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
  // G57: the open record's decision dialogue, drawn by the docked composer instead of its free text.
  const [recordPrompt, setRecordPrompt] = useState<ComposerPrompt | null>(null);
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
      key: 'topic', header: 'Decision', sortable: true, truncate: true, wrap: 'two-lines', width: '16rem',
      render: (d) => <RecordLink to={href(d.id, search)}>{d.topic}</RecordLink>,
    },
    {
      // The date and the secondary columns give way as the table narrows (DataTable `responsiveColumns`,
      // ui-components 2.516.0): Outcome, then Initiative go first; the decision, its status and the short date stay. (The people count is on the record page; the list carries no decider.)
      key: 'projectId', header: 'Initiative', sortable: true, priority: 3,
      compare: (a, b) => (nameOf(a.projectId) ?? '').localeCompare(nameOf(b.projectId) ?? ''),
      render: (d) => <T size="xs" tone="secondary" className="block max-w-[9rem] truncate" title={nameOf(d.projectId) ?? 'Organisation-wide'}>{nameOf(d.projectId) ?? 'Organisation-wide'}</T>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (d) => <Chip tone={STATUS_TONE[d.status] ?? 'neutral'} size="sm" dot="static">{statusLabel(d.status)}</Chip>,
    },
    {
      // G54: what a settled decision decided, its first line; a waiting one has none yet.
      key: 'outcome', header: 'Outcome', priority: 4,
      render: (d) => {
        const line = outcomeFirstLine(d);
        return <T size="xs" tone={line ? 'secondary' : 'tertiary'} className="block max-w-36 truncate" title={line ?? undefined}>{line ?? '—'}</T>;
      },
    },
    {
      // Who decided a settled row, or the person (else the role) a waiting row waits on. Priority 1: the
      // table never hides it, so it stays beside the decision at 1280 while the secondary columns give way.
      key: 'decider', header: 'Decider', sortable: true, priority: 1,
      compare: (a, b) => (deciderCell(a)?.name ?? '').localeCompare(deciderCell(b)?.name ?? ''),
      render: (d) => {
        const who = deciderCell(d);
        if (!who) return <T size="xs" tone="tertiary">—</T>;
        return who.person ? <ActionRowPerson name={who.name} size={24} />
          : <T size="xs" tone="secondary" className="whitespace-nowrap">{who.name}</T>;
      },
    },
    {
      key: 'decidedAt', header: 'Decided', align: 'right', sortable: true, priority: 2,
      compare: (a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''),
      render: (d) => <T size="xs" tone="tertiary" className="whitespace-nowrap">{d.status === 'open' || d.status === 'escalated' ? 'Waiting' : d.decidedAt ? decidedShort(d.decidedAt) : '—'}</T>,
    },
  ];

  const current = FILTERS.find((f) => f.value === filter)?.label ?? 'All decisions';
  return (
    <StackedCatalogLayout
      catalogOverview navigation="combined" narrow title="Decisions" group="Plan" basePath="/iq/decisions" listTitle={current}
      overviewDescription="The calls the organisation has made or still has to make — who decides, what it holds up, and how it was settled."
      items={FILTERS.map((f) => ({ path: `/iq/decisions?status=${f.value}`, label: f.label, group: 'Status', active: filter === f.value }))}
      // Grouped by status (one Decided group, not one per outcome); every row's second line is its
      // initiative, and a settled row adds its outcome's first line under it.
      rows={rows.map((d) => ({ id: d.id, title: d.topic, subline: statusLabel(d.status), description: nameOf(d.projectId) ?? 'Organisation-wide',
        ...(outcomeFirstLine(d) ? { detail: outcomeFirstLine(d)! } : {}) }))}
      selectedId={id} selectedTitle={data?.find((d) => d.id === id)?.topic}
      onSelect={open}
      // Keyed on whether a dialogue rides it: once the decision is settled (or the record has none)
      // the host mounts afresh as the plain one-line table-command composer, never the expanded
      // rich-text box the dialogue left behind (walk, 9 November).
      footer={id ? <CollectionCommandHost key={recordPrompt ? 'dialogue' : 'commands'} inPlace adapter={adapter} prompts={recordPrompt ? [recordPrompt] : undefined} /> : undefined}
      railNotice={failure ? <UnavailableNotice error={failure} what="decisions" source={DECISIONS_SOURCE} onRetry={refresh} />
        : isLoading && !data ? <LoadingState label="Loading decisions…" />
        : rows.length === 0 ? <EmptyState align="start" title="No decisions in this view" /> : undefined}
    >
      {id ? <DecisionRecordPage key={id} onDecided={refresh} onPrompt={setRecordPrompt} /> : (
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
              // Narrow: under 40rem of its width each decision is a card of label/value pairs.
              <DataTable<DecisionSummary> narrow responsiveColumns data={rows} columns={columns} keyField={(d) => d.id}
                onRowClick={(d) => open(d.id)} pageSize={25} emptyMessage="No decisions" />
            )}
          <CollectionCommandHost adapter={adapter} />
        </Stack>
      )}
    </StackedCatalogLayout>
  );
}
