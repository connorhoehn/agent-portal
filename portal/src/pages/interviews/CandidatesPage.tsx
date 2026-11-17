// /interviews/candidates — the recruiter's home (docs/interviews-tenant-plan.md
// "Pages"): every application in the tenant as one row — the candidate, the
// opening, the stage, the next interview and the last result
// (GET /api/interviews/candidates). Reads only: moving a candidate, assigning
// a round and the candidate profile are later rows. The last result opens the debrief (row I5.4).

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
import {
  INTERVIEWS_API, STAGE_LABELS, candidateHref, STAGE_ORDER, lastResultLine, matches, nextInterviewLine, whenLabel,
  type CandidateRow, type ItemsResponse,
} from '../../lib/interviews';
import { Dash, DebriefResultCell, PersonCell, StageChip } from './interviewsCells';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

const COLUMNS: DataTableColumn<CandidateRow>[] = [
  {
    key: 'candidate', header: 'Candidate', sortable: true, compare: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
    render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline} · ${r.candidate.location}`} testId="interviews-candidate-name" to={candidateHref(r.candidate.id)} />,
  },
  { key: 'opening', header: 'Opening', sortable: true, compare: (a, b) => a.opening.title.localeCompare(b.opening.title),
    render: (r) => <T size="sm" title={`${r.opening.title}, ${r.opening.team}`} className="block max-w-[14rem] truncate">{r.opening.title}</T> },
  { key: 'stage', header: 'Stage', width: '152px', sortable: true, compare: (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    render: (r) => <StageChip stage={r.stage} /> },
  {
    key: 'next', header: 'Next interview', sortable: true,
    compare: (a, b) => (a.nextInterview?.scheduledAt ?? '9999').localeCompare(b.nextInterview?.scheduledAt ?? '9999'),
    render: (r) => (r.nextInterview
      ? <T size="sm" title={`${r.nextInterview.roundName} with ${r.nextInterview.lead.name}, ${whenLabel(r.nextInterview.scheduledAt)}`} className="block max-w-[16rem] truncate">{nextInterviewLine(r.nextInterview)}</T>
      : <Dash />),
  },
  { key: 'result', header: 'Last result', width: '176px', render: (r) => <DebriefResultCell candidateId={r.candidate.id} result={r.lastResult} due={r.scorecardDue} /> },
  {
    key: 'applied', header: 'Applied', numeric: true, sortable: true, compare: (a, b) => a.appliedAt.localeCompare(b.appliedAt),
    render: (r) => <T size="sm" title={new Date(r.appliedAt).toLocaleString()}>{relativeTime(r.appliedAt)}</T>,
  },
];

export default function CandidatesPage() {
  const { session } = useSession();
  return <CandidatesWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function CandidatesWorkspace() {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<CandidateRow>>(`${INTERVIEWS_API}/candidates`, 30_000);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const [opening, setOpening] = useState('');
  const all = data?.items ?? [];
  const openings = useMemo(() => [...new Map(all.map((r) => [r.opening.id, r.opening.title])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const stages = useMemo(() => STAGE_ORDER.filter((s) => all.some((r) => r.stage === s)), [all]);
  const rows = all.filter((r) => (!stage || r.stage === stage) && (!opening || r.opening.id === opening)
    && matches(query, r.candidate.name, r.candidate.headline, r.opening.title, r.opening.team, STAGE_LABELS[r.stage], nextInterviewLine(r.nextInterview), r.nextInterview?.lead.name, lastResultLine(r.lastResult)));

  const adapter = interviewsCollectionAdapter('candidates', { setQuery, setFilter: setStage, refresh });

  return (
    <CollectionCommandPage data-testid="interviews-candidates" title="Candidates"
      description="Everyone in the hiring pipeline: the opening, where they stand and what happens next."
      headerActions={can('ManageCandidates')
        ? <Button size="sm" variant="primary" data-testid="interviews-add-candidate" onClick={() => void navigate('/interviews/candidates/new')}>Add a candidate</Button>
        : undefined}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Candidate filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search candidates', 'aria-label': 'Search candidates' },
            filters: [
              { id: 'opening', label: 'Opening', value: opening, onChange: setOpening, options: [{ value: '', label: 'Every opening' }, ...openings.map(([value, label]) => ({ value, label }))] },
              { id: 'stage', label: 'Stage', value: stage, onChange: setStage, options: [{ value: '', label: 'Every stage' }, ...stages.map((s) => ({ value: s, label: STAGE_LABELS[s] }))] },
            ],
            summary: data ? ofTotal(rows.length, all.length, 'candidate') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="candidates" source="Candidates are read from the interviews tenant's applications" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-candidates-table"
              aria-label="Candidates"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.applicationId}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() || stage || opening ? 'No candidate matches this search and these filters.' : 'No candidates yet.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
