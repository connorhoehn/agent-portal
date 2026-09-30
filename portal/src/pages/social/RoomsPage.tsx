// /social/rooms — standing rooms you can drop into (docs/social-tenant-design.md
// §4.5, lane S2).
//
// The rooms are platform-api's (partition `social`), read through the BFF
// (`GET /api/social/rooms`: tenant-scoped, team channels left to Teams; a
// private room is listed to its creator and members only). The list is the
// library's hook-bound rooms section — `createWrappedHangoutRoomsList` over
// `createHangoutRoomsSection` over `createHangoutRoomRow` bound to
// realtime-modules' `useRoomOccupancy` — handed the BFF's rows in the shape
// `useHangoutRooms()` returns (socialPlatform.ts `hangoutRoomsFrom`), because
// creating one is Cedar-gated at the BFF (ManageChannels) and platform-api
// alone would let anyone.
//
// Clicking a room joins its call — `social:room:<slug>`, through the shell's
// call host (useSocialCall), which draws the dock above the page. The room's
// details (who may enter, who made it) sit beside the list.

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import * as hangoutRooms from '@connorhoehnslalom/realtime-modules/client/hangout-rooms';
import {
  createHangoutRoomRow, createHangoutRoomsSection, createWrappedHangoutRoomsList, NewHangoutRoomDialog,
} from '@connorhoehnslalom/ui-components/integrations/realtime';
import {
  Button, Card, Chip, EmptyState, ErrorState, Inline, InlineAlert, KeyValue, LoadingState, Modal, PageHeader, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { hangoutRoomsFrom, namesFrom, type SocialRoom, type SocialSource } from './socialPlatform';
import { useSocialCall } from './useSocialCall';
import type { SocialPerson } from './socialChat';

const HangoutRoomRow = createHangoutRoomRow({ useRoomOccupancy: hangoutRooms.useRoomOccupancy });
const HangoutRoomsSection = createHangoutRoomsSection(HangoutRoomRow);
const RoomsList = createWrappedHangoutRoomsList(HangoutRoomsSection);

interface RoomsResponse { source: SocialSource; rooms: SocialRoom[]; counts: { total: number; open: number; private: number } }

export default function RoomsPage() {
  const { can, ready } = useCapabilities();
  const mayCreate = ready && can('ManageChannels');
  const { data, isLoading, error, refresh } = useFetch<RoomsResponse>('/api/social/rooms', 15_000);
  const people = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const nameOf = useMemo(() => namesFrom(people.data?.people ?? []), [people.data]);
  const [params, setParams] = useSearchParams();
  const selected = params.get('room');
  const call = useSocialCall();
  // The empty state's own create dialog: `renderEmpty` replaces the whole
  // section, its + with it.
  const [creating, setCreating] = useState(false);

  const rooms = useMemo(() => hangoutRoomsFrom({
    rooms: data?.rooms ?? null,
    isLoading,
    error,
    refetch: refresh,
    create: async (body) => {
      const res = await writeJson<{ room: SocialRoom }>('/api/social/rooms', 'POST', body);
      if (!res.ok || !res.data) throw new Error(res.error ?? 'The room could not be created.');
      refresh();
      return res.data.room;
    },
  }), [data, isLoading, error, refresh]);

  const open = data?.rooms.find((r) => r.slug === selected) ?? null;
  const select = (slug: string | null) => setParams(slug ? { room: slug } : {}, { replace: true });

  const renderCreateDialog = ({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) => (mayCreate
    ? <NewHangoutRoomDialog open={isOpen} onClose={onClose} onCreate={rooms.createRoom as never} onCreated={(room: { slug: string }) => select(room.slug)} />
    : (
      <Modal open={isOpen} onClose={onClose} title="Rooms are opened by moderators" maxWidth={420}
        footer={<Button variant="primary" size="sm" onClick={onClose}>OK</Button>}>
        Anyone here can join a room. Opening a new one takes a moderator or a community admin — ask one in #general.
      </Modal>
    ));

  return (
    <Stack gap="lg" data-testid="social-rooms-page">
      <PageHeader
        title="Rooms"
        description="Standing rooms you can drop into without scheduling a call."
        {...(data ? { badge: <Chip tone="neutral" size="xs">{data.counts.total} {data.counts.total === 1 ? 'room' : 'rooms'}</Chip> } : {})}
      />
      {call.notice && <InlineAlert tone="warning" onDismiss={call.clearNotice}>{call.notice}</InlineAlert>}
      {isLoading && !data ? <LoadingState label="Loading rooms…" /> : error && !data ? (
        <ErrorState title="Rooms could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : (
        <Inline gap="lg" align="start" wrap={false}>
          <Card padding="sm" className="w-80 shrink-0" data-testid="social-rooms-list">
            <RoomsList
              hangoutRooms={rooms as never}
              title="Rooms"
              storageKey="social-rooms"
              onJoin={(slug: string) => select(slug)}
              renderCreateDialog={renderCreateDialog}
              renderEmpty={(
                <EmptyState
                  testId="social-empty-rooms"
                  align="start"
                  title="No rooms yet"
                  description={mayCreate
                    ? 'A room stays open between calls, so a group can gather in the same place every time. Open the first one.'
                    : 'A room stays open between calls. None are open to you yet; a moderator can open one.'}
                  {...(mayCreate ? { actionLabel: 'New room', onAction: () => setCreating(true), actionTestId: 'social-empty-new-room' } : {})}
                />
              )}
            />
          </Card>
          {mayCreate && renderCreateDialog({ open: creating, onClose: () => setCreating(false) })}
          {!open ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId={selected ? 'social-room-missing' : 'social-room-pick'}
              title={selected ? 'This room is not available' : 'Pick a room'}
              description={selected
                ? 'It does not exist, or it is private and you are not one of its members.'
                : 'Choose a room on the left to see who can join it, then join its call.'} />
          ) : (
            <Card padding="md" className="min-w-0 flex-1" data-testid="social-room-detail">
              <Stack gap="md">
                <PageHeader
                  title={open.name}
                  {...(open.description ? { description: open.description } : {})}
                  badge={<Chip tone={open.visibility === 'private' ? 'warning' : 'neutral'} size="xs">{open.visibility === 'private' ? 'Private' : 'Open to the workspace'}</Chip>}
                  actions={call.activeLobby === open.lobbyName
                    ? <Button variant="secondary" size="sm" onClick={call.leave} data-testid="social-room-leave">Leave call</Button>
                    : <Button variant="primary" size="sm" disabled={!!call.unavailable} onClick={() => call.joinRoom(open)} data-testid="social-room-join">Join call</Button>}
                />
                {call.unavailable && <InlineAlert tone="info">{call.unavailable}</InlineAlert>}
                <KeyValue
                  items={[
                    { label: 'Who can join', value: open.visibility === 'private' ? 'Its creator and the members they add' : 'Everyone in this workspace' },
                    { label: 'Opened by', value: nameOf(open.createdBy) },
                    { label: 'Call', value: open.settings.audioOnly ? 'Audio only' : 'Audio and video' },
                    { label: 'Recording', value: open.settings.recordingEnabled ? 'Allowed' : 'Off' },
                    { label: 'Lobby', value: open.lobbyName },
                  ]}
                  data-testid="social-room-facts"
                />
              </Stack>
            </Card>
          )}
        </Inline>
      )}
    </Stack>
  );
}
