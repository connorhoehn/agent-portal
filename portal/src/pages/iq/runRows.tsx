// The Runs list's rows and cells, shared by /iq/runs and an initiative's Learning tab so both read a run
// report the same way: the report list joined to names the portal already reads (the queue's job title, the
// façade's bot name, a governed run's work item, the initiative's name), and the columns that print it.
import { useMemo } from 'react';
import { Chip, StatusDot, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { usd } from '../../lib/format';
import { relativeTime } from '../../lib/relativeTime';
import type { RunListResponse } from '../../lib/pipelineRuns';
import { RecordLink } from '../decisions/RecordLink';
import { OUTCOME_LABEL, OUTCOME_TONE, costWords, debriefWords, failureWords, isSimulated, learnedDot, reportsQuery, whoRan, type RunReportRow } from './runsModel';

export interface RunRow extends RunReportRow { what: string; who: string; initiativeName: string | null }

export interface RunFilters { executor: string; initiative: string; outcome: string; debrief: string; workItem?: string; runbook?: string }

export const runHref = (runRef: string) => `/iq/runs/${encodeURIComponent(runRef)}`;

export function useRunRows(filters: RunFilters) {
  const reports = useFetch<{ reports: RunReportRow[]; next: string | null }>(`/api/run-reports${reportsQuery({ ...filters }).replace('limit=100', 'limit=200')}`, 15_000);
  const jobs = useFetch<{ jobs: Array<{ id: string; title: string }> }>('/api/work/jobs?limit=200', 0, { share: true });
  const facade = useFetch<RunListResponse>('/api/runs?limit=200', 0, { share: true });
  const initiatives = useFetch<Array<{ id: string; name: string }>>('/api/graph/projects?limit=200', 0, { share: true });
  // The work board: a governed run's ref is neither a queue job nor a façade run, so its name is its work item's title.
  const work = useFetch<Array<{ id: string; title: string }>>('/api/graph/work?limit=200', 0, { share: true });

  const rows = useMemo<RunRow[]>(() => {
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

  return { reports, rows, initiatives, work };
}

/** The Runs table's columns. `only` keeps a subset, in the table's own order (the Learning tab drops Initiative, which is its filter). */
export function runColumns(only?: ReadonlyArray<string>): DataTableColumn<RunRow>[] {
  const all: DataTableColumn<RunRow>[] = [
    { key: 'when', header: 'When', width: '112px', numeric: true, render: (r) => relativeTime(r.endedAt) },
    { key: 'what', header: 'What', render: (r) => (
      <RecordLink to={runHref(r.runRef)} data-testid="run-row-link"><T size="sm" title={r.what} className="block max-w-[32rem] truncate">{r.what}</T></RecordLink>
    ) },
    // Keep the run, timing, outcome, learned mark and cost in view. Secondary
    // fields remain available through the shared table's column controls.
    { key: 'initiative', header: 'Initiative', priority: 3, render: (r) => r.initiativeName ?? <T size="xs" tone="tertiary">—</T> },
    { key: 'who', header: 'Who ran it', priority: 2, render: (r) => r.who },
    { key: 'outcome', header: 'Outcome', width: '128px', render: (r) => (
      <Chip tone={OUTCOME_TONE[r.outcome]} size="xs">{OUTCOME_LABEL[r.outcome]}</Chip>
    ) },
    { key: 'failure', header: 'Failure', priority: 3, render: (r) => failureWords(r.failureCode) ?? <T size="xs" tone="tertiary">—</T> },
    { key: 'runbooks', header: 'Runbooks given', width: '120px', numeric: true, priority: 4, render: (r) => r.runbooksOffered.length },
    { key: 'learned', header: 'Learned', width: '88px', render: (r) => (learnedDot(r)
      ? <StatusDot size="sm" color="var(--color-success)" title="Filed a runbook proposal" aria-label="Filed a runbook proposal" />
      : <T size="xs" tone="tertiary">—</T>) },
    { key: 'debrief', header: 'Debrief', priority: 4, render: (r) => debriefWords(r) || <T size="xs" tone="tertiary">—</T> },
    { key: 'cost', header: 'Cost', render: (r) => {
      if (isSimulated(r)) return <Chip tone="neutral" size="xs">Demo data</Chip>;
      // A local run's figure is the worker's own, never money: the cell says "reported" and the hover says the rest.
      if (r.cost.basis === 'reported') return <T size="sm" title="Reported, not billed">{r.cost.reportedUsd != null ? `${usd(r.cost.reportedUsd)} reported` : 'Reported'}</T>;
      return costWords(r.cost, (n) => usd(n, { precision: 2 }));
    } },
  ];
  return only ? all.filter((c) => only.includes(String(c.key))) : all;
}
