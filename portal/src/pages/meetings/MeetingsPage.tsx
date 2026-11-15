// /iq/meetings — the meetings the signed-in person attended with Nova present, newest first, one table.
// Read from GET /api/meetings, which only ever returns the caller's own. The first page refreshes every minute; older meetings
// follow the server's `next` cursor with "Load older meetings" under the table (the library table pages only on the client).
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { AvatarGroup, Button, Chip, DataTable, Inline, Stack, T, Tooltip, VisuallyHidden, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { useFetch } from '../../hooks/useFetch';
import { responseFailure } from '../../lib/apiFailure';
import { relativeTime } from '../../lib/relativeTime';
import { MEETINGS_URL, listenedLabel, listLead, meetingHref, meetingsUrl, mergeMeetings, outcomesLabel, peopleLabel, waitingLabel, type MeetingListRow } from './meetingsModel';

interface MeetingsPage { meetings: MeetingListRow[]; next: number | null }

export default function MeetingsPage() {
  const navigate = useNavigate();
  const feed = useFetch<MeetingsPage>(MEETINGS_URL, 60_000);
  // Older pages, loaded on request; `older.next` is the cursor for the page after them (undefined until one was loaded).
  const [older, setOlder] = useState<{ rows: MeetingListRow[]; next: number | null | undefined; loading: boolean; error: string | null }>({ rows: [], next: undefined, loading: false, error: null });
  const rows = mergeMeetings(feed.data?.meetings ?? [], older.rows);
  const next = older.next === undefined ? feed.data?.next ?? null : older.next;
  const loadOlder = useCallback(async () => {
    if (!next) return;
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const res = await fetch(meetingsUrl(next), { credentials: 'include' });
      if (!res.ok) throw new Error((await responseFailure(res)).message);
      const page = await res.json() as MeetingsPage;
      setOlder((o) => ({ rows: [...o.rows, ...page.meetings], next: page.next, loading: false, error: null }));
    } catch (err) {
      setOlder((o) => ({ ...o, loading: false, error: `Could not load older meetings: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }, [next]);

  // Meeting (its name; the summary's lead as a quiet second line) · When · Length (Nova's listening) · People · Outcomes, and the
  // "N waiting on you" chip. Every count comes from the server, for this viewer.
  const columns: DataTableColumn<MeetingListRow>[] = [
    { key: 'name', header: 'Meeting', render: (r) => {
      const lead = listLead(r);
      return (
        <Stack gap="none" className="min-w-0">
          <T size="sm" weight="medium" truncate title={r.callName}>{r.callName}</T>
          {lead && <T size="sm" tone="secondary" truncate title={lead} data-testid="iq-meetings-lead">{lead}</T>}
        </Stack>
      );
    } },
    { key: 'when', header: 'When', width: '112px', render: (r) => <T size="sm" title={new Date(r.endedAt).toLocaleString()}>{relativeTime(new Date(r.endedAt).toISOString())}</T> },
    { key: 'length', header: 'Length', width: '96px', priority: 2, render: (r) => <T size="sm" tone="secondary" tabular>{listenedLabel(r.listenedSeconds) ?? '—'}</T> },
    { key: 'people', header: 'People', width: '128px', priority: 1, render: (r) => (r.attendees.length ? (
      <Tooltip content={r.attendees.join(', ')} triggerClassName="inline-flex items-center">
        <Inline as="span" gap="none" wrap={false} tabIndex={0} aria-label={peopleLabel(r.attendees)} data-testid="iq-meetings-people">
          <AvatarGroup names={r.attendees} size={22} maxVisible={4} />
          <VisuallyHidden>{peopleLabel(r.attendees)}</VisuallyHidden>
        </Inline>
      </Tooltip>
    ) : null) },
    { key: 'outcomes', header: 'Outcomes', width: '320px', render: (r) => {
      const waiting = waitingLabel(r.waitingOnYou);
      const outcomes = outcomesLabel(r.outcomes);
      return (
        <Inline gap="sm" wrap={false} className="min-w-0">
          {outcomes && <T size="sm" tone="secondary" truncate data-testid="iq-meetings-outcomes">{outcomes}</T>}
          {waiting && <Chip size="xs" tone="warning" data-testid="iq-meetings-waiting">{waiting}</Chip>}
        </Inline>
      );
    } },
  ];

  return (
    <CollectionCommandPage
      data-testid="iq-meetings"
      title="Meetings"
      description="Meetings where Nova listened, with their minutes and transcript. Only the people who were in the call see them here."
      toolbar={{
        label: 'Meetings',
        filters: [],
        summary: feed.data ? `${rows.length} ${next ? 'newest ' : ''}${rows.length === 1 ? 'meeting' : 'meetings'}` : undefined,
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
        pageSize={1000}
        onRowClick={(r) => navigate(meetingHref(r.callId))}
        data-testid="iq-meetings-table"
        emptyMessage="No meetings yet. When Nova leaves a call you were in, its minutes are kept here."
      />
      {(next || older.error) && (
        <Inline justify="center" gap="sm" className="pt-2">
          {next && <Button size="sm" variant="secondary" data-testid="iq-meetings-older" disabled={older.loading} onClick={() => { void loadOlder(); }}>
            {older.loading ? 'Loading older meetings…' : 'Load older meetings'}
          </Button>}
          {older.error && <T size="sm" tone="danger">{older.error}</T>}
        </Inline>
      )}
    </CollectionCommandPage>
  );
}
