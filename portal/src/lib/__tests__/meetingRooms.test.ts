import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meetingToolbarItems } from '@connorhoehnslalom/ui-components/integrations/realtime';
import {
  INERT_MEETING, ROOMS_MIN_PARTICIPANTS, SHELL_MEETING, announceInstead, meetingPeople, huddleChatChannelFor, isBreakoutChat, meetingBarItems, meetingEnabledFor, meetingRoomsFlag, meetingStageItems,
  roomsAllowed, stageHoldsMeeting,
} from '../meetingRooms.ts';

const initiative = 'orgiq:initiative:p-observability';

test('the meeting rides initiative huddles only, and only with the switch on', () => {
  assert.equal(meetingEnabledFor(initiative, true), true);
  for (const lobby of [
    'orgiq:initiative:p-observability~breakout~r1', // a room is never a base lobby
    'orgiq:person:p-001', 'social:room:general', 'assessment:team:t-1', 'assessment:doc:d-1', 'pipelines:run:r-1',
    'orgiq:initiative:', 'orgiq:initiative:has space', 'xorgiq:initiative:p-a',
  ]) assert.equal(meetingEnabledFor(lobby, true), false, lobby);
  assert.equal(meetingEnabledFor(null, true), false);
  assert.equal(meetingEnabledFor(initiative, false), false);
  // In this test process VITE_MEETING_ROOMS is unset: default off.
  assert.equal(meetingEnabledFor(initiative), false);
  assert.equal(meetingRoomsFlag('true'), true);
  assert.equal(meetingRoomsFlag('1'), true);
  for (const value of [undefined, '', 'false', '0', 'yes']) assert.equal(meetingRoomsFlag(value), false);
});

test("the host names the call's huddle channel as the meeting's chat", () => {
  assert.equal(SHELL_MEETING.chatChannelFor(initiative, 'call-1'), 'orgiq:huddle:call-1');
  assert.equal(SHELL_MEETING.chatChannelFor(initiative, null), null);
  // The provider gates per lobby; in this process the switch is off, so no lobby gets one.
  assert.equal(SHELL_MEETING.enabledFor(initiative), false);
  assert.equal(SHELL_MEETING.enabledFor('social:room:general'), false);
});

test('Rooms needs three people, the initiative lobby and the switch; open rooms stay reachable', () => {
  assert.equal(ROOMS_MIN_PARTICIPANTS, 3);
  const base = { lobbyName: initiative, breakoutPhase: 'none' as const, on: true };
  assert.equal(roomsAllowed({ ...base, joined: 2 }), false);
  assert.equal(roomsAllowed({ ...base, joined: 3 }), true);
  assert.equal(roomsAllowed({ ...base, joined: 3, on: false }), false);
  assert.equal(roomsAllowed({ ...base, joined: 5, lobbyName: 'social:room:general' }), false);
  // Someone left after rooms opened: the organizer can still close them.
  assert.equal(roomsAllowed({ ...base, joined: 2, breakoutPhase: 'open' }), true);
  assert.equal(roomsAllowed({ ...base, joined: 2, breakoutPhase: 'draft' }), true);
  assert.equal(roomsAllowed({ ...base, joined: 2, breakoutPhase: 'open', on: false }), false);
});

/** The slice of a meeting `meetingToolbarItems` reads. */
function meeting(over: Record<string, unknown> = {}) {
  const noop = () => {};
  return {
    ready: true, isOrganizer: true, hands: [], myHandPosition: null, myRoom: null, error: null,
    breakout: { phase: 'none', mode: 'assigned', rooms: [], settings: { allowReturnToMain: true } },
    state: { announcement: null },
    toggleHand: noop, lowerHand: noop, lowerAllHands: noop, configureBreakouts: noop, assign: noop, autoAssign: noop,
    openRooms: noop, closeRooms: noop, setTimer: noop, broadcast: noop, joinRoom: noop, returnToMain: noop, endBreakouts: noop, dismissAnnouncement: noop,
    ...over,
  } as unknown as Parameters<typeof meetingToolbarItems>[0];
}

test('the footer bar gets Raise, React and People, and Rooms only when allowed', () => {
  const items = meetingToolbarItems(meeting(), {
    roomsOpen: false, onToggleRooms: () => {}, onReact: () => {},
    people: { open: false, onToggle: () => {}, count: 3 },
  });
  const ids = (list: { id: string }[]) => list.map(item => item.id);
  const withRooms = ids(meetingBarItems(items, { rooms: true }));
  const without = ids(meetingBarItems(items, { rooms: false }));
  assert.equal(withRooms.length, 4);
  assert.equal(without.length, 3);
  assert.deepEqual(without, withRooms.slice(0, 3));
  assert.equal(withRooms[3], items.rooms.id);
  assert.deepEqual(without, [items.raise.id, items.react!.id, items.people!.id]);
  // Before the huddle channel is joined there is no React.
  const quiet = meetingToolbarItems(meeting(), { roomsOpen: false, onToggleRooms: () => {} });
  assert.deepEqual(ids(meetingBarItems(quiet, { rooms: false })), [quiet.raise.id]);
});

test('the expanded stage gets Chat, People, Raise, React, then Rooms when allowed — only where a page holds the dock', () => {
  const items = meetingToolbarItems(meeting(), {
    roomsOpen: false, onToggleRooms: () => {}, onReact: () => {},
    people: { open: false, onToggle: () => {}, count: 3 }, chat: { open: false, onToggle: () => {} },
  });
  const ids = (list: { id: string }[]) => list.map(item => item.id);
  assert.deepEqual(ids(meetingStageItems(items, { rooms: true })), [items.chat!.id, items.people!.id, items.raise.id, items.react!.id, items.rooms.id]);
  assert.deepEqual(ids(meetingStageItems(items, { rooms: false })), [items.chat!.id, items.people!.id, items.raise.id, items.react!.id]);
  for (const placement of ['page', 'block', 'composer']) assert.equal(stageHoldsMeeting(placement), true, placement);
  // The footer shelf and the pane grid keep the footer bar's meeting items (and the page's banner).
  for (const placement of ['footer', 'pane']) assert.equal(stageHoldsMeeting(placement), false, placement);
});

test("the conversation follows the meeting's activeChat into a room, never into another call", () => {
  assert.equal(huddleChatChannelFor('call-1', null), 'orgiq:huddle:call-1');
  assert.equal(huddleChatChannelFor('call-1', 'orgiq:huddle:call-1'), 'orgiq:huddle:call-1');
  assert.equal(huddleChatChannelFor('call-1', 'orgiq:huddle:call-1~breakout~r2'), 'orgiq:huddle:call-1~breakout~r2');
  assert.equal(isBreakoutChat('call-1', 'orgiq:huddle:call-1~breakout~r2'), true);
  assert.equal(isBreakoutChat('call-1', 'orgiq:huddle:call-1'), false);
  assert.equal(isBreakoutChat('call-1', 'orgiq:huddle:call-1~breakout~a~breakout~b'), false);
  for (const forged of [
    'orgiq:huddle:call-2~breakout~r2', 'orgiq:huddle:call-10', 'orgiq:huddle:call-1~breakout~', 'orgiq:huddle:call-1~breakout~a~breakout~b',
    'orgiq:huddle:call-1~breakout~has space', 'meeting:orgiq:initiative:p-a', 'orgiq:initiative:p-a',
  ]) assert.equal(huddleChatChannelFor('call-1', forged), 'orgiq:huddle:call-1', forged);
});

test('"To: All rooms" turns any huddle send into the meeting announcement, never a chat post', () => {
  const announced: string[] = [];
  const binding = (target: 'chat' | 'rooms') => ({ target, onSend: (text: string) => { announced.push(text); } });
  // The organizer chose All rooms: the send is the binding's onSend, and the caller posts nothing.
  assert.equal(announceInstead(binding('rooms'), 'Five minutes left'), true);
  assert.deepEqual(announced, ['Five minutes left']);
  // This chat, no meeting, or nothing to say: the ordinary confirmed chat send goes on.
  assert.equal(announceInstead(binding('chat'), 'hello'), false);
  assert.equal(announceInstead(null, 'hello'), false);
  assert.equal(announceInstead(binding('rooms'), '   '), false);
  assert.deepEqual(announced, ['Five minutes left']);
  // The stand-in source the shell's one binding runs on without a meeting can never announce.
  assert.equal(INERT_MEETING.ready, false);
  assert.equal(INERT_MEETING.isOrganizer, false);
  assert.equal(INERT_MEETING.breakout.phase, 'none');
});

test('meeting people show names: a participant known only by id takes the seat roster name', () => {
  const people = meetingPeople([
    { userId: 'u-vera-clone-1', displayName: 'Vera Green', avatarUrl: '/a/vera.png' },
    { userId: 'u-nora-clone-2', displayName: 'u-nora-clone-2' }, // the media layer had no name
    { userId: 'u-rachel-clone-3', displayName: null },
    { userId: 'u-vera-clone-1', displayName: 'Vera Green' }, // listed twice
  ], [
    { userId: 'u-nora-clone-2', displayName: 'Nora DaSilva' },
    { userId: 'u-rachel-clone-3', displayName: 'Rachel Kowalski' },
    { userId: 'u-sana-clone-4', displayName: 'Sana Iqbal' }, // seated, not yet on media
  ]);
  assert.deepEqual(people, [
    { userId: 'u-vera-clone-1', displayName: 'Vera Green', avatarUrl: '/a/vera.png' },
    { userId: 'u-nora-clone-2', displayName: 'Nora DaSilva' },
    { userId: 'u-rachel-clone-3', displayName: 'Rachel Kowalski' },
    { userId: 'u-sana-clone-4', displayName: 'Sana Iqbal' },
  ]);
  for (const person of people) assert.notEqual(person.displayName, person.userId, person.userId);
  // With no roster name either, the id is the last resort (never an empty label).
  assert.deepEqual(meetingPeople([{ userId: 'u-x' }], []), [{ userId: 'u-x', displayName: 'u-x' }]);
});
