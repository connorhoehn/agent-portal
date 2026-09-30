// The chat rail's Rooms section (SocialChatWorkspace's `beforeList`, beside the
// Teams tree). The library's ConversationRail has no rooms group, so this is
// the library's hook-bound rooms section — `createWrappedHangoutRoomsList` over
// `createHangoutRoomsSection` over `createHangoutRoomRow` bound to
// realtime-modules' `useRoomOccupancy` (live occupancy per row) — handed the
// BFF's rows in the shape `useHangoutRooms()` returns (socialPlatform.ts
// `hangoutRoomsFrom`), because creating one is Cedar-gated at the BFF
// (ManageChannels) and platform-api alone would let anyone.
//
// The rooms are platform-api's (partition `social`), read through the BFF
// (`GET /api/social/rooms`: tenant-scoped, team channels left to Teams; a
// private room is listed to its creator and members only). A row opens the
// room in the pane (`/social/rooms?room=<slug>`), where Join call is.

import { useMemo } from 'react';
import * as hangoutRooms from '@connorhoehnslalom/realtime-modules/client/hangout-rooms';
import {
  createHangoutRoomRow, createHangoutRoomsSection, createWrappedHangoutRoomsList, NewHangoutRoomDialog,
} from '@connorhoehnslalom/ui-components/integrations/realtime';
import { Button, Modal, Stack } from '@connorhoehnslalom/ui-components/shared';
import { writeJson } from '../../lib/writeJson';
import { hangoutRoomsFrom, type SocialRoom, type SocialSource } from './socialPlatform';

const HangoutRoomRow = createHangoutRoomRow({ useRoomOccupancy: hangoutRooms.useRoomOccupancy });
const HangoutRoomsSection = createHangoutRoomsSection(HangoutRoomRow);
const RoomsList = createWrappedHangoutRoomsList(HangoutRoomsSection);

export interface RoomsResponse { source: SocialSource; rooms: SocialRoom[]; counts: { total: number; open: number; private: number } }

export interface RoomsFetch {
  data: RoomsResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The create dialog for the Rooms +: the library's NewHangoutRoomDialog for a
 * ManageChannels holder; for anyone else (the section always draws its +,
 * queued in docs/ui-components-queue.md) a Modal saying who can.
 */
export function RoomCreateDialog({ open, onClose, mayCreate, createRoom, onCreated }: {
  open: boolean; onClose: () => void; mayCreate: boolean; createRoom: unknown; onCreated: (slug: string) => void;
}) {
  return mayCreate
    ? <NewHangoutRoomDialog open={open} onClose={onClose} onCreate={createRoom as never} onCreated={(room: { slug: string }) => onCreated(room.slug)} />
    : (
      <Modal open={open} onClose={onClose} title="Rooms are opened by moderators" maxWidth={420}
        footer={<Button variant="primary" size="sm" onClick={onClose}>OK</Button>}>
        Anyone here can join a room. Opening a new one takes a moderator or a community admin — ask one in #general.
      </Modal>
    );
}

export function useRoomsModel(rooms: RoomsFetch) {
  return useMemo(() => hangoutRoomsFrom({
    rooms: rooms.data?.rooms ?? null,
    isLoading: rooms.isLoading,
    error: rooms.error,
    refetch: rooms.refresh,
    create: async (body) => {
      const res = await writeJson<{ room: SocialRoom }>('/api/social/rooms', 'POST', body);
      if (!res.ok || !res.data) throw new Error(res.error ?? 'The room could not be created.');
      rooms.refresh();
      return res.data.room;
    },
  }), [rooms.data, rooms.isLoading, rooms.error, rooms.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function SocialRoomsSection({ rooms, mayCreate, onOpen }: {
  rooms: RoomsFetch; mayCreate: boolean; onOpen: (slug: string) => void;
}) {
  const model = useRoomsModel(rooms);
  return (
    <Stack gap="none" data-testid="social-rooms-list">
    <RoomsList
      hangoutRooms={model as never}
      title="Rooms"
      storageKey="social-rooms"
      onJoin={(slug: string) => onOpen(slug)}
      renderCreateDialog={({ open, onClose }: { open: boolean; onClose: () => void }) => (
        <RoomCreateDialog open={open} onClose={onClose} mayCreate={mayCreate} createRoom={model.createRoom} onCreated={onOpen} />
      )}
    />
    </Stack>
  );
}
