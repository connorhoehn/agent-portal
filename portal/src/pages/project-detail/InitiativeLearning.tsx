// The initiative's Learning tab: what the learning loop knows about this initiative, as three tables, densest
// first: its runs (with outcomes), the runbooks scoped to it and the proposals still open for it. The runs use
// the Runs page's own rows and cells; the runbooks and proposals use the Library's and Proposals' row models.
// Each read is the route's own, so a role a route refuses sees that route's refusal here and nothing else.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Button, Chip, DataTable, PageSection, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { runColumns, runHref, useRunRows } from '../iq/runRows';
import { runsListHref } from '../iq/runsModel';
import { HEALTH_LABEL, HEALTH_TONE, KIND_LABEL, libraryRows, proposalAuthor, proposalHref, proposalRows, runbookHref, type LibraryRow, type ProposalRow } from '../runbooks/runbooksModel';
import type { Proposal, RunbookRow } from '../runbooks/types';
import { useRunbookNames } from '../runbooks/useRunbookNames';

const RUN_COLUMNS = ['when', 'what', 'who', 'outcome', 'failure', 'learned', 'debrief'];
const NO_FILTERS = { executor: '', outcome: '', debrief: '' };

interface RunbookLine extends LibraryRow { given: number; openProposals: number }
interface ProposalLine extends ProposalRow { by: string; filed: string }

export function InitiativeLearning({ initiativeId }: { initiativeId: string }) {
  const navigate = useNavigate();
  const names = useRunbookNames();
  const { reports, rows: runs } = useRunRows({ ...NO_FILTERS, initiative: initiativeId });
  const scoped = useFetch<{ runbooks: RunbookRow[] }>(
    `/api/runbooks?status=draft,published&scope_kind=initiative&scope_ref=${encodeURIComponent(initiativeId)}&limit=200`, 0);
  const proposalsRead = useFetch<{ proposals: Proposal[] }>(
    `/api/runbooks/proposals?initiative=${encodeURIComponent(initiativeId)}&status=open&limit=200`, 0);
  // The same shared read the Library and Proposals pages make: a proposal's title is its runbook's.
  const library = useFetch<{ runbooks: RunbookRow[] }>('/api/runbooks?status=draft,published,retired&limit=200', 0, { share: true });

  const runbookLines = useMemo<RunbookLine[]>(() => {
    const all = scoped.data?.runbooks ?? [];
    const byId = new Map(all.map((r) => [r.id, r]));
    return libraryRows(all, '', null, names).map((row) => ({
      ...row,
      given: runs.filter((r) => r.runbooksOffered.some((o) => o.id === row.id)).length,
      openProposals: byId.get(row.id)?.open_proposals ?? 0,
    }));
  }, [scoped.data, names, runs]);

  const proposalLines = useMemo<ProposalLine[]>(() => {
    const open = (proposalsRead.data?.proposals ?? []).filter((p) => p.status === 'open' && !p.expired);
    const titles = new Map((library.data?.runbooks ?? []).map((r) => [r.id, r.title]));
    const byId = new Map(open.map((p) => [p.id, p]));
    return proposalRows(open, titles, '', names).map((row) => ({
      ...row, by: proposalAuthor(byId.get(row.id)!, names).name, filed: relativeTime(byId.get(row.id)!.created_at),
    }));
  }, [proposalsRead.data, library.data, names]);

  const runbookColumns: DataTableColumn<RunbookLine>[] = [
    { key: 'title', header: 'Runbook', render: (r) => <RecordLink to={runbookHref(r.id)} data-testid="learning-runbook-link"><T size="sm">{r.title}</T></RecordLink> },
    { key: 'health', header: 'Health', width: '112px', render: (r) => <Chip tone={HEALTH_TONE[r.health]} size="xs">{HEALTH_LABEL[r.health]}</Chip> },
    { key: 'status', header: 'Status', width: '112px', priority: 3, render: (r) => r.status.charAt(0).toUpperCase() + r.status.slice(1) },
    { key: 'given', header: 'Given to these runs', width: '152px', numeric: true, priority: 2, render: (r) => r.given },
    { key: 'open', header: 'Open proposals', width: '136px', numeric: true, priority: 4, render: (r) => r.openProposals },
  ];
  const proposalColumns: DataTableColumn<ProposalLine>[] = [
    { key: 'title', header: 'Proposal', render: (p) => <RecordLink to={proposalHref(p.id)} data-testid="learning-proposal-link"><T size="sm">{p.title}</T></RecordLink> },
    { key: 'kind', header: 'Kind', width: '128px', render: (p) => <Chip tone="info" size="xs">{KIND_LABEL[p.kind]}</Chip> },
    { key: 'by', header: 'From', priority: 2, render: (p) => p.by },
    { key: 'filed', header: 'Filed', width: '112px', numeric: true, render: (p) => p.filed },
  ];

  return (
    <Stack gap="lg" data-testid="initiative-learning">
      <PageSection size="sm" title="Runs" {...(reports.data ? { count: runs.length } : {})} data-testid="learning-runs"
        actions={<Button variant="link" onClick={() => navigate(runsListHref({ initiative: initiativeId }))} data-testid="learning-all-runs">All runs</Button>}>
        {reports.error
          ? <UnavailableNotice error={reports.error} what="run reports" source="Run reports are read from the run report store" onRetry={reports.refresh} />
          : <DataTable narrow responsiveColumns hiddenColumnsControl="header" data={runs} columns={runColumns(RUN_COLUMNS)}
              keyField={(r) => r.runRef} loading={reports.isLoading && !reports.data} pageSize={10}
              onRowClick={(r) => navigate(runHref(r.runRef))} data-testid="learning-runs-table"
              emptyMessage="No run has reported on this initiative yet. A run on one of its work items puts one here." />}
      </PageSection>

      <PageSection size="sm" title="Runbooks" {...(scoped.data ? { count: runbookLines.length } : {})} data-testid="learning-runbooks">
        {scoped.error
          ? <UnavailableNotice error={scoped.error} what="runbooks" source="Runbooks are read from the runbook store" onRetry={scoped.refresh} />
          : <DataTable narrow responsiveColumns hiddenColumnsControl="header" data={runbookLines} columns={runbookColumns}
              keyField={(r) => r.id} loading={scoped.isLoading && !scoped.data} pageSize={10}
              onRowClick={(r) => navigate(runbookHref(r.id))} data-testid="learning-runbooks-table"
              emptyMessage="No runbook is scoped to this initiative. One appears when a proposal with this scope is accepted." />}
      </PageSection>

      <PageSection size="sm" title="Open proposals" {...(proposalsRead.data ? { count: proposalLines.length } : {})} data-testid="learning-proposals">
        {proposalsRead.error
          ? <UnavailableNotice error={proposalsRead.error} what="runbook proposals" source="Proposals are read from the runbook store" onRetry={proposalsRead.refresh} />
          : <DataTable narrow responsiveColumns hiddenColumnsControl="header" data={proposalLines} columns={proposalColumns}
              keyField={(p) => p.id} loading={proposalsRead.isLoading && !proposalsRead.data} pageSize={10}
              onRowClick={(p) => navigate(proposalHref(p.id))} data-testid="learning-proposals-table"
              emptyMessage="No proposal is open for this initiative. One arrives when a run on it, or a colleague, suggests a runbook." />}
      </PageSection>
    </Stack>
  );
}
