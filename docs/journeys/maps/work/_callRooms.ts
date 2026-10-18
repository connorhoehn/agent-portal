// Three clone identities walk the same huddle in order. The gateway and meeting state are real;
// media uses the E1 signalling fixture. The real SFU move is proved by E2.
import type { JourneyMap, Step, Target } from '../../../../scripts/journeys/journey-map.ts';
import { LEAKS, PERSONA } from './_shared.ts';

const PARTICIPANT = { user: 'u-caleb', name: 'Caleb Turner', tenant: 'orgiq', role: 'sme' };
// Initial reads can precede call.join registration; the call controllers retry
// these two endpoints. A different status/path still fails the walk.
const REGISTRATION_RETRY = /^Failed to load resource:.*404.*\[404 GET \/api\/calls\/[^/ ,]+\/(?:page|chat)(?:, 404 GET \/api\/calls\/[^/ ,]+\/(?:page|chat))*\]$/;
const URL = '/iq/projects/p-auth-migration';
const huddle: Target = { role: 'button', name: 'Huddle', within: { testId: 'shell-footer-context' } };
const stage: Target = { testId: 'huddle-meeting-stage' };
const item = (id: string): Target => ({ testId: `meeting-toolbar-${id}`, within: stage });
const panel: Target = { testId: 'huddle-breakout-rooms' };
const banner: Target = { testId: 'breakout-banner' };
const PAGES = 'portal/src/components/shell/CallMeeting.tsx, portal/src/components/shell/HuddleChat.tsx, portal/src/components/shell/SocialFooter.tsx, portal/src/lib/meetingRooms.ts';

export function callRoomsMap(role: 'org-leader' | 'sme'): JourneyMap {
  const isOrganizer = role === 'org-leader';
  const host = isOrganizer ? undefined : 'organizer';
  const member = isOrganizer ? 'participant' : undefined;
  const steps: Step[] = [];
  const add = (actor: string | undefined, step: Step) => steps.push({ ...step, ...(actor ? { actor } : {}) });
  // The primary walk opens first; Vera always starts the call, so Caleb remains a participant.
  add(undefined, { do: 'navigate', url: URL, name: 'Open Auth Migration as the primary walker', expect: { visible: [huddle] } });
  for (const [actor, name] of [[host, 'Vera'], [member, 'Caleb'], ['extra', 'Theo']] as const) {
    add(actor, { do: 'navigate', url: URL, name: `${name} opens the initiative with a fresh clone session`, expect: { visible: [huddle] } });
    add(actor, { do: 'click', target: huddle, writes: true, expectConsole: REGISTRATION_RETRY, name: `${name} joins the initiative huddle`, expect: { visible: [stage, item('raise')] } });
  }
  add(undefined, { do: 'tab-walk', name: 'The primary walker reaches the meeting controls by keyboard', proves: 'keyboard', expect: { minVisited: 6 } });
  add(member, { do: 'click', target: item('rooms'), name: 'Caleb sees an empty participant pane without organizer actions', state: 'empty', proves: ['empty-state', 'role-gating'], expect: { visible: [{ testId: 'huddle-breakout-rooms-empty' }], absent: [{ testId: 'breakout-create' }] } });
  add(member, { do: 'click', target: item('raise'), writes: true, name: 'Caleb raises his hand', expect: { attr: [{ target: item('raise'), name: 'aria-pressed', value: 'true' }] } });
  add(host, { do: 'click', target: item('people'), name: 'Vera sees Caleb by name in the hands queue', state: 'pane-open', proves: ['story-facts', 'tab-stability'], stable: [stage], expect: { visible: [{ testId: 'roster-raised-hand' }, { testId: 'roster-lower-hand' }], text: ['Caleb Turner'], noText: LEAKS } });
  add(host, { do: 'click', target: { testId: 'roster-lower-hand' }, writes: true, name: 'Vera lowers the raised hand', expect: { hidden: [{ testId: 'roster-raised-hand' }] } });
  add(member, { do: 'wait', target: item('raise'), name: 'Caleb sees the lowered hand reflected on his toolbar', expect: { attr: [{ target: item('raise'), name: 'aria-pressed', value: 'false' }] } });
  add(host, { do: 'click', target: item('rooms'), name: 'Vera opens Rooms and is offered Create', state: 'empty', proves: ['empty-state', 'role-gating'], expect: { visible: [panel, { testId: 'breakout-create' }] } });
  add(host, { do: 'fill', target: { testId: 'breakout-create-count' }, value: '2', name: 'Vera asks for two rooms' });
  add(host, { do: 'click', target: { testId: 'breakout-create-submit' }, writes: true, name: 'Vera creates two rooms', expect: { count: [{ target: { testId: 'breakout-room' }, eq: 2 }] }, ...(isOrganizer ? { screenshot: 'log' as const } : {}) });
  add(host, { do: 'click', target: { testId: 'breakout-auto-assign' }, writes: true, name: 'Vera assigns the participants automatically', expect: { count: [{ target: { testId: 'breakout-unassigned-person' }, max: 1 }] } });
  add(host, { do: 'click', target: { testId: 'breakout-open-all' }, writes: true, name: 'Vera opens both rooms and stays in the main meeting', expect: { attr: [{ target: panel, name: 'data-phase', value: 'open' }], hidden: [banner] } });
  add(member, { do: 'wait', target: banner, name: 'Caleb sees his room banner on the stage', state: 'in-room', expect: { visible: [banner], text: [/Room \d+/] }, ...(!isOrganizer ? { screenshot: 'log' as const } : {}) });
  add(member, { do: 'click', target: item('chat'), name: 'Caleb opens his room chat from the stage', state: 'in-room', proves: 'story-facts', expect: { visible: [{ testId: 'meeting-chat-context' }], text: [/Room \d+ chat/], noText: LEAKS } });
  add(host, { do: 'click', target: { text: 'All rooms', exact: true, within: { testId: 'meeting-chat-target' } }, name: 'Vera selects All rooms for the announcement' });
  add(host, { do: 'fill', target: { role: 'textbox', name: 'Message', within: { testId: 'initiative-composer' } }, value: 'Journey check: return to the main huddle shortly.', name: 'Vera writes a meeting announcement' });
  add(host, { do: 'click', target: { role: 'button', name: /^Send/, within: { testId: 'initiative-composer' } }, writes: true, name: 'Vera sends the announcement to every room' });
  add(member, { do: 'wait', target: { testId: 'meeting-chat-announcement-note' }, name: 'Caleb reads the marked announcement in his room chat and banner', expect: { visible: [{ testId: 'meeting-chat-announcement-note' }, { testId: 'breakout-banner-announcement' }], text: ['Journey check: return to the main huddle shortly.'] } });
  add(host, { do: 'click', target: { testId: 'breakout-end' }, writes: true, name: 'Vera ends the rooms', expect: { attr: [{ target: panel, name: 'data-phase', value: 'draft' }] } });
  add(member, { do: 'wait', target: { testId: 'shell-call-dock' }, name: 'Caleb is back in the main meeting', expect: { hidden: [banner, { testId: 'meeting-chat-context' }] } });
  add(host, { do: 'click', target: { testId: 'breakout-delete' }, writes: true, name: 'Vera removes the closed room drafts', expect: { visible: [{ testId: 'breakout-create' }] } });
  return {
    family: 'work', log: `${role}/call-rooms`, kind: 'surface', persona: isOrganizer ? PERSONA[role] : PARTICIPANT, identity: 'clone',
    peers: { ...(isOrganizer ? { participant: PARTICIPANT } : { organizer: PERSONA['org-leader'] }), extra: PERSONA.member },
    scenario: { realtime: 'meeting' }, writes: true, media: 'meeting-fixture', viewport: { width: 1440, height: 900 },
    goal: `${isOrganizer ? PERSONA[role].name : PARTICIPANT.name}: ${isOrganizer ? 'organize' : 'participate in'} a huddle with raised hands, breakout rooms and announcements`,
    fields: { surface: 'call-rooms', pages: PAGES }, steps,
  };
}
