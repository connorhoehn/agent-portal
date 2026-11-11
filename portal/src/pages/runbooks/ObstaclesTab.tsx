// Runbooks → Recurring obstacles: what different runs keep hitting, so a reviewer of the loop can see
// the walls and write the runbook that would save the next run. Read from GET /api/run-reports/recurring-obstacles
// (the Runs list's gate); each row's runs open at /iq/runs/:ref and "Write a runbook" opens the Library's
// New runbook form filled from the obstacle. Same table as the Runs page.
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { DataTable, Inline, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { useRunRows } from '../iq/runRows';
import { runPageHref } from './runbooksModel';
import { WINDOW_OPTIONS, obstaclesQuery, repoName, writeRunbookHref, type RecurringObstacle, type RecurringObstaclesResponse } from './obstaclesModel';

export default function ObstaclesTab() {
  const [params, setParams] = useSearchParams();
  const initiative = params.get('initiative') ?? '';
  const days = params.get('days') ?? '30';
  const set = (key: 'initiative' | 'days', value: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (value) p.set(key, value); else p.delete(key); return p; }, { replace: true });

  const feed = useFetch<RecurringObstaclesResponse>(`/api/run-reports/recurring-obstacles${obstaclesQuery({ initiative, repo: '', days })}`, 30_000);
  const initiatives = useFetch<Array<{ id: string; name: string }>>('/api/graph/projects?limit=200', 0, { share: true });
  const names = useMemo(() => new Map((Array.isArray(initiatives.data) ? initiatives.data : []).map((p) => [p.id, p.name])), [initiatives.data]);
  const where = (o: RecurringObstacle): string => (o.scope.kind === 'repo' ? repoName(o.scope.ref) : names.get(o.scope.ref) ?? o.scope.ref);
  const rows = feed.data?.obstacles ?? [];
  // A run is named by what it was for (its job or work item), never by its ref.
  const runs = useRunRows({ executor: '', initiative: '', outcome: '', debrief: '' }).rows;
  const runName = (ref: string): string => runs.find((r) => r.runRef === ref)?.what ?? 'Run';

  const columns: DataTableColumn<RecurringObstacle>[] = [
    { key: 'obstacle', header: 'Obstacle', render: (o) => <T size="sm" title={o.text} className="block max-w-[26rem] truncate">{o.text}</T> },
    { key: 'where', header: 'Where', width: '176px', priority: 4, render: (o) => <T size="sm">{where(o)}</T> },
    { key: 'runs', header: 'Runs', width: '72px', numeric: true, render: (o) => o.runs },
    { key: 'workItems', header: 'Work items', width: '104px', numeric: true, priority: 5, render: (o) => o.workItems },
    { key: 'failed', header: 'Failed', width: '80px', numeric: true, priority: 3, render: (o) => o.failedRuns },
    { key: 'last', header: 'Last seen', width: '112px', numeric: true, priority: 2, render: (o) => relativeTime(o.lastSeen) },
    { key: 'write', header: 'Action', width: '176px', render: (o) => (
      <RecordLink to={writeRunbookHref(o)} data-testid="obstacle-write-runbook"><T size="sm">Write a runbook for this</T></RecordLink>
    ) },
    // The newest run opens from the row; the older ones open from the expanded row when the table folds its columns.
    { key: 'latest', header: 'Latest run', width: '192px', render: (o) => (
      <RecordLink to={runPageHref(o.runRefs[0]!)} data-testid="obstacle-run-link">
        <T size="sm" title={o.runRefs.map(runName).join('; ')} className="block max-w-[11rem] truncate">{runName(o.runRefs[0]!)}</T>
      </RecordLink>
    ) },
  ];

  return (
    <CollectionCommandPage
      data-testid="runbooks-obstacles"
      title="Recurring obstacles"
      description="Walls that two or more different runs hit in the same repository or initiative, matched by their wording. A runbook written for one reaches the next run that meets it."
      toolbar={{
        label: 'Obstacle filters',
        filters: [
          { id: 'initiative', label: 'Initiative', value: initiative, onChange: (v) => set('initiative', v), options: [{ value: '', label: 'All' }, ...[...names].map(([value, label]) => ({ value, label }))] },
          { id: 'days', label: 'Window', value: days, onChange: (v) => set('days', v), options: [...WINDOW_OPTIONS] },
        ],
        summary: feed.data ? `${rows.length} recurring, from ${feed.data.runsRead} runs` : undefined,
        onRefresh: feed.refresh,
        refreshing: feed.isLoading,
      }}
      gutter="page"
      {...(feed.error ? { error: feed.error, onRetry: feed.refresh } : {})}
    >
      <DataTable
        narrow
        responsiveColumns
        hiddenColumnsControl="header"
        data={rows}
        columns={columns}
        keyField={(o) => o.key}
        loading={feed.isLoading && !feed.data}
        pageSize={25}
        data-testid="runbooks-obstacles-table"
        emptyMessage="No obstacle has been hit by two different runs in this window."
      />
    </CollectionCommandPage>
  );
}
