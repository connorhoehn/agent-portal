// The social tenant's pages, as data (docs/social-tenant-design.md §4).
//
// Phase S0 registers the tenant and ships every page as an honest empty
// state: each one says what it will hold and which lane brings it. Pure data,
// no React, so `__tests__/socialSurfaces.test.ts` can run under plain
// `node --test`. When a lane lands a surface, its route in App.tsx points at
// the real page and its row here goes.

export type SocialSurfaceId =
  | 'channels' | 'dms' | 'calls' | 'rooms' | 'contacts' | 'teams'
  | 'profile' | 'recordings' | 'configuration';

export interface SocialSurface {
  id: SocialSurfaceId;
  /** Page title — the rail and palette label. */
  title: string;
  /** One line under the title: what this page is for. */
  description: string;
  /** The empty state's heading — what is not here yet. */
  emptyTitle: string;
  /** Why it is empty, in the reader's terms. */
  emptyBody: string;
  /** The lane (design §7) that brings this surface its data. */
  phase: 'S1' | 'S2' | 'N';
  /** What that lane brings, one sentence. */
  next: string;
}

export const SOCIAL_SURFACES: Record<SocialSurfaceId, SocialSurface> = {
  channels: {
    id: 'channels',
    title: 'Channels',
    description: 'Conversations the whole tenant can join, one per topic or team.',
    emptyTitle: 'No channels yet',
    emptyBody: 'Channels are where a community talks in the open. None exist in this workspace yet.',
    phase: 'S1',
    next: 'Lane S1 brings durable channels — create one, post, and read it from another tab without a reload.',
  },
  dms: {
    id: 'dms',
    title: 'Direct messages',
    description: 'One-to-one and small-group conversations.',
    emptyTitle: 'No direct messages yet',
    emptyBody: 'A direct message is visible only to the people in it. You have not started one here.',
    phase: 'S1',
    next: 'Lane S1 brings direct messages on the same durable chat store as channels.',
  },
  calls: {
    id: 'calls',
    title: 'Calls',
    description: 'Start a call with someone, or pick up where a missed one left off.',
    emptyTitle: 'No calls yet',
    emptyBody: 'Calls you place or receive in this workspace, and the ones you missed, will be listed here.',
    phase: 'S2',
    next: 'Lane S2 brings the call log, missed-call notices, and calls from any channel or room.',
  },
  rooms: {
    id: 'rooms',
    title: 'Hangouts',
    description: 'Standing rooms you can drop into without scheduling a call.',
    emptyTitle: 'No rooms yet',
    emptyBody: 'A room stays open between calls, so a team can gather in the same place every time.',
    phase: 'S2',
    next: 'Lane S2 brings rooms — public or private, with the members who may join.',
  },
  contacts: {
    id: 'contacts',
    title: 'Contacts',
    description: 'The people you talk with in this workspace, and who is around now.',
    emptyTitle: 'No contacts yet',
    emptyBody: 'Follow someone, or talk with them in a channel, and they show up here with their presence.',
    phase: 'S2',
    next: 'Lane S2 brings contacts and presence from the tenant roster.',
  },
  teams: {
    id: 'teams',
    title: 'Teams',
    description: 'Teams and the channels that belong to them.',
    emptyTitle: 'No teams yet',
    emptyBody: 'A team groups people and their channels. Moderators create teams; none exist here yet.',
    phase: 'S2',
    next: 'Lane S2 brings teams and their channel tree.',
  },
  profile: {
    id: 'profile',
    title: 'Profile',
    description: 'How you appear to other people in this workspace.',
    emptyTitle: 'Your social profile is not set up yet',
    emptyBody: 'Your name comes from your sign-in. A status and an avatar for this workspace come later.',
    phase: 'S2',
    next: 'Lane S2 brings the profile — status, avatar and who can reach you.',
  },
  recordings: {
    id: 'recordings',
    title: 'Recordings',
    description: 'Call recordings, and who they are shared with.',
    emptyTitle: 'No recordings yet',
    emptyBody: 'A recorded call lands here for everyone who was on it. Nothing has been recorded in this workspace.',
    phase: 'S2',
    next: 'Lane S2 brings the recordings list, playback, and share links.',
  },
  configuration: {
    id: 'configuration',
    title: 'Configuration',
    description: 'Retention, who may open a room, and the workspace\'s integrations.',
    emptyTitle: 'Nothing to configure yet',
    emptyBody: 'Settings appear here as the features they govern arrive. Only a community admin can change them.',
    phase: 'S2',
    next: 'Lane S2 brings retention and room policy, on the same forms the other workspaces use.',
  },
};

export const SOCIAL_SURFACE_IDS = Object.keys(SOCIAL_SURFACES) as SocialSurfaceId[];
