// A persistent hangout owns its saved configuration; a call owns live rooms.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Chip, DataTable, EmptyState, Inline, InlineAlert, KeyValue, PageSection, Stack, T, Tabs, TabPanel } from '@connorhoehn/ui-components/shared';
import { RosterPanel } from '@connorhoehn/ui-components/video';
import { HangoutCallView, type HangoutCallPane } from './HangoutCallView';
import { WrappedBreakoutRoomsPanel, meetingRosterProps } from '@connorhoehn/ui-components/integrations/realtime';
import type { NameOf, SocialRoom } from './socialPlatform';
import type { SocialCall } from './useSocialCall';
import { CallBlock, useCallHost, useCallMediaPanel } from '../../lib/conversationCall';
import { useCallMeeting } from '../../components/shell/CallMeeting';
import { useNovaRosterEntries } from '../../components/shell/MeetingAssistantBar';
import { HuddleChatBody, useHuddleChat } from '../../components/shell/HuddleChat';
import RoomConfiguration from './RoomConfiguration';
import RoomActivity from './RoomActivity';
import { useLobbyCall } from '@connorhoehn/realtime-modules/client/video';
const VIEWS = ['overview', 'call', 'rooms', 'activity'];

export default function RoomPane({ selected, room, nameOf, call, onBrowse, inset = false, people = [], mayConfigure = false, onSaved }: {
  selected: string | null;
  room: SocialRoom | null;
  nameOf: NameOf;
  call: SocialCall;
  onBrowse: () => void;
  inset?: boolean;
  people?: readonly { userId: string; displayName: string }[];
  mayConfigure?: boolean;
  onSaved?(room: SocialRoom): void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const [editingLayout, setEditingLayout] = useState(false);
  const [roomView, setRoomView] = useState('saved');
  const [params, setParams] = useSearchParams();
  const requestedView = params.get('hangoutView');
  const view = requestedView === 'conversation' ? 'call' : VIEWS.includes(requestedView ?? '') ? requestedView! : 'overview';
  const [callPane, setCallPane] = useState<HangoutCallPane>(requestedView === 'conversation' ? 'conversation' : 'people');
  const changeView = useCallback((next: string, replace = false) => setParams(previous => {
    const updated = new URLSearchParams(previous); updated.set('hangoutView', next); return updated;
  }, { replace }), [setParams]);
  const host = useCallHost();
  const media = useCallMediaPanel();
  const chat = useHuddleChat();
  const changeCallPane = useCallback((next: HangoutCallPane) => {
    setCallPane(next);
    if (next === 'conversation') chat?.openPane({ focus: false });
    else chat?.closeMessage();
  }, [chat?.openPane, chat?.closeMessage]);
  const occupancy = useLobbyCall(room?.lobbyName);
  const meeting = useCallMeeting();
  const here = !!room && call.activeLobby === room.lobbyName;
  const live = here ? meeting : null;
  const novaEntries = useNovaRosterEntries();
  const currentRoomName = live?.meeting.myRoom?.name ?? 'Main call';
  const registerPane = chat?.registerPaneOwner;
  const hideConversation = useCallback(() => setCallPane(null), []);
  useEffect(() => here ? registerPane?.({ visible: view === 'call' && callPane === 'conversation', hide: hideConversation }) : undefined, [here, registerPane, view, callPane, hideConversation]);
  const joined = useRef(false);
  useEffect(() => {
    if (here && !joined.current) changeView('call', true);
    joined.current = here;
  }, [here]); // A join selects Call once; later tab choices remain the reader's.
  const lastFocus = useRef(chat?.focusRequest ?? 0);
  useEffect(() => {
    if (here && chat && chat.focusRequest !== lastFocus.current) { setCallPane('conversation'); changeView('call'); }
    lastFocus.current = chat?.focusRequest ?? 0;
  }, [here, chat?.focusRequest]);
  useEffect(() => { if (here && media?.open) media.setOpen(false); }, [here, media?.open, media?.setOpen]);
  useEffect(() => {
    if (here && meeting?.pane === 'people') { setCallPane('people'); changeView('call'); meeting.close(); }
    if (here && meeting?.pane === 'rooms') { setRoomView('live'); changeView('rooms'); meeting.close(); }
  }, [here, meeting?.pane]);
  const active = here ? (host?.call.call?.participants ?? []).filter(p => p.state === 'in-call' || p.state === 'reconnecting') : [];
  const label = (id: string) => nameOf(id) !== id ? nameOf(id)
    : active.find(person => person.userId === id)?.displayName
      || (host?.self?.userId === id ? host.self.displayName : undefined) || 'Name unavailable';
  const bodyClass = `min-h-0 min-w-0 flex-1 ${view === 'call' ? 'overflow-hidden' : 'overflow-y-auto pb-6'}${inset ? ' pt-4 px-[var(--ui-page-gutter,1.5rem)]' : ''}`;
  if (!room) return <Stack gap="lg" className={bodyClass} data-page-body={inset ? 'inset' : undefined}><EmptyState align="start" testId={selected ? 'social-room-missing' : 'social-room-pick'}
    title={selected ? 'This hangout is not available' : 'Pick a hangout'}
    description={selected ? 'It does not exist, or you do not have access.' : 'Choose a hangout to see its rooms and join its call.'}
    action={<Button variant="secondary" size="sm" onClick={onBrowse}>All hangouts</Button>} /></Stack>;
  return <Stack gap="lg" className={bodyClass} data-page-body={inset ? 'inset' : undefined} data-testid="social-room-detail">
    <Stack gap="md" className="shrink-0">
    <Button variant="link" size="sm" className="self-start" onClick={onBrowse} data-testid="social-room-back">All hangouts</Button>
    <PageSection size={inset ? 'lg' : 'md'} title={room.name} description={room.description}
      actions={<Inline gap="sm">{mayConfigure && <Button variant="secondary" size="sm" onClick={() => setConfiguring(true)}>Configure hangout</Button>}
        {!here && <Button variant="primary" size="sm" disabled={!!call.unavailable} title={call.unavailable ?? undefined} aria-description={call.unavailable ?? undefined} onClick={() => call.joinRoom(room)} data-testid="social-room-join">Join call</Button>}</Inline>} />
    {call.unavailable && <InlineAlert tone="info">{call.unavailable}</InlineAlert>}
    <Tabs idPrefix="hangout-view" aria-label="Hangout views" variant="underline" value={view} onValueChange={changeView}
      items={VIEWS.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))} />
    </Stack>
    <TabPanel id="call" when={view} idPrefix="hangout-view" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {here ? <HangoutCallView title={currentRoomName} count={active.length} pane={callPane} onPaneChange={changeCallPane}
        stage={<CallBlock placement="stage" className="min-h-0 flex-1" />}
        conversation={<HuddleChatBody showCall={false} />}
        people={<RosterPanel {...(live ? meetingRosterProps(live.meeting, live.roster) : {
          participants: active.map(p => ({ id: p.userId, displayName: label(p.userId), avatarUrl: p.avatarUrl, isLocal: p.isLocal, isMuted: !p.audioOn, isScreenSharing: p.screenSharing })),
        })} extraEntries={novaEntries} title="Participants" className="w-full border-l-0" />} />
        : <EmptyState align="start" title="Ready when you are" description="Join the call to meet here. Check your camera and microphone before entering." />}
    </TabPanel>
    <TabPanel id="overview" when={view} idPrefix="hangout-view"><Stack gap="lg">
    <KeyValue items={[
      { label: 'Access', value: room.visibility === 'private' ? 'Members only' : 'Open to the workspace' },
      { label: 'Host', value: label(room.createdBy) },
      { label: 'Call', value: room.settings.audioOnly ? 'Cameras off on entry' : 'Audio and video' },
      { label: 'Recording', value: room.settings.recordingEnabled ? 'On for new calls' : 'Off' },
    ]} data-testid="social-room-facts" />
    <Stack gap="sm" data-testid="hangout-active-people">
      <T weight="semibold">Active now</T>
      {host?.connectionState === 'connected'
        ? occupancy.count ? <Inline gap="xs" wrap>{occupancy.participantUserIds.map(id => <Chip key={id} tone="success" size="sm">{label(id)}</Chip>)}</Inline>
          : <T size="sm" tone="secondary">No one is in this call right now.</T>
        : <T size="sm" tone="secondary">Live participation is unavailable.</T>}
    </Stack>
    <PageSection size="sm" title="Rooms" description={room.plan?.rooms.length ? `${room.plan.rooms.length} saved rooms. Assignments are remembered for future calls.` : 'Everyone starts in the main call. Save rooms here or create temporary rooms during a call.'}
      actions={<Button variant="secondary" size="sm" onClick={() => changeView('rooms')}>View rooms</Button>} />
    </Stack></TabPanel>
    <TabPanel id="rooms" when={view} idPrefix="hangout-view"><Stack gap="lg">
      <PageSection size="sm" title="Room layout" description="Save rooms and assignments for future calls."
        actions={here ? <Tabs aria-label="Room layout scope" variant="segmented" size="sm" value={roomView} onValueChange={setRoomView}
          items={[{ id: 'saved', label: 'Saved layout' }, { id: 'live', label: 'This call' }]} /> : undefined} />
      {here && roomView === 'live' ? <Stack gap="md" data-testid="hangout-live-rooms">
        {live?.meeting.isOrganizer && !!room.plan?.rooms.length && live.meeting.breakout.phase !== 'open'
          && <Button variant="secondary" size="sm" className="self-start" onClick={() => live.meeting.configureBreakouts(room.plan!.rooms, { mode: room.plan!.mode, allowReturnToMain: room.plan!.allowReturnToMain })}>Use saved rooms in this call</Button>}
        {live ? <WrappedBreakoutRoomsPanel meeting={live.meeting} people={live.people} title="This call's rooms" collapseClosedRooms={false} />
          : <T size="sm" tone="secondary">Room controls are unavailable on this call.</T>}
      </Stack> : editingLayout && mayConfigure
        ? <RoomConfiguration key={`layout:${room.slug}`} scope="layout" room={room} people={people} nameOf={nameOf} onClose={() => setEditingLayout(false)} onSaved={updated => onSaved?.(updated)} />
        : <Stack gap="md" data-testid="hangout-saved-rooms">
          {mayConfigure && <Button variant="secondary" size="sm" className="self-start" onClick={() => setEditingLayout(true)}>Edit saved layout</Button>}
          <DataTable data={room.plan?.rooms ?? []} keyField={child => child.id}
            columns={[{ key: 'name', header: 'Room', render: child => <T size="sm" weight="semibold">{child.name}</T> },
              { key: 'members', header: 'Assigned people', render: child => child.members.length
                ? <Inline gap="xs" wrap>{child.members.map(id => <Chip key={id} size="sm">{label(id)}</Chip>)}</Inline>
                : <T size="sm" tone="secondary">No one assigned</T> }]}
            staticRows="Saved room assignments are configuration; use Edit saved layout to change them." emptyMessage="No saved rooms yet. Everyone starts in the main call." />
          <T size="sm" tone="secondary">Saved assignments do not mark people as present. Live participation appears under This call.</T>
        </Stack>}
    </Stack></TabPanel>
    <TabPanel id="activity" when={view} idPrefix="hangout-view"><RoomActivity key={`activity:${room.slug}`} slug={room.slug} /></TabPanel>
    {configuring && <RoomConfiguration key={`configuration:${room.slug}`} scope="settings" room={room} people={people} nameOf={nameOf} onClose={() => setConfiguring(false)} onSaved={updated => onSaved?.(updated)} />}
  </Stack>;
}
