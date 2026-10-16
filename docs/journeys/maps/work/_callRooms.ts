// The call-with-rooms walk on an initiative huddle (docs/meeting-rooms-app-goal.md E3), organizer and participant.
// Not a map: the two maps beside each role import this. Both are HELD: the walk needs two more people in the call
// at the same time (Rooms needs three, decision 4) and the map format has one walker; the meeting's state lives in the
// gateway's memory, which no mock scope reaches; and the portal must be built with VITE_MEETING_ROOMS=true. The
// executable proof today is portal/e2e/meeting-rooms.spec.ts (E1). Unhold once the runner can seat peer clones.
import type { JourneyMap, Step, Target } from '../../../../scripts/journeys/journey-map.ts';
import { LEAKS, PERSONA } from './_shared.ts';

export const CALL_ROOMS_HOLD = 'needs two peer clones seated in the same huddle while the walker acts (the map format has one walker), the meeting state is gateway memory no mock scope reaches, and the target portal must be built with VITE_MEETING_ROOMS=true; portal/e2e/meeting-rooms.spec.ts is the proof until the runner can seat peers';

const URL = '/iq/projects/p-auth-migration';
const huddle: Target = { role: 'button', name: 'Huddle', within: { testId: 'shell-footer-context' } };
const stage: Target = { testId: 'huddle-meeting-stage' };
const item = (id: string): Target => ({ testId: `meeting-toolbar-${id}`, within: stage });
const roomsPanel: Target = { testId: 'huddle-breakout-rooms' };
const banner: Target = { testId: 'breakout-banner' };
const chatPane: Target = { testId: 'huddle-chat-panel' };
const PAGES = 'portal/src/components/shell/CallMeeting.tsx, portal/src/components/shell/HuddleChat.tsx, portal/src/components/shell/SocialFooter.tsx, portal/src/lib/meetingRooms.ts';

const join: Step[] = [
  { do: 'navigate', url: URL, name: 'Open Auth Migration: the footer offers its huddle', expect: { visible: [huddle] } },
  { do: 'click', target: huddle, name: 'Join the huddle: the stage over the composer carries the meeting toolbar with Chat, People, Raise and React', writes: true,
    expect: { visible: [stage, item('chat'), item('people'), item('raise'), item('react')] }, screenshot: 'log' },
  { do: 'tab-walk', name: 'Tab reaches the stage toolbar and the call controls from the top of the page', proves: 'keyboard', expect: { minVisited: 6 } },
];

function organizer(): Step[] {
  return [
    ...join,
    { do: 'wait', target: item('rooms'), name: 'With three people in the call the toolbar adds Rooms', expect: { visible: [item('rooms')] } },
    { do: 'click', target: item('people'), name: 'People opens the hands queue: Nora DaSilva\'s raised hand is first, by name, with Lower', state: 'pane-open',
      stable: [stage], proves: ['tab-stability', 'story-facts'],
      expect: { visible: [{ testId: 'roster-raised-hand' }, { testId: 'roster-lower-hand' }], text: ['Nora DaSilva'], noText: LEAKS } },
    { do: 'click', target: { testId: 'roster-lower-hand' }, name: 'Lower clears that hand', writes: true, expect: { absent: [{ testId: 'roster-raised-hand' }] } },
    { do: 'click', target: item('rooms'), name: 'Rooms opens the breakout panel; with no rooms yet the organizer is offered how many to create', state: 'empty',
      stable: [stage], proves: ['empty-state', 'role-gating'], expect: { visible: [roomsPanel, { testId: 'breakout-create' }] } },
    { do: 'fill', target: { testId: 'breakout-create-count' }, value: '2', name: 'Ask for two rooms', expect: { visible: [{ testId: 'breakout-create-submit' }] } },
    { do: 'click', target: { testId: 'breakout-create-submit' }, name: 'Create them: two rooms and the people not in one are listed', writes: true,
      expect: { count: [{ target: { testId: 'breakout-room' }, eq: 2 }], visible: [{ testId: 'breakout-unassigned' }] } },
    { do: 'click', target: { testId: 'breakout-auto-assign' }, name: 'Assign automatically: nobody is left outside a room', writes: true, expect: { absent: [{ testId: 'breakout-unassigned-person' }] } },
    { do: 'click', target: { testId: 'breakout-open-all' }, name: 'Open the rooms: the panel says they are open and the organizer stays in the main meeting', writes: true,
      expect: { attr: [{ target: roomsPanel, name: 'data-phase', value: 'open' }], absent: [banner] } },
    { do: 'navigate', url: '/settings', name: 'On a page with no call composer the dock folds into the footer, which keeps Rooms', expect: { visible: [{ testId: 'shell-call-dock-meeting-rooms' }] } },
    { do: 'click', target: { testId: 'shell-call-dock-chat' }, name: 'The huddle chat offers the organizer "To: This chat | All rooms"', state: 'pane-open',
      expect: { visible: [chatPane, { testId: 'meeting-chat-target' }] } },
    { do: 'click', target: { text: 'All rooms', exact: true, within: { testId: 'meeting-chat-target' } }, name: 'All rooms turns the next message into an announcement', expect: { text: ['Every room sees this as an announcement.'] } },
    { do: 'click', target: { testId: 'shell-call-dock-meeting-rooms' }, name: 'Rooms from the footer reopens the panel', expect: { visible: [roomsPanel] } },
    { do: 'click', target: { testId: 'breakout-end' }, name: 'End breakout rooms: everyone is back in the main meeting', writes: true, expect: { absent: [banner, { testId: 'breakout-room' }] } },
  ];
}

function participant(): Step[] {
  return [
    ...join,
    { do: 'click', target: item('rooms'), name: 'Rooms before the organizer opens any says so, and a participant is offered nothing to create', state: 'empty',
      stable: [stage], proves: ['empty-state', 'role-gating', 'tab-stability'],
      expect: { visible: [{ testId: 'huddle-breakout-rooms-empty' }], text: ['No breakout rooms yet. The organizer will open them.'], absent: [{ testId: 'breakout-create' }, { testId: 'breakout-open-all' }] } },
    { do: 'click', target: item('raise'), name: 'Raise puts a hand up and says where it is in the queue', writes: true,
      expect: { attr: [{ target: item('raise'), name: 'aria-pressed', value: 'true' }] } },
    { do: 'wait', target: { testId: 'breakout-banner', within: stage }, name: 'When the organizer opens the rooms, the stage says which room this is, with its timer and Return to main',
      state: 'in-room', expect: { visible: [{ testId: 'breakout-banner', within: stage }] } },
    { do: 'navigate', url: '/settings', name: 'Away from the call composer the room banner sits under the page', state: 'in-room', expect: { visible: [banner], absent: [stage] } },
    { do: 'click', target: { testId: 'shell-call-dock-chat' }, name: 'The huddle chat is the room\'s: "Room 1 chat · Only people in Room 1 see these messages."', state: 'in-room',
      proves: 'story-facts', expect: { visible: [chatPane, { testId: 'meeting-chat-context' }], text: [/Room \d+ chat/], noText: LEAKS } },
    { do: 'wait', target: { testId: 'meeting-chat-announcement-note' }, name: 'The organizer\'s announcement arrives in the room chat, marked "Announcement to every room", and on the banner',
      expect: { visible: [{ testId: 'meeting-chat-announcement-note' }, { testId: 'breakout-banner-announcement' }] } },
    { do: 'click', target: { testId: 'breakout-banner-return' }, name: 'Return to main leaves the room: no banner and no room chat line', writes: true,
      expect: { absent: [banner, { testId: 'meeting-chat-context' }] } },
  ];
}

export function callRoomsMap(role: 'org-leader' | 'sme'): JourneyMap {
  const organizerWalk = role === 'org-leader';
  return {
    family: 'work', log: `${role}/call-rooms`, kind: 'surface', persona: PERSONA[role], identity: 'clone',
    scenario: { scope: 'default' }, writes: true, hold: CALL_ROOMS_HOLD, viewport: { width: 1440, height: 900 },
    goal: organizerWalk
      ? `${PERSONA[role].name}: run the Auth Migration huddle as its organizer — see and lower a raised hand, create, fill and open two breakout rooms, announce to every room from the chat, and end the rooms`
      : `${PERSONA[role].name}: take part in the Auth Migration huddle — raise a hand, be moved into a room and know it (banner, room chat), read the organizer's announcement and return to the main meeting`,
    fields: { surface: 'call-rooms', pages: PAGES },
    steps: organizerWalk ? organizer() : participant(),
  };
}
