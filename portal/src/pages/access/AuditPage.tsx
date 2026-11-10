// /access/audit — the append-only trail (docs/access-tenant-design.md §4.4):
// every request transition with its actor, before/after and reason, read from
// GET /api/access/audit. The server decides the scope — an access admin sees
// every event, anyone else the events of the requests they may open (the
// record's read rule) — and this page says so in its visible description.

import { ofTotal } from '../../lib/plural';
import { CollectionToolbar, DataTable, Stack } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ACCESS_API, auditScopeNotice, EVENT_LABELS, eventHref, filterEvents, type AccessEvent, type AccessEventKind, type ItemsResponse } from '../../lib/accessRequests';
import { EVENT_COLUMNS, eventTitle } from './accessColumns';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

const KIND_OPTIONS = [
  { value: '', label: 'Every event' },
  ...(Object.entries(EVENT_LABELS) as Array<[AccessEventKind, string]>).map(([value, label]) => ({ value, label })),
];


export default function AuditPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<AccessEvent>>(`${ACCESS_API}/audit`, 60_000);
  const all = data?.items ?? [];
  const rows = filterEvents(all, query, kind);
  const scope = auditScopeNotice(session?.role);

  const adapter = accessCollectionAdapter('audit', {
    setQuery, setFilter: setKind, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for the audit trail to load before opening an event.');
      const e = resolveAccessTarget(target, rows.map((row) => ({ ...row, title: eventTitle(row) })));
      navigate(eventHref(e));
      return e.requestId ? `Opened the request behind “${eventTitle(e)}”. Nothing was changed.` : e.policyId ? `Opened the policy behind “${eventTitle(e)}”. Nothing was changed.` : `Opened the policies; “${eventTitle(e)}” names no policy. Nothing was changed.`;
    },
  });

  const page = ACCESS_SURFACES.audit;
  return (
    <CollectionCommandPage data-testid="access-audit" title={page.title} description={`${page.description} ${scope}`}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Audit filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search events', 'aria-label': 'Search events' },
            filters: [{ id: 'kind', label: 'Event', value: kind, onChange: setKind, options: KIND_OPTIONS }],
            summary: data ? `${ofTotal(rows.length, all.length, 'event')}` : undefined,
            notices: [scope],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="the access audit trail" source="Events are read from access_events, which is append-only" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="access-audit-table"
              data={rows}
              columns={EVENT_COLUMNS}
              keyField={(e) => e.id}
              loading={isLoading && !data}
              pageSize={25}
              onRowClick={(e) => navigate(eventHref(e))}
              emptyMessage={query.trim() || kind ? 'No event matches this search and kind.' : 'No access events have been recorded yet.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
