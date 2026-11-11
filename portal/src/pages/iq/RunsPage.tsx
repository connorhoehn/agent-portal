// /iq/runs — OrgIQ's one Runs list under Operate (docs/learning-loop-design.md "Pages"; lane E2): every
// executor's runs, newest first, from GET /api/run-reports, filtered by executor (queue, your machine,
// bot, microVM), initiative, outcome and whether the run was debriefed. The Automate rail's Runs, Local
// compute's Runs and an initiative's Agents › Runs link here with the filter set (?executor=, ?initiative=).
// Names are joined from reads the portal already makes: the job queue (what the run was for), the
// façade /api/runs (a bot's name), the work board (a governed run's work item) and the initiatives list.
//
// Gated like the reads it joins: the bots read gate (org-leader, hr-admin, program-owner, and anyone
// holding ManageBots — sme), so the rail, the palette and the route admit exactly who the API serves
// (docs/nav-server-tier-decisions.md).

import { useNavigate, useSearchParams } from 'react-router';
import { Banner, Button, DataTable } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { showingLabel } from '../../lib/format';
import { DEBRIEF_FILTERS, EXECUTOR_FILTERS, OUTCOME_FILTERS } from './runsModel';
import { useRunbookNames } from '../runbooks/useRunbookNames';
import { runColumns, runHref, useRunRows } from './runRows';
import { RUN_REPORT_FILTER_KEYS, RUN_REPORT_GRAMMAR, runReportCommandFilter } from './runReportCommands';

export default function IqRunsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = { executor: params.get('executor') ?? '', initiative: params.get('initiative') ?? '', outcome: params.get('outcome') ?? '', debrief: params.get('debrief') ?? '', workItem: params.get('workItem') ?? '', runbook: params.get('runbook') ?? '' };
  const query = params.get('q') ?? '';
  const set = (key: typeof RUN_REPORT_FILTER_KEYS[number] | 'q', value: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (value) p.set(key, value); else p.delete(key); return p; }, { replace: true });

  // The text goes to the server as ?q= a moment after typing stops; the box itself updates at once.
  const { searchText, onSearchChange } = useDebouncedSearch(query, (value) => set('q', value), 250);
  const { reports, rows, initiatives, work, loadMore, loadingMore, moreError } = useRunRows({ ...filters, q: query });
  const names = useRunbookNames();
  // The eight the list has room for at 1440; Failure and Debrief are on the run's page and the initiative's Learning tab.
  const columns = runColumns(['when', 'what', 'initiative', 'who', 'outcome', 'runbooks', 'learned', 'cost']);

  const visible = rows;
  const filtered = RUN_REPORT_FILTER_KEYS.some((k) => filters[k]) || !!query.trim();
  const commands = collectionCommandAdapter(RUN_REPORT_GRAMMAR, {
    id: 'run-reports-commands', label: 'Runs',
    setQuery: value => set('q', value),
    setFilter: value => setParams(previous => runReportCommandFilter(previous, value), { replace: true }),
    refresh: reports.refresh,
    scopeNote: 'Filter run reports, search run text and open one report. Commands do not start, cancel or retry runs.',
    open: target => {
      if (!reports.data || reports.isLoading || reports.error) throw new Error('Wait for the run reports to load before opening one.');
      const run = resolveCollectionTarget(target, visible.map(r => ({ id: r.runRef, title: r.what })));
      navigate(runHref(run.id));
      return `Opening ${run.title}.`;
    },
  });
  const projectOptions = [{ value: '', label: 'All' }, ...(Array.isArray(initiatives.data) ? initiatives.data : []).map((p) => ({ value: p.id, label: p.name }))];
  // A work item or runbook link carries the id; the filter shows it as the one choice beside "All" so it clears the way the initiative one does.
  const workItemTitle = (Array.isArray(work.data) ? work.data : []).find((w) => w.id === filters.workItem)?.title;
  const workItemOptions = [{ value: '', label: 'All' }, ...(filters.workItem ? [{ value: filters.workItem, label: workItemTitle ?? filters.workItem }] : [])];
  const runbookOptions = [{ value: '', label: 'All' }, ...(filters.runbook ? [{ value: filters.runbook, label: names.runbook(filters.runbook) }] : [])];
  return (
    <CollectionCommandPage
      data-testid="iq-runs"
      title="Runs"
      description="Everything that ran work for this workspace: your machines, bots and the queue."
      toolbar={{
        label: 'Run filters',
        search: { value: searchText, onChange: onSearchChange, placeholder: 'Search run summaries, obstacles and failures', 'aria-label': 'Search runs by text' },
        filters: [
          { id: 'executor', label: 'Ran on', value: filters.executor, onChange: (v) => set('executor', v), options: [...EXECUTOR_FILTERS] },
          { id: 'initiative', label: 'Initiative', value: filters.initiative, onChange: (v) => set('initiative', v), options: projectOptions },
          ...(filters.workItem ? [{ id: 'workItem', label: 'Work item', value: filters.workItem, onChange: (v: string) => set('workItem', v), options: workItemOptions }] : []),
          ...(filters.runbook ? [{ id: 'runbook', label: 'Runbook', value: filters.runbook, onChange: (v: string) => set('runbook', v), options: runbookOptions }] : []),
          { id: 'outcome', label: 'Outcome', value: filters.outcome, onChange: (v) => set('outcome', v), options: [...OUTCOME_FILTERS] },
          { id: 'debrief', label: 'Debriefed', value: filters.debrief, onChange: (v) => set('debrief', v), options: [...DEBRIEF_FILTERS] },
        ],
        summary: reports.data ? showingLabel(visible.length, reports.data.next ? null : rows.length, (reports.data.next ? visible.length : rows.length) === 1 ? 'run' : 'runs') : undefined,
        onRefresh: reports.refresh,
        refreshing: reports.isLoading,
      }}
      gutter="page"
      {...(reports.error ? { error: reports.error, onRetry: reports.refresh } : {})}
    >
      {moreError && <Banner variant="error">Could not load older runs: {moreError}</Banner>}
      <DataTable
        narrow
        responsiveColumns
        hiddenColumnsControl="header"
        data={visible}
        columns={columns}
        keyField={(r) => r.runRef}
        loading={reports.isLoading && !reports.data}
        pageSize={25}
        onRowClick={(r) => navigate(runHref(r.runRef))}
        data-testid="iq-runs-table"
        emptyMessage={filtered ? 'No run matches these filters.' : 'No runs recorded yet.'}
      />
      {reports.data?.next && <Button variant="secondary" size="sm" className="self-start" disabled={loadingMore} onClick={() => void loadMore()} data-testid="iq-runs-load-more">{loadingMore ? 'Loading…' : 'Load older runs'}</Button>}
      <CollectionCommandHost adapter={commands} />
    </CollectionCommandPage>
  );
}
