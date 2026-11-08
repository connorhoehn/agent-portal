// /access/approvals — the inbox (docs/access-tenant-design.md §4.2): the
// requests whose current step the signed-in user may decide NOW, resolved live
// by GET /api/access/approvals (DecideAccess). A row opens the record, where
// approve / reject / request information are explicit controls with a comment
// and a confirmation. Bulk decisions are deliberately absent.

import { CollectionToolbar, DataTable, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import {
  ACCESS_API,
  STEP_KIND_LABELS,
  currentStep,
  filterRequests,
  requestHref,
  requestTitle,
  type AccessRequest,
  type ItemsResponse,
} from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';
import { REQUEST_COLUMNS } from './accessColumns';

/** The step the viewer may decide; a delegate's row names whom they decide it for (2026-10-14). */
function yourStep(r: AccessRequest, viewerId: string | undefined): string {
  const s = currentStep(r);
  if (!s) return '—';
  const forWhom = s.eligible.find((p) => p.id === viewerId)?.onBehalfOf;
  return `${s.step} · ${STEP_KIND_LABELS[s.kind] ?? s.kind}${forWhom ? ` · for ${forWhom.displayName}` : ''}`;
}

const columnsFor = (viewerId: string | undefined): DataTableColumn<AccessRequest>[] => [
  ...REQUEST_COLUMNS.filter((c) => c.key !== 'waiting' && c.key !== 'status'),
  { key: 'requester', header: 'Asked by', render: (r) => r.requester.displayName },
  {
    key: 'step', header: 'Your step',
    render: (r) => { const label = yourStep(r, viewerId); return <T size="sm" title={label} className="block max-w-[14rem] truncate">{label}</T>; },
  },
];

export default function ApprovalsPage() {
  const { session } = useSession();
  return <ApprovalsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function ApprovalsWorkspace() {
  const navigate = useNavigate();
  const { session } = useSession();
  const COLUMNS = columnsFor(session?.sub);
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<AccessRequest>>(`${ACCESS_API}/approvals`, 30_000);
  const all = data?.items ?? [];
  const rows = filterRequests(all, query, '');

  const adapter = accessCollectionAdapter('approvals', {
    setQuery, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for approvals to load before opening one.');
      const r = resolveAccessTarget(target, rows.map((row) => ({ ...row, title: requestTitle(row) })));
      navigate(requestHref(r.id));
      return `Opened ${requestTitle(r)} for review. No decision was recorded.`;
    },
  });

  const page = ACCESS_SURFACES.approvals;
  return (
    <CollectionCommandPage data-testid="access-approvals" title={page.title} description={page.description}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Approval filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search approvals', 'aria-label': 'Search approvals' },
            summary: data ? `${rows.length} waiting on you` : undefined,
            notices: ['You never see a request you submitted or benefit from here: nobody decides their own request.'],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="your approvals" source="Approvals are the current steps of open requests that you may decide" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-approvals-table"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              loading={isLoading && !data}
              pageSize={25}
              onRowClick={(r) => navigate(requestHref(r.id))}
              emptyMessage={query.trim() ? 'No waiting request matches this search.' : 'Nothing is waiting on your decision.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
