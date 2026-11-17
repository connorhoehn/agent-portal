// /interviews/my-interviews — the interviewer's home (docs/interviews-tenant-plan.md
// "Pages"): the interviews assigned to them, lead or panel, as one desk — what
// to accept, what is coming up, which scorecards are due, what is done
// (GET /api/interviews/interviews, already only theirs). Reads only: accepting,
// preparing and scoring are later rows.

import { Chip, CollectionToolbar, DataTable, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ofTotal } from '../../lib/plural';
import {
  DESK_VIEWS, INTERVIEWS_API, candidateHref, ROUND_TYPE_LABELS, deskLabel, deskOrder, deskTone, inDeskView, matches, whenLabel,
  type DeskView, type InterviewRow, type ItemsResponse,
} from '../../lib/interviews';
import { PersonCell } from './interviewsCells';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

const COLUMNS: DataTableColumn<InterviewRow>[] = [
  {
    key: 'when', header: 'When', numeric: true, width: '168px', sortable: true, compare: (a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''),
    render: (r) => <T size="sm" title={r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : undefined}>{whenLabel(r.scheduledAt)}</T>,
  },
  {
    key: 'candidate', header: 'Candidate', sortable: true, compare: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
    render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} testId="interviews-desk-candidate" to={candidateHref(r.candidate.id)} />,
  },
  { key: 'round', header: 'Round', render: (r) => <T size="sm" title={`${ROUND_TYPE_LABELS[r.round.type]}, ${r.round.minutes} minutes`}>{r.round.name}</T> },
  { key: 'opening', header: 'Opening', render: (r) => <T size="sm" title={`${r.opening.title}, ${r.opening.team}`} className="block max-w-[14rem] truncate">{r.opening.title}</T> },
  {
    key: 'seat', header: 'With', render: (r) => (r.seat === 'panel'
      ? <PersonCell id={r.lead.id} name={r.lead.name} title={`${r.lead.name} leads; you are on the panel`} />
      : r.panel.length ? <PersonCell id={r.panel[0]!.id} name={r.panel[0]!.name} title={`${r.panel.map((p) => p.name).join(', ')} on the panel; you lead`} />
        : <T size="sm" tone="secondary">You lead</T>),
  },
  { key: 'desk', header: 'Waiting for', width: '176px', render: (r) => <Chip tone={deskTone(r)} size="xs" data-testid="interviews-desk-state">{deskLabel(r)}</Chip> },
];

export default function MyInterviewsPage() {
  const { session } = useSession();
  return <MyInterviewsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function MyInterviewsWorkspace() {
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<InterviewRow>>(`${INTERVIEWS_API}/interviews`, 30_000);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<DeskView>('open');
  const all = [...(data?.items ?? [])].sort(deskOrder);
  const count = (v: DeskView) => all.filter((r) => inDeskView(r, v)).length;
  const rows = all.filter((r) => inDeskView(r, view)
    && matches(query, r.candidate.name, r.candidate.headline, r.round.name, r.opening.title, r.opening.team, r.lead.name, deskLabel(r)));

  const adapter = interviewsCollectionAdapter('my-interviews', {
    setQuery, refresh,
    setFilter: (v) => setView((DESK_VIEWS.some((d) => d.value === v) ? v : 'open') as DeskView),
  });

  return (
    <CollectionCommandPage data-testid="interviews-my-interviews" title="My interviews"
      description="The interviews assigned to you: what to accept, what is coming up and which scorecards are due.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Interview filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search your interviews', 'aria-label': 'Search your interviews' },
            filters: [{
              id: 'desk', label: 'Show', value: view, emptyValue: 'open', onChange: (v: string) => setView((v || 'open') as DeskView),
              options: DESK_VIEWS.map((d) => ({ value: d.value, label: data ? `${d.label} (${count(d.value)})` : d.label })),
            }],
            summary: data ? ofTotal(rows.length, all.length, 'interview') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="your interviews" source="Interviews are read from the rounds assigned to you" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-my-interviews-table"
              aria-label="My interviews"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() ? 'No interview matches this search.' : view === 'open' ? 'Nothing needs you and nothing is coming up.' : 'No interviews in this view.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
