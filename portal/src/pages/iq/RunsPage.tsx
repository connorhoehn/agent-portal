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

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Banner, Chip, DataTable, StatusDot, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { useFetch } from '../../hooks/useFetch';
import { showingLabel, usd } from '../../lib/format';
import { relativeTime } from '../../lib/relativeTime';
import type { RunListResponse } from '../../lib/pipelineRuns';
import { RecordLink } from '../decisions/RecordLink';
import {
  DEBRIEF_FILTERS, EXECUTOR_FILTERS, OUTCOME_FILTERS, OUTCOME_LABEL, OUTCOME_TONE, costWords, isSimulated, learnedDot, reportsQuery, whoRan,
  type RunReportRow,
} from './runsModel';
import { RUN_REPORT_FILTER_KEYS, RUN_REPORT_GRAMMAR, runReportCommandFilter } from './runReportCommands';

interface Row extends RunReportRow { what: string; who: string; initiativeName: string | null }

export default function IqRunsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = { executor: params.get('executor') ?? '', initiative: params.get('initiative') ?? '', outcome: params.get('outcome') ?? '', debrief: params.get('debrief') ?? '' };
  const query = params.get('q') ?? '';
  const set = (key: typeof RUN_REPORT_FILTER_KEYS[number] | 'q', value: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (value) p.set(key, value); else p.delete(key); return p; }, { replace: true });

  const reports = useFetch<{ reports: RunReportRow[]; next: string | null }>(`/api/run-reports${reportsQuery({ ...filters }).replace('limit=100', 'limit=200')}`, 15_000);
  const jobs = useFetch<{ jobs: Array<{ id: string; title: string }> }>('/api/work/jobs?limit=200', 0, { share: true });
  const facade = useFetch<RunListResponse>('/api/runs?limit=200', 0, { share: true });
  const initiatives = useFetch<Array<{ id: string; name: string }>>('/api/graph/projects?limit=200', 0, { share: true });
  // The work board: a governed run's ref is neither a queue job nor a façade run, so its name is its work item's title.
  const work = useFetch<Array<{ id: string; title: string }>>('/api/graph/work?limit=200', 0, { share: true });

  const rows = useMemo<Row[]>(() => {
    const titles = new Map((jobs.data?.jobs ?? []).map((j) => [j.id, j.title]));
    const workTitles = new Map((Array.isArray(work.data) ? work.data : []).map((w) => [w.id, w.title]));
    const bots = new Map<string, { title: string; bot: string | null }>();
    for (const r of facade.data?.runs ?? []) bots.set(r.id.replace(/^job:/, ''), { title: r.context.title, bot: r.context.kind === 'bot' ? r.context.title : null });
    const projects = new Map((Array.isArray(initiatives.data) ? initiatives.data : []).map((p) => [p.id, p.name]));
    return (reports.data?.reports ?? []).map((r) => {
      const known = bots.get(r.runRef);
      const what = titles.get(r.runRef) ?? known?.title ?? (r.workItemId ? workTitles.get(r.workItemId) : undefined) ?? 'Run';
      return { ...r, what, who: whoRan(r.executor, known?.bot), initiativeName: r.initiativeId ? projects.get(r.initiativeId) ?? null : null };
    });
  }, [reports.data, jobs.data, facade.data, initiatives.data, work.data]);

  const columns: DataTableColumn<Row>[] = [
    { key: 'when', header: 'When', width: '112px', numeric: true, render: (r) => relativeTime(r.endedAt) },
    { key: 'what', header: 'What', render: (r) => (
      <RecordLink to={`/iq/runs/${encodeURIComponent(r.runRef)}`} data-testid="run-row-link"><T size="sm" title={r.what} className="block max-w-[32rem] truncate">{r.what}</T></RecordLink>
    ) },
    // Keep the run, timing, outcome, learned mark and cost in view. Secondary
    // fields remain available through the shared table's column controls.
    { key: 'initiative', header: 'Initiative', priority: 3, render: (r) => r.initiativeName ?? <T size="xs" tone="tertiary">—</T> },
    { key: 'who', header: 'Who ran it', priority: 2, render: (r) => r.who },
    { key: 'outcome', header: 'Outcome', width: '128px', render: (r) => (
      <Chip tone={OUTCOME_TONE[r.outcome]} size="xs">{OUTCOME_LABEL[r.outcome]}</Chip>
    ) },
    { key: 'runbooks', header: 'Runbooks given', width: '120px', numeric: true, priority: 4, render: (r) => r.runbooksOffered.length },
    { key: 'learned', header: 'Learned', width: '88px', render: (r) => (learnedDot(r)
      ? <StatusDot size="sm" color="var(--color-success)" title="Filed a runbook proposal" aria-label="Filed a runbook proposal" />
      : <T size="xs" tone="tertiary">—</T>) },
    { key: 'cost', header: 'Cost', render: (r) => {
      if (isSimulated(r)) return <Chip tone="neutral" size="xs">Demo data</Chip>;
      // A local run's figure is the worker's own, never money: the cell says "reported" and the hover says the rest.
      if (r.cost.basis === 'reported') return <T size="sm" title="Reported, not billed">{r.cost.reportedUsd != null ? `${usd(r.cost.reportedUsd)} reported` : 'Reported'}</T>;
      return costWords(r.cost, (n) => usd(n, { precision: 2 }));
    } },
  ];

  const visible = rows.filter(r => r.what.toLowerCase().includes(query.trim().toLowerCase()));
  const filtered = RUN_REPORT_FILTER_KEYS.some((k) => filters[k]) || !!query.trim();
  const commands = collectionCommandAdapter(RUN_REPORT_GRAMMAR, {
    id: 'run-reports-commands', label: 'Runs',
    setQuery: value => set('q', value),
    setFilter: value => setParams(previous => runReportCommandFilter(previous, value), { replace: true }),
    refresh: reports.refresh,
    scopeNote: 'Filter run reports, search loaded titles and open one report. Commands do not start, cancel or retry runs.',
    open: target => {
      if (!reports.data || reports.isLoading || reports.error) throw new Error('Wait for the run reports to load before opening one.');
      const run = resolveCollectionTarget(target, visible.map(r => ({ id: r.runRef, title: r.what })));
      navigate(`/iq/runs/${encodeURIComponent(run.id)}`);
      return `Opening ${run.title}.`;
    },
  });
  const projectOptions = [{ value: '', label: 'All' }, ...(Array.isArray(initiatives.data) ? initiatives.data : []).map((p) => ({ value: p.id, label: p.name }))];
  return (
    <CollectionCommandPage
      data-testid="iq-runs"
      title="Runs"
      description="Everything that ran work for this workspace: your machines, bots and the queue."
      toolbar={{
        label: 'Run filters',
        search: { value: query, onChange: value => set('q', value), placeholder: 'Search loaded run titles', 'aria-label': 'Search loaded run titles' },
        filters: [
          { id: 'executor', label: 'Ran on', value: filters.executor, onChange: (v) => set('executor', v), options: [...EXECUTOR_FILTERS] },
          { id: 'initiative', label: 'Initiative', value: filters.initiative, onChange: (v) => set('initiative', v), options: projectOptions },
          { id: 'outcome', label: 'Outcome', value: filters.outcome, onChange: (v) => set('outcome', v), options: [...OUTCOME_FILTERS] },
          { id: 'debrief', label: 'Debriefed', value: filters.debrief, onChange: (v) => set('debrief', v), options: [...DEBRIEF_FILTERS] },
        ],
        summary: reports.data ? showingLabel(visible.length, reports.data.next ? null : rows.length, 'runs') : undefined,
        onRefresh: reports.refresh,
        refreshing: reports.isLoading,
      }}
      gutter="page"
      {...(reports.error ? { error: reports.error, onRetry: reports.refresh } : {})}
    >
      {reports.data?.next && <Banner variant="info">Showing the newest 200 runs. Narrow the filters to see older ones.</Banner>}
      <DataTable
        narrow
        responsiveColumns
        hiddenColumnsControl="header"
        data={visible}
        columns={columns}
        keyField={(r) => r.runRef}
        loading={reports.isLoading && !reports.data}
        pageSize={25}
        onRowClick={(r) => navigate(`/iq/runs/${encodeURIComponent(r.runRef)}`)}
        data-testid="iq-runs-table"
        emptyMessage={filtered ? 'No run matches these filters.' : 'No runs recorded yet.'}
      />
      <CollectionCommandHost adapter={commands} />
    </CollectionCommandPage>
  );
}
