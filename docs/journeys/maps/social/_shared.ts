// Shared pieces of the social family's maps (docs/social-journeys/PROTOCOL.md).
// Not a map: files starting with `_` are fragments the maps import. Each
// surface's steps are written once here, parameterised by what the role may
// do (the Cedar split: a participant cannot ManageChannels / ManageTeams /
// ManageRecordings; a moderator cannot ManageSocialConfig), so the four roles'
// maps differ only where that split says they must.
//
// Every map walks a fresh CLONE of its persona on the shared dev:mock stack and
// writes nothing. The hand walks these maps replace (2026-10-22..24) posted
// into #general, opened DMs and rooms and deleted recordings on the shared
// stack; a map may not: chat and presence travel over the realtime gateway,
// which no request-scoped mock world reaches (middleware/src/mock/core/scope.ts:
// "the realtime gateway's socket handlers" see no scope), and rooms, teams,
// recordings and the call log are platform-api's (GET /api/social/* answers
// `source: platform`), which has no scope or reset at all. So:
//   - management is proven by the controls a role is offered and by refusal
//     probes whose bodies the routes reject even past the gate (403 = Cedar
//     refused, 400 = validation past the gate: nothing is created either way);
//   - dialogs are opened and dismissed with Escape, never submitted;
//   - "realtime" is proven without sending a message: by presence (a second
//     identity opening a page, seen without a reload) or, on a hangout, by a
//     second clone joining its call (the meeting scenario: gateway call state
//     only, platform-api faked by the signalling fixture, the call left on close);
//   - empty states come from what a fresh clone honestly owns (platform-api
//     holds no teams, recordings or calls for it) and from unknown ids.
import type { Persona, Step, Target } from '../../../../scripts/journeys/journey-map.ts';

export type SocialRole = 'participant' | 'moderator' | 'community-admin' | 'admin';

export const PERSONA: Record<SocialRole, Persona> = {
  participant: { user: 'u-sana', name: 'Sana Iqbal', tenant: 'social', role: 'participant' },
  moderator: { user: 'u-lena', name: 'Lena Brandt', tenant: 'social', role: 'moderator' },
  'community-admin': { user: 'u-mira', name: 'Mira Okafor', tenant: 'social', role: 'community-admin' },
  // The platform operator lands in orgiq; the Social workspace is entered as admin (PROTOCOL "Sign in").
  admin: { user: 'u-operator', name: 'Platform Operator', tenant: 'social', role: 'admin', switchTenant: true },
};
/** The second identity (PROTOCOL: u-sana when auditing as anyone else, u-mira when auditing as u-sana). */
const SECOND: Record<SocialRole, Persona> = {
  participant: PERSONA['community-admin'], moderator: PERSONA.participant, 'community-admin': PERSONA.participant, admin: PERSONA.participant,
};
/**
 * For presence the second identity is the SEED persona itself (a plain login, no switch, read-only): the portal
 * draws presence only for ids in the people directory (EmbeddedSocial.tsx `validIds`), which holds no clone, so a
 * second clone's arrival is invisible to everyone (probed 2026-10-29: 35 s, no change; the seed persona: 0.25 s).
 */
export const PEER: Record<SocialRole, Persona> = Object.fromEntries(Object.entries(SECOND).map(([r, p]) => [r, { ...p, identity: 'persona' as const }])) as Record<SocialRole, Persona>;
/** A hangout's call is joined by a clone (the meeting scenario writes gateway call state; a seed persona never writes). */
export const PEER_CLONE = SECOND;
export const PEER_REASON = 'the second identity must be its seed persona: the portal draws presence only for people in the directory, which holds no clone; it only opens pages';

const manages = (r: SocialRole) => r !== 'participant';
const configures = (r: SocialRole) => r === 'community-admin' || r === 'admin';
const ROLE_LABEL: Record<SocialRole, string> = { participant: 'Participant', moderator: 'Moderator', 'community-admin': 'Community admin', admin: 'Admin' };

const rail: Target = { testId: 'social-chat-rail' };
const shellLink = (name: string): Target => ({ role: 'link', name, exact: true, within: { css: '[data-shell-nav]' } });
const NAV = ['Direct messages', 'Channels', 'Calls', 'Hangouts', 'Contacts', 'Teams', 'Recordings', 'Configuration'];

export const tabWalk = (min: number): Step => ({ do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: min } });

/** POST an empty body to a management route: 403 for a role Cedar refuses, 400 (validation, past the gate) for one it admits. */
function manageProbe(role: SocialRole, url: string, what: string, may: boolean): Step {
  return {
    do: 'api', method: 'POST', url, body: {}, proves: 'role-gating',
    refusal: 'the body is empty, which the route rejects with 400 even past the gate, so nothing is created',
    name: may ? `POST ${url} with an empty body answers 400: the gate admits this role to ${what}, and validation refuses the empty body`
      : `POST ${url} with an empty body answers 403: Cedar refuses this role ${what}`,
    expect: { status: may ? 400 : 403 },
  };
}
const channelProbe = (r: SocialRole) => manageProbe(r, '/api/social/channels', 'creating channels', manages(r));
const teamProbe = (r: SocialRole) => manageProbe(r, '/api/social/teams', 'creating teams', manages(r));
const roomProbe = (r: SocialRole) => manageProbe(r, '/api/social/rooms', 'opening hangouts', manages(r));

/** The shell's Social navigation, the same for every role (Configuration is readable by all; only its edits are gated). */
function shellNav(url: string): Step {
  return {
    do: 'navigate', url, audit: false, auditReason: 'the resting state the first step measured',
    name: `The Social navigation lists ${NAV.join(', ')}`, proves: 'role-gating', expect: { visible: NAV.map(shellLink) },
  };
}

// ── Presence: the realtime proof (no message is sent) ─────────────────────

/** The peer clone opens `url`; the walker's Active now (or Contacts' Here now) shows it without a reload. */
function presence(role: SocialRole, url: string, where: 'rail' | 'contacts'): Step[] {
  const peer = PEER[role];
  const first = peer.name!.split(' ')[0]!;
  const target: Target = where === 'rail'
    ? { text: first, exact: true, within: { css: '[data-rail-section="active-now"]' } }
    : { text: 'Here now', exact: true, within: { css: `tbody tr:has-text("${peer.name}")` } };
  return [
    { do: 'navigate', actor: 'peer', url, name: `${peer.name} opens ${url} in her own browser`, audit: false, auditReason: 'the peer’s page; the walker’s is measured' },
    { do: 'wait', target, state: 'live', proves: 'realtime',
      name: where === 'rail' ? `Without a reload, ${first} appears under Active now in the walker’s rail` : `Without a reload, ${peer.name}’s row turns to Here now on the walker’s Contacts`,
      expect: { visible: [target] } },
  ];
}

// ── The surfaces ──────────────────────────────────────────────────────────



export const SURFACES = {
  channels: (role: SocialRole): Step[] => [
    role === 'admin'
      // The operator holds no channel membership: #general offers Join (never pressed here).
      ? { do: 'navigate', url: '/social/channels/general', name: 'Open #general: the chat workspace’s rail and the channel, which the operator has not joined, offering Join', expect: { visible: [{ role: 'heading', name: 'Channels', level: 1 }, rail, { testId: 'social-chat-rail-list-channels' }, { testId: 'social-channel-not-joined' }, { testId: 'social-join-channel' }] } }
      : { do: 'navigate', url: '/social/channels/general', name: 'Open #general: the rail, the channel header with Chat, Documents, Pinned and Calls, the call actions and the composer', expect: {
        visible: [{ role: 'heading', name: 'Channels', level: 1 }, rail, { testId: 'social-chat-rail-list-channels' }, { testId: 'social-chat-panel-header' },
          { testId: 'social-chat-panel-tab-chat' }, { testId: 'social-chat-panel-tab-documents' }, { testId: 'social-chat-panel-tab-pins' }, { testId: 'social-chat-panel-tab-calls' },
          { testId: 'social-chat-panel-audio-call' }, { testId: 'social-chat-panel-video-call' }, { testId: 'social-chat-composer' }],
        count: [{ target: { testId: 'chat-message' }, min: 1 }] } },
    shellNav('/social/channels/general'),
    manages(role)
      ? { do: 'navigate', url: '/social/channels/general', name: 'Create a channel is offered in the Channels section', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-create-channel' }] } }
      : { do: 'navigate', url: '/social/channels/general', name: 'No Create a channel control in the DOM for a participant', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { absent: [{ testId: 'social-create-channel' }] } },
    channelProbe(role),
    teamProbe(role),
    tabWalk(15),
    ...(role === 'admin' ? [] : [
      { do: 'click', target: { testId: 'social-chat-panel-tab-documents' }, name: 'Documents shows the channel’s documents', state: 'tab-documents', expect: { url: /view=documents/ } },
      { do: 'press', key: 'Enter', target: { testId: 'social-chat-panel-tab-chat' }, name: 'Enter on Chat brings the messages and the composer back', proves: 'keyboard', expect: { visible: [{ testId: 'social-chat-composer' }] } },
    ] as Step[]),
    { do: 'press', key: 'Enter', target: { role: 'button', name: /^#random/, within: { testId: 'social-chat-rail-list-channels' } }, name: 'Enter on the #random row opens it', state: 'row-open', proves: 'keyboard', expect: { url: '/social/channels/random' } },
    { do: 'navigate', url: '/social/channels/no-such-channel', name: 'An unknown channel says it is not available', state: 'not-found', proves: 'empty-state', expect: { visible: [{ testId: 'social-channel-missing' }], text: [/is not available/] } },
    { do: 'navigate', url: '/social/channels/general', name: 'Back on #general', audit: false, auditReason: 'the resting state the first step measured' },
    ...presence(role, '/social/channels/general', 'rail'),
  ],

  dms: (role: SocialRole): Step[] => {
    // A clone gets its own copies of its persona's DMs (middleware/src/lib/clone-dms.ts); the operator has none.
    const has = role !== 'admin';
    return [
      has
        ? { do: 'navigate', url: '/social/dms', name: 'Open Direct messages: the DM list in the rail, newest first', expect: { visible: [{ role: 'heading', name: 'Direct messages', level: 1 }, rail, { testId: 'social-chat-rail-list-dms' }], count: [{ target: { css: '[data-testid="conversation-row"]', within: { testId: 'social-chat-rail-list-dms' } }, min: 1 }] } }
        : { do: 'navigate', url: '/social/dms', name: 'Open Direct messages: the operator has no conversations yet, and the pane offers a new message', state: 'empty', proves: 'empty-state', expect: { visible: [{ role: 'heading', name: 'Direct messages', level: 1 }, rail, { testId: 'social-empty-dms' }, { testId: 'social-empty-new-dm' }] } },
      shellNav('/social/dms'),
      { do: 'navigate', url: '/social/dms', name: 'The DM route draws only its own section: no Create a channel, no Create a team', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { absent: [{ testId: 'social-create-channel' }, { testId: 'social-team-tree-create-team' }], visible: [{ testId: 'social-new-dm' }] } },
      channelProbe(role),
      ...(has ? [
        { do: 'click', target: { css: '[data-testid="conversation-row"]', within: { testId: 'social-chat-rail-list-dms' }, nth: 0 }, name: 'Open the newest DM: its header and composer', state: 'row-open', expect: { url: /^\/social\/dms\/social(%3A|:)dm/, visible: [{ testId: 'social-chat-panel-header' }, { testId: 'social-chat-composer' }] } },
        { do: 'click', target: { testId: 'social-chat-panel-tab-documents' }, name: 'Documents shows the conversation’s documents', state: 'tab-documents', expect: { url: /view=documents/ } },
        { do: 'press', key: 'Enter', target: { testId: 'social-chat-panel-tab-chat' }, name: 'Enter on Chat brings the messages and the composer back', proves: 'keyboard', expect: { visible: [{ testId: 'social-chat-composer' }] } },
      ] as Step[] : []),
      { do: 'press', key: 'Enter', target: { testId: 'social-new-dm' }, name: 'Enter on New message opens the person picker', state: 'dialog-open', proves: 'keyboard', expect: { visible: [{ testId: 'social-dm-picker' }] } },
      { do: 'press', key: 'Escape', name: 'Escape closes the picker', proves: 'keyboard', expect: { hidden: [{ testId: 'social-dm-picker' }] } },
      tabWalk(10),
      { do: 'navigate', url: '/social/dms/social%3Adm%3Au-nobody%3Au-nothere', name: 'A DM that names neither of this identity’s ids says it is not yours', state: 'not-found', proves: 'empty-state', expect: { text: ['This conversation is not yours'] } },
      { do: 'navigate', url: '/social/dms', name: 'Back on Direct messages', audit: false, auditReason: 'the resting state the first step measured' },
      ...presence(role, '/social/dms', 'rail'),
    ];
  },

  calls: (role: SocialRole): Step[] => [
    // platform-api holds no call for a fresh clone: its log is honestly empty.
    { do: 'navigate', url: '/social/calls', name: 'Open Calls: the shelf’s call log, empty for a fresh identity, with Call someone', state: 'empty', proves: 'empty-state', expect: { visible: [{ role: 'heading', name: 'Calls', level: 1 }, rail, { testId: 'social-call-log-pane' }, { testId: 'social-empty-calls' }], text: ['No calls yet'] } },
    shellNav('/social/calls'),
    { do: 'navigate', url: '/social/calls', name: 'Call someone is offered (every role may StartCall)', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ role: 'button', name: 'Call someone', within: { testId: 'social-call-log-pane' } }] } },
    role === 'admin'
      ? { do: 'navigate', url: '/social/channels/general', name: 'A channel the operator has not joined offers Join, not a call', proves: 'role-gating', expect: { visible: [{ testId: 'social-join-channel' }], absent: [{ testId: 'social-chat-panel-audio-call' }] } }
      : { do: 'navigate', url: '/social/channels/general', name: 'A conversation’s header offers an audio and a video call, both enabled', proves: 'role-gating', expect: { enabled: [{ testId: 'social-chat-panel-audio-call' }, { testId: 'social-chat-panel-video-call' }] } },
    { do: 'navigate', url: '/social/calls', name: 'Back on Calls', audit: false, auditReason: 'the resting state the first step measured' },
    tabWalk(6),
    { do: 'press', key: 'Enter', target: { role: 'button', name: 'Call someone', within: { testId: 'social-call-log-pane' } }, name: 'Enter on Call someone leaves the log for a place to start one', proves: 'keyboard', expect: { urlNot: /^\/social\/calls$/ } },
    { do: 'navigate', url: '/social/calls', name: 'Back on Calls again', audit: false, auditReason: 'the resting state the first step measured' },
    ...presence(role, '/social/calls', 'rail'),
  ],

  rooms: (role: SocialRole): Step[] => [
    { do: 'navigate', url: '/social/rooms', name: 'Open Hangouts: the focused Hangouts rail and the hangout directory', expect: { visible: [{ role: 'heading', name: 'Hangouts', level: 1 }, rail, { testId: 'social-rooms-list' }, { testId: 'social-room-directory' }], count: [{ target: { testId: 'social-room-card' }, min: 1 }], absent: [{ css: '[data-rail-section="active-now"]' }, { testId: 'social-chat-rail-shelf' }] } },
    shellNav('/social/rooms'),
    manages(role)
      ? { do: 'navigate', url: '/social/rooms', name: 'New hangout is offered in the directory and New room in the rail', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-directory-new-room' }, { testId: 'new-room-button' }] } }
      : { do: 'navigate', url: '/social/rooms', name: 'No New hangout or New room control in the DOM for a participant', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { absent: [{ testId: 'social-directory-new-room' }, { testId: 'new-room-button' }] } },
    roomProbe(role),
    ...(manages(role) ? [
      { do: 'click', target: { testId: 'social-directory-new-room' }, name: 'New hangout opens the create dialog (nothing is created)', state: 'dialog-open', expect: { visible: [{ role: 'dialog' }], text: ['New hangout'] } },
      { do: 'press', key: 'Escape', name: 'Escape closes the dialog', proves: 'keyboard', expect: { hidden: [{ role: 'dialog' }] } },
    ] as Step[] : []),
    tabWalk(8),
    { do: 'fill', target: { role: 'textbox', name: 'Find a hangout', exact: true }, value: 'zzzzqq', name: 'Find a hangout for zzzzqq: the directory says nothing matches', state: 'filtered-empty', proves: 'empty-state', expect: { visible: [{ testId: 'social-room-search-empty' }], text: ['No matching hangouts'] } },
    { do: 'fill', target: { role: 'textbox', name: 'Find a hangout', exact: true }, value: '', name: 'Clear the search: the hangouts come back', audit: false, auditReason: 'the resting state again', expect: { count: [{ target: { testId: 'social-room-card' }, min: 1 }] } },
    { do: 'press', key: 'Enter', target: { role: 'button', name: /^Open /, within: { testId: 'social-room-directory' } }, name: 'Enter on a hangout’s Open opens its record: access, host, call, recording and Join call', state: 'row-open', proves: 'keyboard', expect: { url: /room=/, visible: [{ testId: 'social-room-detail' }, { testId: 'social-room-facts' }, { testId: 'social-room-join' }] } },
    { do: 'click', target: { testId: 'social-room-back' }, name: 'All hangouts returns to the directory', expect: { visible: [{ testId: 'social-room-directory' }] } },
    { do: 'navigate', url: '/social/rooms?room=no-such-room', name: 'An unknown hangout says it is not available', state: 'not-found', proves: 'empty-state', expect: { visible: [{ testId: 'social-room-missing' }], text: ['This hangout is not available'] } },
    { do: 'navigate', url: '/social/rooms?room=design-studio', name: 'Open the Design studio hangout: nobody is in its call', audit: false, auditReason: 'the record step measured above', expect: { visible: [{ testId: 'hangout-active-people' }], text: ['No one is in this call right now.'] } },
    { do: 'navigate', actor: 'peer', url: '/social/rooms?room=design-studio', name: `${PEER_CLONE[role].name} (a second clone) opens the same hangout in her own browser`, audit: false, auditReason: 'the peer’s page; the walker’s is measured' },
    // The gateway owns call state (no mock scope reaches it); the meeting fixture fakes platform-api, so nothing is recorded there, and the runner leaves the call on close.
    { do: 'click', actor: 'peer', target: { testId: 'social-room-join' }, writes: true, name: `${PEER_CLONE[role].name} (the clone) joins the hangout’s call (signalling-only media)`, audit: false, auditReason: 'the peer’s page; the walker’s is measured' },
    // A hangout's Active now is call occupancy (useLobbyCall): the peer's join must reach the walker without a reload.
    { do: 'wait', target: { testId: 'hangout-active-people' }, state: 'live', proves: 'realtime', screenshot: 'log', name: 'Without a reload, the walker’s Active now stops saying no one is in the call: the peer is in it', expect: { noText: ['No one is in this call right now.'] } },
  ],

  contacts: (role: SocialRole): Step[] => [
    { do: 'navigate', url: '/social/contacts', name: 'Open Contacts: the roster with who is here now', expect: { visible: [{ role: 'heading', name: 'Contacts', level: 1 }, { testId: 'social-contacts-table' }, { testId: 'social-contacts-here' }], count: [{ target: { css: 'tbody tr', within: { testId: 'social-contacts-table' } }, min: 10 }] } },
    shellNav('/social/contacts'),
    { do: 'navigate', url: '/social/contacts', name: 'Message (PostMessage) and Call (StartCall) on the rows', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { count: [{ target: { testId: 'social-contact-message' }, min: 10 }, { target: { testId: 'social-contact-call' }, min: 10 }] } },
    { do: 'fill', target: { role: 'textbox', name: 'Search contacts', exact: true }, value: 'zzzzqq', name: 'Search contacts for zzzzqq: the table says no person matches', state: 'filtered-empty', proves: 'empty-state', expect: { text: ['No person matches these filters.'] } },
    { do: 'fill', target: { role: 'textbox', name: 'Search contacts', exact: true }, value: '', name: 'Clear the search: the roster comes back', audit: false, auditReason: 'the resting state again', expect: { count: [{ target: { css: 'tbody tr', within: { testId: 'social-contacts-table' } }, min: 10 }] } },
    tabWalk(20),
    ...presence(role, '/social/contacts', 'contacts'),
  ],

  teams: (role: SocialRole): Step[] => [
    // platform-api holds no team for a fresh clone (GET /api/social/teams → 0): the honest empty state.
    { do: 'navigate', url: '/social/teams', name: manages(role) ? 'Open Teams: on no team yet, the pane offers New team' : 'Open Teams: on no team yet, the pane says a moderator adds you to one', state: 'empty', proves: 'empty-state',
      expect: { visible: [{ role: 'heading', name: 'Teams', level: 1 }, rail, { testId: 'social-empty-teams' }], text: [manages(role) ? 'Create one and add the people it is for.' : 'A moderator adds you to one.'] } },
    shellNav('/social/teams'),
    manages(role)
      ? { do: 'navigate', url: '/social/teams', name: 'Create a team is offered in the rail and New team in the pane', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-team-tree-create-team' }, { testId: 'social-empty-create-team' }] } }
      : { do: 'navigate', url: '/social/teams', name: 'No Create a team or New team control in the DOM for a participant', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { absent: [{ testId: 'social-team-tree-create-team' }, { testId: 'social-empty-create-team' }] } },
    teamProbe(role),
    ...(manages(role) ? [
      { do: 'click', target: { testId: 'social-empty-create-team' }, name: 'New team opens the create form (nothing is created)', state: 'dialog-open', expect: { visible: [{ role: 'dialog' }] } },
      { do: 'press', key: 'Escape', name: 'Escape closes it', proves: 'keyboard', expect: { hidden: [{ role: 'dialog' }] } },
    ] as Step[] : []),
    tabWalk(6),
    { do: 'navigate', url: '/social/teams?channel=social%3Ateam%3Ano-such-team%3Ageneral', name: 'An unknown team channel says it is not available', state: 'not-found', proves: 'empty-state', expect: { visible: [{ testId: 'social-team-channel-missing' }], text: ['This team channel is not available'] } },
    { do: 'navigate', url: '/social/teams', name: 'Back on Teams', audit: false, auditReason: 'the resting state the first step measured' },
    ...presence(role, '/social/teams', 'rail'),
  ],

  recordings: (role: SocialRole): Step[] => [
    // platform-api holds no recording a fresh clone was on: the honest empty list.
    { do: 'navigate', url: '/social/recordings', name: 'Open Recordings: the shelf’s list, empty for a fresh identity', state: 'empty', proves: 'empty-state', expect: { visible: [{ role: 'heading', name: 'Recordings', level: 1 }, rail, { testId: 'social-recordings-pane' }, { testId: 'social-empty-recordings' }], text: ['No recordings yet'] } },
    shellNav('/social/recordings'),
    { do: 'api', method: 'POST', url: '/api/social/recordings/no-such-recording/share', body: {}, proves: 'role-gating',
      refusal: 'the recording does not exist, so the route cannot share it even past the gate',
      name: manages(role) ? 'Sharing an unknown recording gets past the gate (ManageRecordings) and is refused for the missing recording' : 'Sharing a recording is refused by Cedar (no ManageRecordings)',
      expect: { status: manages(role) ? [400, 404] : 403 } },
    { do: 'api', method: 'DELETE', url: '/api/social/recordings/no-such-recording', proves: 'role-gating',
      refusal: 'the recording does not exist, so the route cannot delete it even past the gate',
      name: manages(role) ? 'Deleting an unknown recording gets past the gate and is refused for the missing recording' : 'Deleting a recording is refused by Cedar',
      expect: { status: manages(role) ? [400, 404] : 403 } },
    tabWalk(6),
    { do: 'navigate', url: '/social/recordings?recording=no-such-recording', name: 'An unknown recording id still shows the honest empty list, not a broken player', state: 'not-found', proves: 'empty-state', expect: { visible: [{ testId: 'social-empty-recordings' }], absent: [{ testId: 'social-recording-detail' }] } },
    { do: 'navigate', url: '/social/recordings', name: 'The list is fetched and refreshed, not pushed: nothing on it is live', proves: 'realtime', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-recordings-pane' }] } },
  ],

  configuration: (role: SocialRole): Step[] => [
    { do: 'navigate', url: '/social/configuration', name: 'Open Configuration: what each role can do, the people per role, where the data lives', expect: { visible: [{ role: 'heading', name: 'Configuration', level: 1 }, { testId: 'social-configuration-matrix' }, { testId: 'social-configuration-people' }, { testId: 'social-configuration-sources' }] } },
    shellNav('/social/configuration'),
    configures(role)
      ? { do: 'navigate', url: '/social/configuration', name: 'ManageSocialConfig: the page says this role may configure the workspace and shows every role’s column', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { text: [/Your role may configure this workspace/], visible: [{ role: 'columnheader', name: /^Participant/i }, { role: 'columnheader', name: /^Moderator/i }, { role: 'columnheader', name: new RegExp(`^${ROLE_LABEL[role]} \\(you\\)`, 'i') }] } }
      : { do: 'navigate', url: '/social/configuration', name: 'No ManageSocialConfig: the page says only a community admin changes it, and shows this role’s own column', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { text: [/Only a community admin can change this workspace's configuration/], visible: [{ role: 'columnheader', name: new RegExp(`^${ROLE_LABEL[role]} \\(you\\)`, 'i') }] } },
    { do: 'navigate', url: '/social/configuration', name: 'Nothing on the page is editable: no form, no Save', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-configuration-readonly' }], absent: [{ role: 'button', name: /^Save/ }, { css: 'main form' }] } },
    tabWalk(3),
    { do: 'navigate', url: '/social/configuration', name: 'The page always has the viewer’s own role and grant to show', proves: 'empty-state', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-configuration-people-count' }] } },
    { do: 'navigate', url: '/social/configuration', name: 'Nothing on it is live', proves: 'realtime', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'social-configuration-matrix' }] } },
  ],

  activity: (role: SocialRole): Step[] => [
    { do: 'navigate', url: '/social/channels', name: 'Open Channels, where the header bell sits', expect: { visible: [{ testId: 'activity-bell-button' }, rail] } },
    { do: 'press', key: 'Enter', target: { testId: 'activity-bell-button' }, name: 'Enter on the bell opens the popover, empty for a fresh identity', state: 'dialog-open', proves: ['keyboard', 'empty-state'], expect: { text: ['Nothing new'] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the popover and focus returns to the bell', proves: 'keyboard', expect: { focused: { testId: 'activity-bell-button' }, noText: ['Nothing new'] } },
    { do: 'navigate', url: '/social/channels', name: 'The bell is the same control for every role; items are filtered to the tenants the session holds', proves: 'role-gating', audit: false, auditReason: 'the resting state the first step measured', expect: { visible: [{ testId: 'activity-bell' }] } },
    tabWalk(8),
    { do: 'navigate', actor: 'peer', url: '/social/dms', name: `${PEER[role].name} opens Direct messages to write to the walker`, audit: false, auditReason: 'the peer’s page' },
    { do: 'wait', target: { role: 'button', name: /Activity, 1 unread/ }, state: 'live', proves: 'realtime', name: 'Her DM turns the walker’s bell to 1 unread without a reload' },
  ],
} satisfies Record<string, (role: SocialRole) => Step[]>;

export type Surface = keyof typeof SURFACES;

export const PAGES: Record<Surface, string> = {
  activity: 'portal/src/components/shell/ActivityBell.tsx',
  channels: 'portal/src/pages/social/ChannelsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts',
  dms: 'portal/src/pages/social/DmsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts',
  calls: 'portal/src/pages/social/CallsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/CallLogPane.tsx,portal/src/pages/social/useSocialCall.ts',
  rooms: 'portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialRoomsSection.tsx,portal/src/pages/social/RoomDirectory.tsx,portal/src/pages/social/RoomPane.tsx',
  contacts: 'portal/src/pages/social/ContactsPage.tsx',
  teams: 'portal/src/pages/social/TeamsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx',
  recordings: 'portal/src/pages/social/RecordingsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/RecordingsPane.tsx',
  configuration: 'portal/src/pages/social/ConfigurationPage.tsx',
};

const WHO: Record<SocialRole, string> = { participant: 'Sana (participant)', moderator: 'Lena (moderator)', 'community-admin': 'Mira (community admin)', admin: 'The platform operator (admin)' };
export function goal(role: SocialRole, surface: Surface): string {
  const w = WHO[role];
  switch (surface) {
    case 'activity': return `${w} opens the header bell, closes it from the keyboard, and sees a second identity’s DM arrive in it live`;
    case 'channels': return `${w} reads #general, moves between channels from the keyboard, ${manages(role) ? 'is offered channel creation' : 'is never offered channel creation'}, and sees a second identity arrive live`;
    case 'dms': return `${w} works the DM list, opens a conversation and the new-message picker, and sees a second identity arrive live`;
    case 'calls': return `${w} reads the call log and finds where a call starts, and sees a second identity arrive live`;
    case 'rooms': return `${w} browses the hangouts, opens one${manages(role) ? ', is offered a new one (and backs out)' : ', is never offered a new one'}, and sees a second identity join its call live`;
    case 'contacts': return `${w} reads the roster, narrows it, and sees a second identity come online without a reload`;
    case 'teams': return `${w} meets Teams on no team yet, ${manages(role) ? 'is offered a new one (and backs out)' : 'is told a moderator adds people'}, and sees a second identity arrive live`;
    case 'recordings': return `${w} reads the recordings list, ${manages(role) ? 'whose share and delete gates admit this role' : 'whose share and delete gates refuse this role'}`;
    case 'configuration': return `${w} reads how the workspace is configured, ${configures(role) ? 'as a role that may configure it' : 'without being able to change it'}`;
  }
}

/** Claims whose value is not `pass`: surfaces with nothing live, a page that always has content. */
export function claims(surface: Surface): Record<string, string> | undefined {
  if (surface === 'recordings') return { realtime: 'n/a — the list is fetched on open and on refresh; no push delivery is claimed' };
  if (surface === 'configuration') return { realtime: 'n/a — nothing on it is live', 'empty-state': 'n/a — the page always has the viewer’s own role and grant to show' };
  return undefined;
}

/** Why the activity maps are held (journey-map.ts `hold`). */
export const ACTIVITY_HOLD = 'the bell’s live item needs a second identity to send the walker a DM or mention — a chat write over the realtime gateway, which no request-scoped mock world reaches, so it would land in the shared chat store; the runner has no peer step that delivers a notification without that write';

// ── Isolation (PROTOCOL "Isolation logs") ─────────────────────────────────

const anchorsTo = (prefix: string): Target => ({ css: `a[href^="${prefix}"]` });
const FORBIDDEN = /403|Forbidden/i;
const SOCIAL_CONTENT = ['#general', 'Direct messages', 'Hangouts'];
const away = (url: string, from: RegExp, field: string, noText: string[] = []): Step => ({
  do: 'navigate', url, name: `Type ${url}: the route sends this identity away`, state: 'refused', proves: field, expectConsole: FORBIDDEN,
  expect: { urlNot: from, ...(noText.length ? { noText } : {}) },
});
const forbidden = (url: string, field: string): Step => ({ do: 'api', url, name: `GET ${url} answers 403`, proves: field, expect: { status: 403 } });

export const ISOLATION_PAGES = 'portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx';

/**
 * Inbound: a role of another tenant, standing in its own tenant, reaches for Social. `grant` is whether the
 * identity holds a social grant (the Social tile must show exactly then); `foreign` the route prefixes of the
 * tenants it holds no grant in, which no bell item may link to.
 */
export function inbound(landing: string, grant: boolean, foreign: string[]): Step[] {
  const tile: Target = { testId: 'select-roles-social' };
  return [
    { do: 'navigate', url: '/select', name: grant ? 'The workspace chooser shows the Social tile: this identity holds a social grant' : 'The workspace chooser shows no Social tile: this identity holds no social grant',
      proves: ['social-grant', 'social-tile-visible'], expect: grant ? { visible: [{ testId: 'select-workspace-grid' }, tile] } : { visible: [{ testId: 'select-workspace-grid' }], absent: [tile] } },
    { do: 'navigate', url: landing, name: `The shell on ${landing}, its own tenant, holds no link toward /social`, proves: 'social-nav-visible', screenshot: 'log', expect: { absent: [anchorsTo('/social')] } },
    away('/social/channels', /^\/social/, 'direct-route-result', SOCIAL_CONTENT),
    away('/social/rooms', /^\/social/, 'direct-route-result', SOCIAL_CONTENT),
    away('/social/dms', /^\/social/, 'direct-route-result', SOCIAL_CONTENT),
    { do: 'navigate', url: landing, name: 'Back on its own landing, still no link toward /social', proves: 'social-nav-visible', audit: false, auditReason: 'the landing step 2 measured', expect: { absent: [anchorsTo('/social')] } },
    ...['/api/social/summary', '/api/social/channels', '/api/social/rooms', '/api/social/teams', '/api/social/recordings', '/api/social/calls'].map((u) => forbidden(u, 'api-status')),
    { do: 'click', target: { testId: 'activity-bell-button' }, name: `The bell opens on ${landing}; no item in it links into a tenant this identity holds no grant in`, state: 'dialog-open', proves: 'activity-leak',
      expect: { text: ['Notifications'], absent: foreign.map((p) => ({ css: `a[href^="${p}"]`, within: { role: 'dialog' } }) as Target) } },
    { do: 'press', key: 'Escape', name: 'Escape closes the bell', audit: false, auditReason: 'the landing again', proves: 'activity-leak', expect: { focused: { testId: 'activity-bell-button' } } },
  ];
}
export function inboundClaims(grant: boolean): Record<string, string> {
  return { 'social-grant': grant ? 'yes' : 'no', 'social-tile-visible': grant ? 'yes' : 'no', 'social-nav-visible': 'no', 'direct-route-result': 'redirect', 'api-status': '403', 'activity-leak': 'none' };
}

/** Outbound: a social role reaches for orgiq and assessment. */
export function outbound(): Step[] {
  return [
    { do: 'navigate', url: '/social/channels', name: 'The Social shell holds no link toward /iq or /admin', proves: 'orgiq-nav-visible', expect: { absent: [anchorsTo('/iq'), anchorsTo('/admin')] } },
    { do: 'navigate', url: '/social/channels', name: 'Nor toward /assessment', proves: 'assessment-nav-visible', audit: false, auditReason: 'the landing step 1 measured', expect: { absent: [anchorsTo('/assessment')] } },
    away('/iq/projects', /^\/iq/, 'orgiq-route-result'),
    away('/iq/runs', /^\/iq/, 'orgiq-route-result'),
    away('/iq/search', /^\/iq/, 'orgiq-route-result'),
    ...['/api/bots', '/api/graph/people?limit=1', '/api/work/summary', '/api/runs'].map((u) => forbidden(u, 'orgiq-api-status')),
    away('/assessment/teams', /^\/assessment/, 'assessment-route-result'),
    { ...away('/assessment/workspace?doc=page%3A100002', /^\/assessment/, 'assessment-route-result'), screenshot: 'log' },
    ...['/api/assessment/teams', '/api/assessment/knowledge/tree', '/api/assessment/pipeline-runs'].map((u) => forbidden(u, 'assessment-api-status')),
  ];
}
export const OUTBOUND_CLAIMS = Object.fromEntries(['orgiq', 'assessment'].flatMap((t) => [[`${t}-nav-visible`, 'no'], [`${t}-route-result`, 'redirect'], [`${t}-api-status`, '403']]));
export const OUTBOUND_PAGES = 'portal/src/App.tsx,portal/src/components/shell/Layout.tsx';
