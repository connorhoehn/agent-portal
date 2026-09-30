// The chat workspace's pane for a room (`/social/rooms?room=<slug>`): what the
// room is, who may enter, and its call — `social:room:<slug>`, through the
// shell's call host (useSocialCall), which draws the dock above the page.

import { Button, Chip, EmptyState, InlineAlert, KeyValue, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { NameOf, SocialRoom } from './socialPlatform';
import type { SocialCall } from './useSocialCall';

export default function RoomPane({ selected, room, nameOf, call, mayCreate, onCreate }: {
  selected: string | null;
  room: SocialRoom | null;
  nameOf: NameOf;
  call: SocialCall;
  mayCreate: boolean;
  onCreate: (trigger: HTMLElement) => void;
}) {
  if (!room) {
    return <EmptyState align="start" testId={selected ? 'social-room-missing' : 'social-room-pick'}
      title={selected ? 'This room is not available' : 'Pick a room'}
      description={selected
        ? 'It does not exist, or it is private and you are not one of its members.'
        : 'Choose a room under Rooms on the left to see who can join it, then join its call. A room stays open between calls, so a group can gather in the same place every time.'}
      {...(!selected && mayCreate ? { action: <Button variant="secondary" size="sm" onClick={(e) => onCreate(e.currentTarget)} data-testid="social-empty-new-room">New room</Button> } : {})} />;
  }
  return (
    <Stack gap="md" className="min-w-0" data-testid="social-room-detail">
      <PageHeader
        title={room.name}
        {...(room.description ? { description: room.description } : {})}
        badge={<Chip tone={room.visibility === 'private' ? 'warning' : 'neutral'} size="xs">{room.visibility === 'private' ? 'Private' : 'Open to the workspace'}</Chip>}
        actions={call.activeLobby === room.lobbyName
          ? <Button variant="secondary" size="sm" onClick={call.leave} data-testid="social-room-leave">Leave call</Button>
          : <Button variant="primary" size="sm" disabled={!!call.unavailable} onClick={() => call.joinRoom(room)} data-testid="social-room-join">Join call</Button>}
      />
      {call.unavailable && <InlineAlert tone="info">{call.unavailable}</InlineAlert>}
      <KeyValue
        items={[
          { label: 'Who can join', value: room.visibility === 'private' ? 'Its creator and the members they add' : 'Everyone in this workspace' },
          { label: 'Opened by', value: nameOf(room.createdBy) },
          { label: 'Call', value: room.settings.audioOnly ? 'Audio only' : 'Audio and video' },
          { label: 'Recording', value: room.settings.recordingEnabled ? 'Allowed' : 'Off' },
          { label: 'Lobby', value: room.lobbyName },
        ]}
        data-testid="social-room-facts"
      />
    </Stack>
  );
}
