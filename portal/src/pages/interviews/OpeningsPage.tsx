// /interviews/openings — the openings (docs/interviews-tenant-plan.md "Pages", row I1.3): every opening the
// viewer may read (GET /api/interviews/openings: all of them for the recruiter, their own for a hiring
// manager) as one dense row — title, team, hiring manager, candidates by stage and the kit at a glance.
// A row opens the opening and its kit; the recruiter's "New opening" starts one.

import { Button, CollectionToolbar, DataTable, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { ofTotal } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import { INTERVIEWS_API, byStageLine, matches, type ItemsResponse } from '../../lib/interviews';
import { OPENING_STATE_LABELS, kitLine, roundsLine, type OpeningListRow, type OpeningState } from '../../lib/interviewsKit';
import { Dash, PersonCell } from './interviewsCells';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

const STATES: readonly OpeningState[] = ['open', 'paused', 'closed'];

const COLUMNS: DataTableColumn<OpeningListRow>[] = [
  {
    key: 'title', header: 'Opening', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
    render: (r) => <T size="sm" weight="medium" title={`${r.title}, ${r.level} · ${r.location}`} className="block max-w-[16rem] truncate" data-testid="interviews-opening-title">{r.title}</T>,
  },
  { key: 'team', header: 'Team', sortable: true, compare: (a, b) => a.team.localeCompare(b.team),
    render: (r) => <T size="sm" className="block max-w-[10rem] truncate">{r.team}</T> },
  {
    key: 'hm', header: 'Hiring manager', sortable: true, compare: (a, b) => (a.hiringManager?.name ?? '~').localeCompare(b.hiringManager?.name ?? '~'),
    render: (r) => (r.hiringManager ? <PersonCell id={r.hiringManager.id} name={r.hiringManager.name} /> : <T size="sm" tone="tertiary">Not named yet</T>),
  },
  {
    key: 'candidates', header: 'Candidates by stage', sortable: true, compare: (a, b) => a.candidates - b.candidates,
    render: (r) => (r.candidates ? <T size="sm" title={byStageLine(r.byStage)} className="block max-w-[18rem] truncate">{byStageLine(r.byStage)}</T> : <Dash />),
  },
  {
    key: 'kit', header: 'Kit', render: (r) => <T size="sm" title={roundsLine(r.rounds)} className="block max-w-[18rem] truncate" data-testid="interviews-opening-kit">{kitLine(r)}</T>,
  },
  {
    key: 'opened', header: 'Opened', numeric: true, sortable: true, compare: (a, b) => a.openedAt.localeCompare(b.openedAt),
    render: (r) => <T size="sm" title={new Date(r.openedAt).toLocaleString()}>{relativeTime(r.openedAt)}</T>,
  },
];

export default function OpeningsPage() {
  const { session } = useSession();
  return <OpeningsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function OpeningsWorkspace() {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<OpeningListRow>>(`${INTERVIEWS_API}/openings`, 30_000);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const all = data?.items ?? [];
  const states = useMemo(() => STATES.filter((s) => all.some((r) => r.state === s)), [all]);
  const rows = all.filter((r) => (!state || r.state === state)
    && matches(query, r.title, r.level, r.team, r.location, r.hiringManager?.name, kitLine(r), ...r.rounds.map((x) => x.name)));
  const adapter = interviewsCollectionAdapter('openings', { setQuery, setFilter: setState, refresh });

  return (
    <CollectionCommandPage data-testid="interviews-openings" title="Openings"
      description="Every opening you hire for: who decides, where the candidates stand and the interview kit."
      headerActions={can('ManageCandidates')
        ? <Button size="sm" variant="secondary" data-testid="interviews-new-opening" onClick={() => void navigate('/interviews/openings/new')}>New opening</Button>
        : undefined}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Opening filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search openings', 'aria-label': 'Search openings' },
            filters: [
              { id: 'state', label: 'State', value: state, onChange: setState, options: [{ value: '', label: 'Every state' }, ...states.map((s) => ({ value: s, label: OPENING_STATE_LABELS[s] }))] },
            ],
            summary: data ? ofTotal(rows.length, all.length, 'opening') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="openings" source="Openings are read from the interviews tenant" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-openings-table"
              aria-label="Openings"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              onRowClick={(r) => void navigate(`/interviews/openings/${encodeURIComponent(r.id)}`)}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() || state ? 'No opening matches this search and this filter.' : 'No openings yet.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
