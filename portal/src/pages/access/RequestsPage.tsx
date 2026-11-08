// /access/requests — the access product's front door (docs/access-tenant-design.md
// §4.1, §6): the signed-in user's requests and, for approvers, their reports'
// (GET /api/access/requests?scope=mine|reports|all). A row opens the record;
// "New request" opens the wizard. Nothing here decides or withdraws.

import { Button, CollectionToolbar, DataTable, PlusIcon, Stack } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import {
  ACCESS_API,
  REQUEST_STATUS_FILTERS,
  filterRequests,
  requestHref,
  requestTitle,
  type AccessRequest,
  type ItemsResponse,
} from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { useAnswerScope } from '../../components/collections/useAnswerScope';
import type { TenantAnswerFact } from '../../lib/tenantAnswer';
import { REQUEST_COLUMNS } from './accessColumns';
import { ACCESS_SURFACES } from './accessSurfaces';

type Scope = 'mine' | 'reports' | 'all';

const STATUS_OPTIONS = [{ value: '', label: 'Every status' }, ...REQUEST_STATUS_FILTERS];


export default function RequestsPage() {
  const { session } = useSession();
  return <RequestsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function RequestsWorkspace() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const decides = ready && can('DecideAccess');
  const mayRequest = ready && can('RequestAccess');
  const [params, setParams] = useSearchParams();
  // `?scope=reports|all` (the palette's "Reports' requests") opens that view; the toolbar keeps the URL in step.
  const scopeParam = params.get('scope');
  const scope: Scope = scopeParam === 'reports' || scopeParam === 'all' ? scopeParam : 'mine';
  const setScope = (next: Scope) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (next === 'mine') p.delete('scope'); else p.set('scope', next);
    return p;
  }, { replace: true });
  // `?status=open` (the palette's "Open requests") preselects the status filter.
  const [status, setStatus] = useState(() => REQUEST_STATUS_FILTERS.some((f) => f.value === params.get('status')) ? params.get('status')! : '');
  const [query, setQuery] = useState('');
  // "What has Rhea asked for" or "my rejected requests" answers as a fact; the table then lists the requests it
  // cites (a report's in the reports' view) until the answer is dismissed.
  const answered = useAnswerScope(['access:report-requests', 'access:my-requests']);
  const [answerView, setAnswerView] = useState<Scope | null>(null);
  const showAnswer = (answer: TenantAnswerFact | null) => {
    answered.showAnswer(answer);
    setAnswerView(answer?.intent === 'access:report-requests' && decides ? 'reports' : null);
  };
  const effectiveScope: Scope = decides ? (answerView ?? scope) : 'mine';
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<AccessRequest>>(`${ACCESS_API}/requests?scope=${effectiveScope}`, 30_000);
  const all = data?.items ?? [];
  const rows = filterRequests(all, query, status).filter((r) => !answered.keys || answered.keys.has(`request:${r.id}`));
  const open = (r: AccessRequest) => navigate(requestHref(r.id));

  const adapter = accessCollectionAdapter('requests', {
    setQuery, setFilter: setStatus, refresh, showAnswer,
    open(target) {
      if (!data || error) throw new Error('Wait for requests to load before opening one.');
      const r = resolveAccessTarget(target, rows.map((row) => ({ ...row, title: requestTitle(row) })));
      navigate(requestHref(r.id));
      return `Opened ${requestTitle(r)}. Nothing was changed.`;
    },
  });

  const page = ACCESS_SURFACES.requests;
  return (
    <CollectionCommandPage data-testid="access-requests" title={page.title} description={page.description}
      headerActions={mayRequest ? (
        <Button size="sm" variant="primary" onClick={() => navigate('/access/requests/new')} data-testid="access-new-request">
          <PlusIcon />New request
        </Button>
      ) : undefined}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Request filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search requests', 'aria-label': 'Search requests' },
            filters: [
              ...(decides ? [{
                id: 'scope', label: 'Whose', value: effectiveScope, emptyValue: 'mine', onChange: (v: string) => { setAnswerView(null); setScope((v || 'mine') as Scope); },
                options: [{ value: 'mine', label: 'Mine' }, { value: 'reports', label: 'My reports’' }, { value: 'all', label: 'Everyone’s' }],
              }] : []),
              { id: 'status', label: 'Status', value: status, onChange: setStatus, options: STATUS_OPTIONS },
            ],
            summary: data ? `${rows.length} of ${all.length} requests` : undefined,
            notices: decides ? ['“My reports’” lists requests for the people who report to you.'] : [],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="access requests" source="Requests are read from access_requests and their steps" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-requests-table"
              data={rows}
              columns={REQUEST_COLUMNS}
              keyField={(r) => r.id}
              loading={isLoading && !data}
              pageSize={25}
              onRowClick={open}
              emptyMessage={query.trim() || status ? 'No request matches this search and status.' : effectiveScope === 'mine' ? 'You have not requested any access yet.' : 'No requests in this view.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
