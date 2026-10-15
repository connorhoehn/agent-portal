import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, seen, fact } from '../_shared.ts';

// Social: the community the other tenants talk in. #incidents carries Rachel's
// Sev 3 and Theo's root cause; #auth-migration carries the same cutover the
// Work board is blocked on; Sana's DMs and calls are with people she knows.
export default {
  family: 'demo', log: 'social/story', kind: 'story', persona: P.sana, scenario: 'shared',
  goal: 'Show a peer a lived-in community: an incident thread with a cause, a project channel that matches the board, and a member’s own DMs and calls',
  fields: { surface: 'the community story', pages: 'portal/src/pages/social' },
  steps: [
    fact('/social/channels/incidents', 'The incident thread names who reported it, the cause and the fix',
      ['Rachel Kowalski', 'Theo Chang', /transcript/i]),
    fact('/social/channels/general', 'General reads like a team: no duplicate announcements, no welcome to someone already there',
      [/Mira Okafor|Lena Brandt/], [/welcome aboard/i]),
    fact('/social/dms', 'Sana’s DMs are conversations with people she works with', ['Lena Brandt']),
    fact('/social/contacts', 'Contacts are people, not accounts', ['Mira Okafor', 'Lena Brandt'], [/User ID/, /Platform Operator/]),
    { do: 'navigate', url: '/social/recordings', name: 'A recording Sana was in has a transcript that matches the chat', proves: 'cross-links', audit: false, auditReason: 'a content walk: the layout judges measure this page', expect: { visible: [/Town hall|community call/i].map(seen), noText: [/Sana Iyer/, /spring community calendar/i, /no playable file/i] } },
  ],
} satisfies JourneyMap;
