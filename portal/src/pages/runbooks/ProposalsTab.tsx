// Runbooks → Proposals: every proposal in a list rail (Open / Decided) and the review page beside it
// (/iq/runbooks/proposals/:pid). Withdrawing is not offered: the API has no withdraw route.
import { useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import { WorkListFilters } from '@connorhoehnslalom/ui-components';
import { EmptyState, FilterPopover, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useRunbookNames } from './useRunbookNames';
import { ProposalReview } from './ProposalReview';
import { RunbooksListFrame } from './RunbooksListFrame';
import type { RunbooksOutletContext } from './RunbooksModule';
import {
  PROPOSAL_STATUS_FILTERS, proposalGroups, proposalHref, proposalRows, proposalsCommandAdapter,
} from './runbooksModel';
import type { Proposal, RunbookRow } from './types';

export default function ProposalsTab() {
  const { pid } = useParams();
  const navigate = useNavigate();
  const { breadcrumbs, refreshProposals } = useOutletContext<RunbooksOutletContext>();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const feed = useFetch<{ proposals: Proposal[] }>('/api/runbooks/proposals?limit=200', 0);
  const library = useFetch<{ runbooks: RunbookRow[] }>('/api/runbooks?status=draft,published,retired&limit=200', 0);
  const titles = useMemo(() => new Map((library.data?.runbooks ?? []).map((r) => [r.id, r.title])), [library.data]);
  const names = useRunbookNames();
  const all = feed.data?.proposals ?? [];
  const rows = useMemo(
    () => proposalRows(status ? all.filter((p) => p.status === status) : all, titles, query, names),
    [all, titles, query, status, names],
  );
  const commands = proposalsCommandAdapter(rows, {
    setQuery, setStatus, refresh: feed.refresh, open: (id) => navigate(proposalHref(id)),
  });
  const openCount = all.filter((p) => p.status === 'open').length;

  return (
    <RunbooksListFrame
      breadcrumbs={breadcrumbs}
      title="Proposals"
      description="Edits and new runbooks that runs and colleagues suggest. A reviewer reads the diff, then accepts, rejects or merges."
      listTitle="Proposals"
      {...(feed.data ? { count: openCount } : {})}
      listLabel="proposals"
      query={query}
      onQuery={setQuery}
      searchLabel="Search proposals"
      filter={(
        <FilterPopover trigger="icon" size="sm" label="Filter" activeCount={status ? 1 : 0} onClear={() => setStatus(null)} panelLabel="Filter proposals">
          <WorkListFilters
            data-testid="proposals-filters"
            facets={[{
              id: 'status', label: 'Status',
              options: Object.keys(PROPOSAL_STATUS_FILTERS).map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })),
              selected: status ? [status] : [],
              onChange: (sel) => setStatus(sel.length ? sel[sel.length - 1]! : null),
            }]}
          />
        </FilterPopover>
      )}
      loading={feed.isLoading && !feed.data}
      error={feed.error}
      onRetry={feed.refresh}
      errorWhat="the proposals"
      errorSource="Proposals are read from the runbook store"
      groups={proposalGroups(rows)}
      rows={rows.map((r) => ({ id: r.id, groupId: r.groupId, title: r.title, subline: r.subline }))}
      currentId={pid ?? null}
      onOpen={(id) => navigate(proposalHref(id))}
      emptyTitle="No proposals"
      emptyDescription="Nothing is waiting for review. A run or a colleague can suggest an edit from a runbook’s page."
      onClear={() => setQuery('')}
      storageKey="runbooks.proposals.groups"
      footerNote={feed.data ? `${rows.length} of ${all.length} proposals` : 'Loading…'}
      commands={commands}
      data-testid="runbooks-proposals"
    >
      {pid ? (
        <ProposalReview
          key={pid}
          pid={pid}
          published={library.data?.runbooks ?? []}
          publishedLoading={library.isLoading && !library.data}
          onOpen={(href) => navigate(href)}
          onDecided={() => { feed.refresh(); library.refresh(); refreshProposals(); }}
        />
      ) : (
        <Stack gap="md" className="w-full max-w-3xl px-6 pb-6">
          <EmptyState title={feed.isLoading ? 'Loading…' : openCount ? 'Choose a proposal' : 'Nothing to review'} description="Pick a proposal from the list to read its diff." />
        </Stack>
      )}
    </RunbooksListFrame>
  );
}
