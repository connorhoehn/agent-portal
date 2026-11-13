// /iq/my-work — the signed-in person's open work items across every initiative, one table: key, title,
// initiative, type, status, sprint, updated. In progress first, then in review, then open, newest first.
// A row opens the work item on its initiative's Work tab (where work items open everywhere else); the
// initiative cell opens the initiative. Read from GET /api/graph/work?assignee=me, which resolves "me" from
// the session on the server, so the page never names a person.
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { DataTable, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { workItemHref } from '../project-detail/overviewModel';
import type { Sprint } from '../sprints/types';
import {
  MY_WORK_URL, STATUS_OPTIONS, TYPE_OPTIONS, initiativeHref, initiativeOptions, myWorkEmptyMessage, myWorkRows, statusLabel, typeLabel,
  type MyWorkItem,
} from './myWorkModel';

export default function MyWorkPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = { status: params.get('status') ?? '', initiative: params.get('initiative') ?? '', type: params.get('type') ?? '' };
  const set = (key: keyof typeof filters, value: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (value) p.set(key, value); else p.delete(key); return p; }, { replace: true });

  const feed = useFetch<MyWorkItem[]>(MY_WORK_URL, 30_000);
  const sprints = useFetch<{ sprints: Sprint[] }>('/api/sprints', 0, { share: true });
  const sprintNames = useMemo(() => new Map((sprints.data?.sprints ?? []).map((s) => [s.id, s.name])), [sprints.data]);
  const all = Array.isArray(feed.data) ? feed.data : [];
  const rows = useMemo(() => myWorkRows(all, filters), [all, filters.status, filters.initiative, filters.type]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Boolean(filters.status || filters.initiative || filters.type);
  // An empty feed reads the same for "no linked person" and "linked, nothing open"; only the session knows which.
  const person = useFetch<{ linked: boolean }>(feed.data && all.length === 0 ? '/api/session/person' : null, undefined, { share: true });

  const columns: DataTableColumn<MyWorkItem>[] = [
    { key: 'key', header: 'Key', width: '112px', render: (i) => <T size="sm">{i.key ?? '—'}</T> },
    { key: 'title', header: 'Title', render: (i) => <T size="sm" title={i.title} className="block max-w-[32rem] truncate">{i.title}</T> },
    { key: 'initiative', header: 'Initiative', width: '208px', priority: 4, render: (i) => (
      <RecordLink to={initiativeHref(i.projectId)} data-testid="my-work-initiative"><T size="sm" className="block max-w-[12rem] truncate">{i.projectName}</T></RecordLink>
    ) },
    { key: 'type', header: 'Type', width: '88px', priority: 3, render: (i) => <T size="sm">{typeLabel(i.type)}</T> },
    { key: 'status', header: 'Status', width: '112px', render: (i) => <T size="sm">{statusLabel(i.status)}</T> },
    { key: 'sprint', header: 'Sprint', width: '144px', priority: 5, render: (i) => <T size="sm" className="block truncate">{(i.sprintId && sprintNames.get(i.sprintId)) || '—'}</T> },
    { key: 'updated', header: 'Updated', width: '112px', numeric: true, priority: 2, render: (i) => relativeTime(i.updatedAt) },
  ];

  return (
    <CollectionCommandPage
      data-testid="iq-my-work"
      title="My work"
      description="Your open work items across every initiative."
      toolbar={{
        label: 'My work filters',
        filters: [
          { id: 'status', label: 'Status', value: filters.status, onChange: (v) => set('status', v), options: STATUS_OPTIONS },
          { id: 'initiative', label: 'Initiative', value: filters.initiative, onChange: (v) => set('initiative', v), options: initiativeOptions(all) },
          { id: 'type', label: 'Type', value: filters.type, onChange: (v) => set('type', v), options: TYPE_OPTIONS },
        ],
        summary: feed.data ? `${rows.length} ${rows.length === 1 ? 'work item' : 'work items'}` : undefined,
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
        keyField={(i) => i.id}
        loading={feed.isLoading && !feed.data}
        pageSize={25}
        onRowClick={(i) => navigate(workItemHref(i.projectId, i.id))}
        data-testid="iq-my-work-table"
        emptyMessage={myWorkEmptyMessage(filtered, person.data ? person.data.linked : null)}
      />
    </CollectionCommandPage>
  );
}
