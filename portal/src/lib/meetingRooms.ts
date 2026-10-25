// The meeting that rides a call (docs/meeting-rooms-app-goal.md M3): raise
// hand, reactions, breakout rooms and room chat from realtime-modules
// `useMeeting`, run by the library call host (ui-components 2.476
// `CallHostProviderProps.meeting`). This file is the app's policy for it, as
// data, so the shell's components only compose library pieces:
//
// - Decision 5, rollout: initiative huddles (`orgiq:initiative:<id>`) first.
//   Every other lobby gets no meeting at all.
// - One switch, `VITE_MEETING_ROOMS` (default off). A surface ships whole or
//   not at all (decision 5), and Rooms moves media to a breakout lobby, which
//   is safe only where platform-api defers lobby admission to the BFF (X1:
//   `LOBBY_AUTHORITY_REQUIRED=true` + `LOBBY_AUTHORITY_URL`). Turn it on only
//   in a stack whose platform-api runs that way; the BFF has no signal for it
//   yet, so the build says so.
// - Decision 4: Rooms needs three people in the call (DM-sized calls get
//   Raise and React only), but stays while rooms exist so they can be closed.
// - Decision 1: a room's chat is the call's huddle channel with the
//   `~breakout~<roomId>` suffix; the meeting reports it as `activeChat`.
import type { RMMeetingSource } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { huddleChannel } from './huddleRoster.ts';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** `VITE_MEETING_ROOMS=true` (or `1`) turns the initiative-huddle meeting on. */
export function meetingRoomsFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}
export const MEETING_ROOMS_ON = meetingRoomsFlag(env.VITE_MEETING_ROOMS);

/** The BFF's `RID` (lib/tenant-channels.ts) minus `~`: a breakout suffix is never a base lobby. */
const INITIATIVE_LOBBY = /^orgiq:initiative:[^\s~]{1,256}$/;
const HANGOUT_LOBBY = /^social:room:[A-Za-z0-9_-]{1,80}$/;
const BREAKOUT = '~breakout~';

/** The call in this lobby carries a meeting (decision 5: initiative huddles only). */
export function meetingEnabledFor(lobbyName: string | null | undefined, on: boolean = MEETING_ROOMS_ON): boolean {
  return on && !!lobbyName && (INITIATIVE_LOBBY.test(lobbyName) || HANGOUT_LOBBY.test(lobbyName));
}

/** The call host's `meeting.chatChannelFor`: the call's huddle channel, so a room's is `<that>~breakout~<roomId>`. */
export const meetingChatChannelFor = (_lobbyName: string, callId: string | null): string | null =>
  callId ? huddleChannel(callId) : null;

/** The provider option (ui-components 2.477 `enabledFor` gates it per lobby); one reference for the life of the page. */
export const SHELL_MEETING = {
  chatChannelFor: meetingChatChannelFor,
  enabledFor: (lobbyName: string): boolean => meetingEnabledFor(lobbyName),
} as const;

/** Decision 4. */
export const ROOMS_MIN_PARTICIPANTS = 3;

export interface RoomsPolicyInput {
  lobbyName: string | null | undefined;
  /** People in the call (`callCounts(call).joined`). */
  joined: number;
  /** The meeting's breakout phase; rooms already drafted or open stay reachable. */
  breakoutPhase: 'none' | 'draft' | 'open';
  on?: boolean;
}

/** Whether the Rooms control is offered on this call. */
export function roomsAllowed({ lobbyName, joined, breakoutPhase, on = MEETING_ROOMS_ON }: RoomsPolicyInput): boolean {
  if (!meetingEnabledFor(lobbyName, on)) return false;
  return HANGOUT_LOBBY.test(lobbyName ?? '') || joined >= ROOMS_MIN_PARTICIPANTS || breakoutPhase !== 'none';
}

/** `meetingToolbarItems`' result, as read here. */
export interface MeetingItemSet<I> { raise: I; rooms: I; react?: I; people?: I; chat?: I }

/**
 * The footer `HuddleBar meetingItems`: Raise, React, People (the hands queue;
 * the stage's own toolbar is not drawable yet), then Rooms when allowed.
 */
export function meetingBarItems<I>(items: MeetingItemSet<I>, opts: { rooms: boolean }): I[] {
  return [items.raise, ...(items.react ? [items.react] : []), ...(items.people ? [items.people] : []), ...(opts.rooms ? [items.rooms] : [])];
}

/**
 * The expanded stage's `MeetingToolbar` items, in the goal's order: Chat,
 * People, Raise, React, then Rooms when allowed.
 */
export function meetingStageItems<I>(items: MeetingItemSet<I>, opts: { rooms: boolean }): I[] {
  return [
    ...(items.chat ? [items.chat] : []), ...(items.people ? [items.people] : []), items.raise,
    ...(items.react ? [items.react] : []), ...(opts.rooms ? [items.rooms] : []),
  ];
}

/** The stage header is drawn (a page, block or composer holds the dock); the footer and the pane grid keep the bar. */
export const stageHoldsMeeting = (placement: string): boolean =>
  placement === 'stage' || placement === 'page' || placement === 'block' || placement === 'composer';

/**
 * The chat channel the huddle conversation reads: the meeting's `activeChat`
 * when it is this call's huddle channel or one of its rooms, else the call's
 * huddle channel. Another call's channel never redirects the conversation.
 */
export function huddleChatChannelFor(callId: string, activeChat: string | null | undefined): string {
  const base = huddleChannel(callId);
  if (!activeChat || activeChat === base) return base;
  const room = activeChat.startsWith(base + BREAKOUT) ? activeChat.slice(base.length + BREAKOUT.length) : '';
  return room && !room.includes('~') && !/\s/.test(room) ? activeChat : base;
}

/** The conversation is a room's, not the call's: pins and files (REST, base channel only) stay off. */
export const isBreakoutChat = (callId: string, channel: string | null | undefined): boolean =>
  !!channel && channel !== huddleChannel(callId) && huddleChatChannelFor(callId, channel) === channel;

const noop = () => {};
/**
 * A meeting that is not there: the huddle chat runs ui-components `useMeetingChat` once, in the
 * shell (so every composer that sends to the huddle shares its "To" target), and the hook needs a
 * source on every render. Never ready, never an organizer: its target stays `chat`, no dock.
 */
export const INERT_MEETING: RMMeetingSource = {
  ready: false, isOrganizer: false, hands: [], myHandPosition: null, myRoom: null, error: null,
  breakout: { phase: 'none', mode: 'assigned', rooms: [], returned: [], endsAt: null, announcement: null, settings: { allowReturnToMain: true } },
  state: { announcement: null },
  toggleHand: noop, lowerHand: noop, lowerAllHands: noop, configureBreakouts: noop, assign: noop, autoAssign: noop,
  openRooms: noop, closeRooms: noop, setTimer: noop, broadcast: noop, joinRoom: noop, returnToMain: noop,
  endBreakouts: noop, dismissAnnouncement: noop,
};

/**
 * Every huddle send passes here first: while an organizer has "To: All rooms" chosen, the text
 * goes to the meeting through the binding's own `onSend` (an announcement) and never to the chat.
 * True when it was announced (the caller settles its draft as sent).
 */
export function announceInstead(binding: { target: 'chat' | 'rooms'; onSend(content: string): void } | null, text: string): boolean {
  if (binding?.target !== 'rooms' || !text.trim()) return false;
  binding.onSend(text);
  return true;
}

/** A person in the call as the meeting panes show them. */
export interface MeetingPersonView { userId: string; displayName: string; avatarUrl?: string }

/**
 * Everyone in the meeting, by name: the call's participants (who is connected) merged with the
 * huddle's seat roster (GET /api/calls/:callId/chat, BFF-resolved names). A participant the media
 * layer only knows by id takes the roster's name; nobody is shown by their raw id when a name exists.
 */
export function meetingPeople(
  participants: readonly { userId: string; displayName?: string | null; avatarUrl?: string | null }[],
  roster: readonly { userId: string; displayName: string }[],
): MeetingPersonView[] {
  const names = new Map(roster.filter(r => r.displayName && r.displayName !== r.userId).map(r => [r.userId, r.displayName]));
  const named = (userId: string, name: string | null | undefined) =>
    name && name !== userId ? name : names.get(userId) ?? name ?? userId;
  const out = new Map<string, MeetingPersonView>();
  for (const p of participants) {
    if (!p.userId || out.has(p.userId)) continue;
    out.set(p.userId, { userId: p.userId, displayName: named(p.userId, p.displayName), ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) });
  }
  for (const r of roster) if (r.userId && !out.has(r.userId)) out.set(r.userId, { userId: r.userId, displayName: named(r.userId, r.displayName) });
  return [...out.values()];
}
