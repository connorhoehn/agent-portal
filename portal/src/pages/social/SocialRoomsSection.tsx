// The chat rail's Rooms section (SocialChatWorkspace's `beforeList`, beside the
// Teams tree). The library's ConversationRail has no rooms group, so this is
// the library's hook-bound rooms section — `createWrappedHangoutRoomsList` over
// `createHangoutRoomsSection` over `createHangoutRoomRow` bound to
// realtime-modules' `useRoomOccupancy` (no occupancy without an index subscription) — handed the
// BFF's rows in the shape `useHangoutRooms()` returns (socialPlatform.ts
// `hangoutRoomsFrom`), because creating one is Cedar-gated at the BFF
// (ManageChannels) and platform-api alone would let anyone.
//
// The rooms are platform-api's (partition `social`), read through the BFF
// (`GET /api/social/rooms`: tenant-scoped, team channels left to Teams; a
// private room is listed to its creator and members only). A row opens the
// room in the pane (`/social/rooms?room=<slug>`), where Join call is.

import { useMemo, useState } from 'react';
import * as hangoutRooms from '@connorhoehn/realtime-modules/client/hangout-rooms';
import {
  createHangoutRoomRow, createHangoutRoomsSection, createWrappedHangoutRoomsList, NewHangoutRoomDialog,
} from '@connorhoehnslalom/ui-components/integrations/realtime';
import { Button, LoadingState, Modal, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { writeJson } from '../../lib/writeJson';
import { useSocialPlane } from './socialPlane';
import { hangoutRoomsFrom, type SocialRoom, type SocialSource } from './socialPlatform';
import { SocialReadStatus } from './SocialReadStatus';
import { RAIL_SECTION_CONTENT_INSET, RailSectionHeader } from '@connorhoehnslalom/ui-components/social';

const HangoutRoomRow = createHangoutRoomRow({ useRoomOccupancy: hangoutRooms.useRoomOccupancy });
const HangoutRoomsSection = createHangoutRoomsSection(HangoutRoomRow);
const RoomsList = createWrappedHangoutRoomsList(HangoutRoomsSection);

export interface RoomsResponse { source: SocialSource; rooms: SocialRoom[]; cursor?: string; counts: { total: number; open: number; private: number } }

export interface RoomsFetch {
  data: RoomsResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  loadMore?: () => void;
  loadingMore?: boolean;
}

/**
 * The library's NewHangoutRoomDialog for a ManageChannels holder. The host
 * gates its entry points; the fallback also handles authority changing while
 * a dialog is already open.
 */
export function RoomCreateDialog({ open, onClose, mayCreate, createRoom, onCreated }: {
  open: boolean; onClose: () => void; mayCreate: boolean; createRoom: unknown; onCreated: (slug: string) => void;
}) {
  return mayCreate
    ? <NewHangoutRoomDialog title="New hangout" submitLabel="Create hangout" open={open} onClose={onClose} onCreate={createRoom as never} onCreated={(room: { slug: string }) => onCreated(room.slug)} />
    : (
      <Modal open={open} onClose={onClose} title="Rooms are opened by moderators" maxWidth={420}
        footer={<Button variant="primary" size="sm" onClick={onClose}>OK</Button>}>
        Anyone here can join a room. Opening a new one takes a moderator or a community admin — ask one in #general.
      </Modal>
    );
}

export function useRoomsModel(rooms: RoomsFetch) {
  const { api } = useSocialPlane();
  return useMemo(() => hangoutRoomsFrom({
    rooms: rooms.data?.rooms ?? null,
    isLoading: rooms.isLoading,
    error: rooms.error,
    refetch: rooms.refresh,
    create: async (body) => {
      const res = await writeJson<{ room: SocialRoom }>(`${api}/rooms`, 'POST', body);
      if (!res.ok || !res.data) throw new Error(res.error ?? 'The room could not be created.');
      rooms.refresh();
      return res.data.room;
    },
  }), [rooms.data, rooms.isLoading, rooms.error, rooms.refresh, api]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function SocialRoomsSection({ rooms, mayCreate, onOpen, onBrowse, collapsed, onToggleCollapse }: {
  rooms: RoomsFetch; mayCreate: boolean; onOpen: (slug: string) => void; onBrowse: () => void;
  /** The rail's own heading and fold (ui-components 2.432.0): the host remembers it with the rail's other sections. */
  collapsed?: boolean; onToggleCollapse?: (next: boolean) => void;
}) {
  const model = useRoomsModel(rooms);
  const [emptyCreate, setEmptyCreate] = useState(false);
  // The wrapper's built-in create action is unconditional. Readers use the
  // same library header/rows without that action; authority stays in this adapter.
  // No CSS hiding and no creation control whose only outcome is a denial.
  const active = model.rooms.filter((room, index, all) => room.state === 'active' && all.findIndex(r => r.slug === room.slug) === index);
  if (!mayCreate) return <Stack gap="none" data-testid="social-rooms-list">
    <RailSectionHeader label="Hangouts" count={active.length} collapsed={!!collapsed} onToggleCollapse={onToggleCollapse} />
    {!collapsed && <Stack gap="sm" className={RAIL_SECTION_CONTENT_INSET}>
      {model.isLoading ? <LoadingState label="Loading rooms…" /> : active.length === 0 && !model.error
        ? <T size="sm" tone="secondary" wrap>No hangouts available yet. A moderator can open one for your team.</T>
        : active.slice(0, 10).map(room => <HangoutRoomRow key={room.slug} slug={room.slug} name={room.name} onClick={() => onOpen(room.slug)} />)}
      <SocialReadStatus source="Rooms" read={rooms} retry={rooms.refresh} testId="social-rooms-read-status" />
      {active.length > 10 && <Button variant="link" size="sm" onClick={onBrowse}>Browse all hangouts</Button>}
    </Stack>}
  </Stack>;
  return (
    <Stack gap="none" data-testid="social-rooms-list">
    <RoomsList
      hangoutRooms={model as never}
      title="Hangouts"
      storageKey="social-rooms"
      {...(onToggleCollapse ? { collapsed: !!collapsed, onToggleCollapse } : {})}
      onJoin={(slug: string) => onOpen(slug)}
      onBrowseAll={onBrowse}
      renderEmpty={<>
        <RailSectionHeader label="Hangouts" count={0} collapsed={!!collapsed} onToggleCollapse={onToggleCollapse}
          actions={[{ label: 'New hangout', onClick: () => setEmptyCreate(true) }]} />
        {!collapsed && <Stack gap="sm" className={RAIL_SECTION_CONTENT_INSET}><T size="sm" tone="secondary" wrap>No hangouts available yet. Create a hangout, then configure its rooms.</T></Stack>}
        <RoomCreateDialog open={emptyCreate} onClose={() => setEmptyCreate(false)} mayCreate={mayCreate} createRoom={model.createRoom} onCreated={onOpen} />
      </>}
      renderCreateDialog={({ open, onClose }: { open: boolean; onClose: () => void }) => (
        <RoomCreateDialog open={open} onClose={onClose} mayCreate={mayCreate} createRoom={model.createRoom} onCreated={onOpen} />
      )}
    />
    {rooms.data && rooms.error && !collapsed && <Stack gap="none" className={RAIL_SECTION_CONTENT_INSET}>
      <SocialReadStatus source="Rooms" read={rooms} retry={rooms.refresh} testId="social-rooms-read-status" />
    </Stack>}
    </Stack>
  );
}
