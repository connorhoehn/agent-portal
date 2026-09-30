// The chat workspace's Calls destination (`/social/calls`, the shelf's Calls):
// your call log (docs/social-tenant-design.md §4.5, lane S2).
//
// The log is platform-api's (`/api/calls/log`, one row per person a call
// touched), read through the BFF (`GET /api/social/calls`), which keeps only
// `social:` lobbies — a person's log upstream is keyed by user, not tenant.
// SocialLayout writes it (socialCallLog.ts). A missed call also reaches the
// header bell (the gateway's `calls({ onCallMissed })`, design §3.4 row 6), and
// an incoming ring is the shell's toast — both already on every social page.
//
// Call back: a DM call rings the same people again (`social:dm:<ids>`); a room
// call walks back into the room. A new call starts from a person (Contacts,
// Active now) or a conversation.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button, Chip, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, SegmentedControl, Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { callBackTargets, callRows, roomSlugFromLobby, type CallRow, type NameOf, type SocialCall as SocialCallEntry, type SocialRoom, type SocialSource } from './socialPlatform';
import type { SocialCall } from './useSocialCall';

export interface CallsResponse { source: SocialSource; calls: SocialCallEntry[]; counts: { total: number; missed: number } }
type Filter = 'all' | 'missed';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The workspace fetches the log once (the shelf's Calls badge counts its missed calls). */
export interface CallsFetch { data: CallsResponse | null; isLoading: boolean; error: string | null; refresh: () => void }

export default function CallLogPane({ calls, me, nameOf, rooms, call }: { calls: CallsFetch; me: string; nameOf: NameOf; rooms: readonly SocialRoom[]; call: SocialCall }) {
  const navigate = useNavigate();
  const { data, isLoading, error, refresh } = calls;
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => {
    const all = callRows(data?.calls ?? [], me, nameOf, rooms);
    return filter === 'missed' ? all.filter((r) => r.missed) : all;
  }, [data, me, nameOf, rooms, filter]);

  const callBack = (row: CallRow) => {
    const room = roomSlugFromLobby(row.lobbyName);
    if (room) { navigate(`/social/rooms?room=${encodeURIComponent(room)}`); return; }
    const ids = callBackTargets(row.lobbyName, me);
    if (ids?.length) call.callPeople(ids.map((id) => ({ userId: id, displayName: nameOf(id) })));
  };

  const columns: DataTableColumn<CallRow>[] = [
    { key: 'who', header: 'Who', sortable: true },
    { key: 'direction', header: 'Direction', width: '120px' },
    {
      key: 'outcome', header: 'Outcome', width: '130px',
      render: (r) => <Chip tone={r.missed ? 'danger' : 'neutral'} size="xs">{r.outcome}</Chip>,
    },
    { key: 'startedAt', header: 'When', width: '170px', sortable: true, render: (r) => when(r.startedAt) },
    { key: 'duration', header: 'Length', width: '100px', align: 'right' },
  ];

  const missed = data?.counts.missed ?? 0;
  return (
    <Stack gap="md" className="min-h-0 min-w-0 overflow-y-auto" data-testid="social-call-log-pane">
      <PageHeader
        title="Calls"
        description="Calls you placed, answered or missed in this workspace. Start a new one from a person or a conversation, or join a room."
        {...(missed ? { badge: <Chip tone="danger" size="xs" data-testid="social-calls-missed">{missed} missed</Chip> } : {})}
        actions={<Button variant="secondary" size="sm" onClick={() => navigate('/social/contacts')}>Call someone</Button>}
      />
      {isLoading && !data ? <LoadingState label="Loading your calls…" /> : error && !data ? (
        <ErrorState title="Your calls could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : (data?.calls.length ?? 0) === 0 ? (
        <EmptyState testId="social-empty-calls" align="start" title="No calls yet"
          description="Calls you place or receive in this workspace, and the ones you missed, are listed here."
          actionLabel="Call someone" onAction={() => navigate('/social/contacts')} />
      ) : (
        <Stack gap="sm">
          <SegmentedControl
            aria-label="Which calls"
            value={filter}
            onChange={(v: string) => setFilter(v as Filter)}
            options={[{ value: 'all', label: 'All' }, { value: 'missed', label: `Missed${missed ? ` (${missed})` : ''}` }]}
            data-testid="social-calls-filter"
          />
          <DataTable
            data={rows}
            columns={columns}
            keyField={(r) => r.id}
            emptyMessage="No missed calls."
            rowActions={(r) => (
              <Button variant="ghost" size="sm" disabled={!!call.unavailable} onClick={() => callBack(r)} data-testid="social-call-back">
                {roomSlugFromLobby(r.lobbyName) ? 'Open room' : 'Call back'}
              </Button>
            )}
            data-testid="social-call-log"
          />
        </Stack>
      )}
    </Stack>
  );
}
