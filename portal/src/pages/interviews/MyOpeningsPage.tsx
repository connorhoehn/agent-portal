// /interviews/my-openings — the hiring manager's home (docs/interviews-tenant-plan.md
// "Pages"): the candidates on their own openings, by stage, with each
// opening's count by stage above the table (GET /api/interviews/openings,
// already only theirs). A candidate whose rounds are all scored leads to the
// debrief, where the decision is made (row I5.5).

import { CollectionToolbar, DataTable, Stack, T, Tabs, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useMemo, useState } from 'react';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { plural } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import {
  INTERVIEWS_API, STAGE_LABELS, byStageLine, lastResultLine, matches, nextInterviewLine, whenLabel,
  type ApplicationStage, type ItemsResponse, type OpeningRow, type PipelineEntry,
} from '../../lib/interviews';
import { Dash, DebriefResultCell, PersonCell, StageChip } from './interviewsCells';
import { DECISION_ORDER, pipelineNameHref, stageFilterOf, stageTabs } from '../../lib/interviewsOpenings';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

interface Row extends PipelineEntry { opening: { id: string; title: string; team: string } }

const COLUMNS: DataTableColumn<Row>[] = [
  {
    key: 'candidate', header: 'Candidate', sortable: true, compare: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
    render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} testId="interviews-pipeline-candidate" to={pipelineNameHref(r)} />,
  },
  { key: 'opening', header: 'Opening', sortable: true, compare: (a, b) => a.opening.title.localeCompare(b.opening.title),
    render: (r) => <T size="sm" title={`${r.opening.title}, ${r.opening.team}`} className="block max-w-[14rem] truncate">{r.opening.title}</T> },
  { key: 'stage', header: 'Stage', width: '152px', sortable: true, compare: (a, b) => DECISION_ORDER.indexOf(a.stage) - DECISION_ORDER.indexOf(b.stage),
    render: (r) => <StageChip stage={r.stage} /> },
  {
    key: 'next', header: 'Next interview',
    render: (r) => (r.nextInterview
      ? <T size="sm" title={`${r.nextInterview.roundName} with ${r.nextInterview.lead.name}, ${whenLabel(r.nextInterview.scheduledAt)}`} className="block max-w-[16rem] truncate">{nextInterviewLine(r.nextInterview)}</T>
      : <Dash />),
  },
  { key: 'result', header: 'Last result', width: '176px', render: (r) => <DebriefResultCell candidateId={r.candidate.id} result={r.lastResult} due={r.scorecardDue} ready={r.debriefReady} /> },
  {
    key: 'since', header: 'In stage since', numeric: true, sortable: true, compare: (a, b) => a.stageChangedAt.localeCompare(b.stageChangedAt),
    render: (r) => <T size="sm" title={new Date(r.stageChangedAt).toLocaleString()}>{relativeTime(r.stageChangedAt)}</T>,
  },
];

export default function MyOpeningsPage() {
  const { session } = useSession();
  return <MyOpeningsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function MyOpeningsWorkspace() {
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<OpeningRow>>(`${INTERVIEWS_API}/openings`, 30_000);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<ApplicationStage | ''>('');
  const [opening, setOpening] = useState('');
  const openings = data?.items ?? [];
  const all: Row[] = useMemo(() => openings
    .flatMap((o) => o.pipeline.map((p) => ({ ...p, opening: { id: o.id, title: o.title, team: o.team } })))
    .sort((a, b) => DECISION_ORDER.indexOf(a.stage) - DECISION_ORDER.indexOf(b.stage) || a.opening.title.localeCompare(b.opening.title) || a.candidate.name.localeCompare(b.candidate.name)), [openings]);
  const found = all.filter((r) => (!opening || r.opening.id === opening)
    && matches(query, r.candidate.name, r.candidate.headline, r.opening.title, STAGE_LABELS[r.stage], nextInterviewLine(r.nextInterview), lastResultLine(r.lastResult)));
  const tabs = stageTabs(found);
  const rows = stage ? found.filter((r) => r.stage === stage) : found;

  const adapter = interviewsCollectionAdapter('my-openings', { setQuery, setFilter: (v) => setStage(stageFilterOf(v)), refresh });

  return (
    <CollectionCommandPage data-testid="interviews-my-openings" title="My openings"
      description="The candidates on the openings you are hiring for, by stage, with what happens next.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Opening filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search candidates', 'aria-label': 'Search candidates on your openings' },
            filters: [
              { id: 'opening', label: 'Opening', value: opening, onChange: setOpening, options: [{ value: '', label: 'All my openings' }, ...openings.map((o) => ({ value: o.id, label: o.title }))] },
            ],
            summary: data ? `${plural(rows.length, 'candidate')} on ${plural(openings.length, 'opening')}` : undefined,
            notices: openings.map((o) => `${o.title}, ${o.team}: ${byStageLine(o.byStage) || 'no candidates yet'}${o.upcoming ? ` · ${plural(o.upcoming, 'interview')} coming up` : ''}`),
            onRefresh: refresh, refreshing: isLoading,
          }}>
            <Tabs aria-label="Candidates by stage" size="sm" value={stage || 'all'} onValueChange={(v) => setStage(stageFilterOf(v))} getItemTestId={(i) => `interviews-openings-stage-${i.id}`}
              items={[{ id: 'all', label: 'All', badge: data ? tabs.all : undefined }, ...tabs.stages.map((t) => ({ id: t.stage, label: STAGE_LABELS[t.stage], badge: t.count }))]} />
          </CollectionToolbar>
          {error ? (
            <UnavailableNotice error={error} what="your openings" source="Openings are read from the ones you are hiring manager of" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-my-openings-table"
              aria-label="Candidates on my openings"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.applicationId}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() || stage || opening ? 'No candidate matches this search and these filters.' : openings.length ? 'No candidates on your openings yet.' : 'You are not hiring manager of any opening yet.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
