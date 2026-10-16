// The meeting riding the shell's call (docs/meeting-rooms-app-goal.md M3, the
// initiative-huddle surface): the library call host runs realtime-modules
// `useMeeting` beside the call and moves its media into a breakout room's
// lobby (ui-components 2.476 `useCallHost().meeting`); lib/meetingRooms.ts
// says on which calls and when Rooms is offered. Everything drawn here is a
// library composite: the stage header (`MeetingToolbar` + the in-room
// `WrappedBreakoutRoomBanner`, the call host's `CallMediaOutlet header`,
// 2.477), the footer's meeting items, and the Rooms and People panes
// (`WrappedBreakoutRoomsPanel`, `RosterPanel` with `meetingRosterProps`).
// Hands on the tiles come from the host itself (2.477 `handFor`).
//
// Not here yet (docs/ui-components-queue.md): `RecordingConsentNotice`, which
// has no live "this call records" signal to open on.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChatSidePanelFrame } from '@connorhoehnslalom/ui-components';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { MeetingToolbar, RosterPanel, type MeetingToolbarItem, type RosterParticipant } from '@connorhoehnslalom/ui-components/video';
import {
  meetingRosterProps, meetingToolbarItems, WrappedBreakoutRoomBanner, WrappedBreakoutRoomsPanel, type RMMeetingPerson,
} from '@connorhoehnslalom/ui-components/integrations/realtime';
import { callCounts, useCallBlockPlacement, useCallHost, type CallHostMeeting } from '../../lib/conversationCall';
import { meetingBarItems, meetingStageItems, roomsAllowed, stageHoldsMeeting } from '../../lib/meetingRooms';

export type MeetingPaneView = 'rooms' | 'people';
interface PaneState { pane: MeetingPaneView | null; toggle(view: MeetingPaneView): void; close(): void }
const PaneContext = createContext<PaneState | null>(null);
const noop = () => {};
const inCall = (p: { state: string }) => p.state === 'in-call' || p.state === 'reconnecting';

/** Which meeting pane (Rooms or People) is open; closes itself when the meeting goes. */
export function CallMeetingProvider({ children }: { children: ReactNode }) {
  const host = useCallHost();
  const on = !!host?.meeting;
  const [pane, setPane] = useState<MeetingPaneView | null>(null);
  useEffect(() => { if (!on) setPane(null); }, [on]);
  const value = useMemo<PaneState>(() => ({
    pane: on ? pane : null,
    toggle: view => setPane(current => current === view ? null : view),
    close: () => setPane(null),
  }), [on, pane]);
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export interface CallMeetingView {
  meeting: CallHostMeeting;
  /** Everyone in the call, keyed by the meeting's userId. */
  people: RMMeetingPerson[];
  roster: RosterParticipant[];
  /** Rooms is offered (lib/meetingRooms.ts `roomsAllowed`). */
  rooms: boolean;
  pane: MeetingPaneView | null;
  toggle(view: MeetingPaneView): void;
  close(): void;
}

/** The call's meeting with this app's rules applied; null when the call carries none. */
export function useCallMeeting(): CallMeetingView | null {
  const host = useCallHost();
  const pane = useContext(PaneContext);
  const participants = host?.call.call?.participants;
  const present = useMemo(() => (participants ?? []).filter(inCall), [participants]);
  const people = useMemo<RMMeetingPerson[]>(() => present.map(p => ({
    userId: p.userId, displayName: p.displayName, ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
  })), [present]);
  const roster = useMemo<RosterParticipant[]>(() => present.map(p => ({
    id: p.userId, displayName: p.displayName, isLocal: p.isLocal, isMuted: !p.audioOn, isScreenSharing: p.screenSharing,
    ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
  })), [present]);
  const meeting = host?.meeting ?? null;
  if (!meeting || !host?.lobby) return null;
  const rooms = roomsAllowed({ lobbyName: host.lobby.lobbyName, joined: callCounts(host.call.call).joined, breakoutPhase: meeting.breakout.phase });
  return { meeting, people, roster, rooms, pane: pane?.pane ?? null, toggle: pane?.toggle ?? noop, close: pane?.close ?? noop };
}

/**
 * The footer `HuddleBar meetingItems`: Raise, React, People, and Rooms when
 * offered. `react` is the huddle's own reaction send (HuddleChat
 * `useHuddleReact`, the channel the floating reactions play from); null
 * until that channel is joined, so React waits for it.
 */
export function useMeetingBarItems(react: { send(emoji: string): void; emojis: string[] } | null): MeetingToolbarItem[] | undefined {
  const call = useCallMeeting();
  if (!call) return undefined;
  const items = meetingToolbarItems(call.meeting, {
    roomsOpen: call.pane === 'rooms',
    onToggleRooms: () => call.toggle('rooms'),
    ...(react ? { onReact: react.send, reactions: react.emojis } : {}),
    people: { open: call.pane === 'people', onToggle: () => call.toggle('people'), count: call.people.length },
  });
  return meetingBarItems(items, { rooms: call.rooms });
}

/** The open meeting pane, stacked above the conversation in the shell's right column. */
export function MeetingPane() {
  const call = useCallMeeting();
  if (!call?.pane) return null;
  if (call.pane === 'rooms') {
    if (!call.rooms) return null;
    return <Stack gap="none" className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto border-b border-l border-border bg-surface"
      data-testid="huddle-meeting-pane" data-pane="rooms">
      <WrappedBreakoutRoomsPanel meeting={call.meeting} people={call.people} onClose={call.close} data-testid="huddle-breakout-rooms" />
    </Stack>;
  }
  return <Stack gap="none" className="max-h-[60%] min-h-0 shrink-0" data-testid="huddle-meeting-pane" data-pane="people">
    <ChatSidePanelFrame title="People" subtitle={`${call.people.length} in the huddle`} onClose={call.close}
      className="border-b border-l border-border bg-surface" data-testid="huddle-meeting-people">
      <RosterPanel {...meetingRosterProps(call.meeting, call.roster)} title="In this huddle" />
    </ChatSidePanelFrame>
  </Stack>;
}

type HuddleReact = { send(emoji: string): void; emojis: string[] } | null;

/**
 * The expanded stage's header (`CallMediaOutlet header`): the in-room banner
 * and the meeting toolbar — Chat, People, Raise, React, Rooms. Drawn only
 * where a page, block or composer holds the dock; with the pane grid or the
 * footer shelf the footer bar carries the meeting items instead.
 */
export function MeetingStageHeader({ chat, react }: { chat: { open: boolean; toggle(): void } | null; react: HuddleReact }) {
  const placement = useCallBlockPlacement();
  const call = useCallMeeting();
  if (!call || !stageHoldsMeeting(placement)) return null;
  const items = meetingToolbarItems(call.meeting, {
    roomsOpen: call.pane === 'rooms',
    onToggleRooms: () => call.toggle('rooms'),
    ...(react ? { onReact: react.send, reactions: react.emojis } : {}),
    people: { open: call.pane === 'people', onToggle: () => call.toggle('people'), count: call.people.length },
    ...(chat ? { chat: { open: chat.open, onToggle: chat.toggle } } : {}),
  });
  return <Stack gap="none" data-testid="huddle-meeting-stage">
    <WrappedBreakoutRoomBanner meeting={call.meeting} />
    {/* No onLeave: the dock's own bar keeps mic, camera and the one Leave (2.478 draws none here). */}
    <MeetingToolbar items={meetingStageItems(items, { rooms: call.rooms })} data-testid="huddle-meeting-toolbar" />
  </Stack>;
}

/**
 * The in-room banner ("You're in Room 1", timer, Return to main) under the
 * page while the stage header is not drawn — the dock collapsed into the
 * footer, or the pane's tile grid — so a participant moved into a room always
 * sees where they are and how to get back. Nothing in the main meeting.
 */
export function MeetingRoomBanner() {
  const host = useCallHost();
  const placement = useCallBlockPlacement();
  return host?.meeting && !stageHoldsMeeting(placement) ? <WrappedBreakoutRoomBanner meeting={host.meeting} /> : null;
}
