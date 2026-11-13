// /iq/meetings — the meetings the signed-in person attended with the meeting assistant present, newest first, one table.
// Read from GET /api/meetings, which only ever returns the caller's own.
import { useNavigate } from 'react-router';
import { DataTable, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { MEETINGS_URL, meetingHref, peopleLabel, summaryLine, type MeetingListRow } from './meetingsModel';

export default function MeetingsPage() {
  const navigate = useNavigate();
  const feed = useFetch<{ meetings: MeetingListRow[] }>(MEETINGS_URL, 60_000);
  const rows = feed.data?.meetings ?? [];

  const columns: DataTableColumn<MeetingListRow>[] = [
    { key: 'name', header: 'Meeting', width: '240px', render: (r) => <T size="sm" className="block max-w-[14rem] truncate" title={r.callName}>{r.callName}</T> },
    { key: 'when', header: 'When', width: '128px', numeric: true, render: (r) => <T size="sm" title={new Date(r.endedAt).toLocaleString()}>{relativeTime(new Date(r.endedAt).toISOString())}</T> },
    { key: 'people', header: 'People', width: '256px', priority: 3, render: (r) => <T size="sm" className="block max-w-[16rem] truncate" title={r.attendees.join(', ')}>{peopleLabel(r.attendees)}</T> },
    { key: 'summary', header: 'Summary', render: (r) => <T size="sm" className="block max-w-[40rem] truncate" title={r.summary}>{summaryLine(r.summary)}</T> },
    { key: 'items', header: 'Decisions · actions', width: '152px', priority: 2, render: (r) => <T size="sm">{r.decisionCount} · {r.actionItemCount}</T> },
  ];

  return (
    <CollectionCommandPage
      data-testid="iq-meetings"
      title="Meetings"
      description="Calls where Nova listened, with their minutes and transcript. Only the people who were in a call see it here."
      toolbar={{
        label: 'Meetings',
        filters: [],
        summary: feed.data ? `${rows.length} ${rows.length === 1 ? 'meeting' : 'meetings'}` : undefined,
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
        keyField={(r) => r.callId}
        loading={feed.isLoading && !feed.data}
        pageSize={25}
        onRowClick={(r) => navigate(meetingHref(r.callId))}
        data-testid="iq-meetings-table"
        emptyMessage="No meetings yet. When Nova leaves a call you were in, its minutes are kept here."
      />
    </CollectionCommandPage>
  );
}
